"""ORIENTATION.md is an index of positions, so the only thing that matters is that it is true.

A stale index is worse than none: a wrong line range sends the reader to unrelated code and
removes the reason to search. These assertions therefore re-derive every row from the sources
instead of trusting the file: the symbol must start exactly at the line the row claims.
"""

import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "ORIENTATION.md"


class OrientationTests(unittest.TestCase):
    def run_generator(self, *args):
        return subprocess.run([sys.executable, "-B", str(ROOT / "generate_orientation.py"), *args],
                              cwd=ROOT, capture_output=True, text=True, timeout=120)

    def rows(self):
        rows = []
        for line in TARGET.read_text().splitlines():
            if not line.startswith("| `"):
                continue
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            symbol = cells[0].strip("`")
            file, span = cells[1].strip("`").split(":")
            start, end = (int(part) for part in span.split("-"))
            rows.append((symbol, file, start, end))
        return rows

    def test_the_committed_index_matches_the_sources(self):
        completed = self.run_generator("--check")
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_every_row_points_at_the_definition_it_names(self):
        # Why re-derive: this is the assertion that makes the index trustworthy. A row is either
        # exactly right or the test fails; there is no "close enough" for a line number.
        cache = {}
        for symbol, file, start, end in self.rows():
            self.assertTrue((ROOT / file).exists(), f"{file} does not exist")
            if file not in cache:
                cache[file] = ast.parse((ROOT / file).read_text())
            found = [
                node for node in ast.walk(cache[file])
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == symbol
                # The row may start at the first decorator, which is part of what the symbol means.
                and start == min([dec.lineno for dec in node.decorator_list] + [node.lineno])
            ]
            self.assertTrue(found, f"{symbol} does not start at {file}:{start}")
            self.assertGreaterEqual(end, start)

    def test_every_indexed_symbol_is_named_by_a_source_document(self):
        # Why this direction: an invented row is worse than a missing one, because it sends the
        # reader to a line range that exists but has nothing to do with the name.
        from generate_orientation import SOURCES_OF_TRUTH
        docs = "\n".join((ROOT / name).read_text() for name in SOURCES_OF_TRUTH)
        for symbol, _, _, _ in self.rows():
            self.assertRegex(docs, r"\b" + symbol + r"\b")

    def test_the_index_keeps_the_symbols_the_docs_point_at(self):
        text = TARGET.read_text()
        for symbol in ("contract_fields", "strict_plan", "build_plan"):
            self.assertIn(f"`{symbol}`", text)

    def test_the_index_carries_no_absolute_path(self):
        text = TARGET.read_text()
        self.assertNotIn("/mnt/", text)
        self.assertNotIn("/home/", text)

    def test_a_stale_index_is_refused_not_warned(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ORIENTATION.md"
            path.write_text(TARGET.read_text().replace("1-", "999-", 1))
            completed = self.run_generator("--check", "--path", str(path))
            self.assertEqual(completed.returncode, 2)
            self.assertIn("stale", completed.stderr)

    def test_the_lookup_rule_survives_in_every_place_the_reader_meets_it(self):
        """A generated index nobody is told to consult earns nothing; measure it, then pin it."""
        for path, phrase in ((ROOT.parent / "AGENTS.md", "look a name up there first"),
                             (ROOT / "strict-bootstrap-protocol.md", "只有表里没有条目时才用 grep"),
                             (ROOT / "coordinator_strict.py", "look a name up here before searching")):
            with self.subTest(path=path.name):
                # Whitespace is flattened: these are wrapped paragraphs, not single lines.
                flat = " ".join(path.read_text(encoding="utf-8").split()).lower()
                self.assertIn(phrase, flat)

    def test_the_index_does_not_copy_code_bodies(self):
        # Why: a body copy is a second source of truth. The file may name symbols and ranges only.
        text = TARGET.read_text()
        self.assertNotIn("    def ", text)
        self.assertNotIn("    return ", text)


if __name__ == "__main__":
    unittest.main()
