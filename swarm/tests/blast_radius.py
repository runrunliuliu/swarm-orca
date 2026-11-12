"""Turn a diff into the offline modules that can be affected by it.

Why this exists: `tests/run_offline.sh` with no arguments is the only call shape that needs no
thought, so it became the default even when a change touches two files (95 such runs in one
measured session). The missing piece was never speed, it was a cheap and defensible answer to
"which modules does this diff touch?" — so the answer is a command, not a model re-deriving it
with grep.

The radius is deliberately fixed, because three plausible readings of "callers" differ by an
order of magnitude on this tree: `coordinator_launch` has 3 source importers, 18 test importers
and 82 modules in its transitive closure. Escalating silently would make the numbers
unfalsifiable, so only these count:

  (a)  same basename:   `swarm/<m>.py` -> `tests/<area>/test_<m>.py`
  (b)  test imports it: a test module that imports `m` directly
  (b2) one hop back:    a `swarm/*.py` module importing `m`, then that module's (a)+(b)
  (c)  policy:          SHARED_MAP says the radius is wider than any import scan shows
  (d)  test helper:     a changed file under `swarm/tests/` -> the test modules importing it

(d) exists because a shared fixture is neither a source nor a test module: editing one selected
nothing at all, and the command's only escape was a hand-widened run — the unrepeatable
judgement this tool replaces. It is one hop, like (b), not the closure.

The transitive closure is excluded on purpose: it is nearly the whole suite, which would turn
every change into a full run — the behaviour this replaces.

Standard library only, like the rest of this directory. Known blind spot: dynamic imports and
subprocess argv (`python3 <module>.py`) are invisible to an AST scan. That is why an empty
radius is a failure rather than a pass, and why `run_blast.sh --help` states it.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Policy, not measurement. Both modules are imported so widely that an import scan understates
# what a change can break, so the wider radius is stated as data instead of inferred. Narrowing
# either is a review decision; `test_offline_baseline.py` asserts the policy still covers what
# the tree imports, so a policy that stops covering the tree fails instead of passing quietly.
SHARED_MAP: dict[str, tuple[str, ...]] = {
    "coordinator_io": ("*",),
    "blocking_io": ("core.*", "bootstrap.*", "operators.*"),
}

# Source modules that no test module reaches. Empty today: the radius above reaches every tool
# module. An entry is a reviewed statement that a module is untested, never a shortcut.
UNTESTED: dict[str, str] = {}

# Changes to the runner itself are not module-level: they change how every module is selected
# and reported, so the radius is the whole suite (`*`) or, for the selector only, the test that
# pins the selector's behaviour.
RUNNER_PATHS: dict[str, tuple[str, ...]] = {
    "run_offline.sh": ("*",),
    "run_blast.sh": ("*",),
    "run_modules.py": ("*",),
    "blast_radius.py": ("core.test_offline_baseline",),
}


def module_names() -> list[str]:
    """The dotted names `tests/run_offline.sh --list` prints, derived the same way."""
    names: list[str] = []
    for path in sorted(list(ROOT.glob("tests/test*.py")) + list(ROOT.glob("tests/*/test*.py"))):
        area = path.parent.name
        names.append(path.stem if area == "tests" else f"{area}.{path.stem}")
    return names


def imported_modules(path: Path) -> set[str]:
    """Top-level module names a file imports at any depth. Dynamic imports stay invisible."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError:
        return set()
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def source_files() -> dict[str, Path]:
    """Top-level modules *and* packages: `swarm_ledger/` is a package whose tests import it."""
    files = {path.stem: path for path in sorted(ROOT.glob("*.py"))
             if path.name != "run_modules.py"}
    for package in sorted(ROOT.glob("*/")):
        if package.name in {"tests", "docs", "examples", "field-guide", "skills", "runit"}:
            continue
        if (package / "__init__.py").exists():
            files[package.name] = package
    return files


def policy_matches(name: str, patterns: tuple[str, ...]) -> bool:
    for pattern in patterns:
        if pattern == "*" or pattern == name:
            return True
        if pattern.endswith(".*") and name.startswith(pattern[:-1]):
            return True
    return False


class Radius:
    def __init__(self) -> None:
        self.sources = source_files()
        self.tests: dict[str, Path] = {}
        for path in sorted(list(ROOT.glob("tests/test*.py")) + list(ROOT.glob("tests/*/test*.py"))):
            area = path.parent.name
            self.tests[path.stem if area == "tests" else f"{area}.{path.stem}"] = path
        self.available = set(module_names())
        self.test_imports = {name: {imported.split(".")[-1] for imported in imported_modules(path)}
                             for name, path in self.tests.items()}
        # A package's own imports are its `__init__.py`: reading the directory is not a file.
        self.source_imports = {
            name: {imported.split(".")[-1] for imported in
                   imported_modules(path if path.is_file() else path / "__init__.py")}
            for name, path in self.sources.items()}
        self.same_basename: dict[str, str] = {}
        for test_name, path in self.tests.items():
            base = path.stem[len("test_"):]
            if base in self.sources:
                self.same_basename[base] = test_name
        self.importers: dict[str, set[str]] = {}
        for module, imports in self.source_imports.items():
            for imported in imports:
                if imported in self.sources:
                    self.importers.setdefault(imported, set()).add(module)

    def tests_for_source(self, module: str) -> dict[str, str]:
        """Selected test modules, keyed by the reason they are in the radius."""
        reasons: dict[str, str] = {}
        pair = self.same_basename.get(module)
        if pair:
            reasons[pair] = "a"
        for test_name, imports in self.test_imports.items():
            if module in imports:
                reasons.setdefault(test_name, "b")
        for importer in self.importers.get(module, set()):
            pair = self.same_basename.get(importer)
            if pair:
                reasons.setdefault(pair, "b2")
            for test_name, imports in self.test_imports.items():
                if importer in imports:
                    reasons.setdefault(test_name, "b2")
        for shared, patterns in SHARED_MAP.items():
            if module == shared:
                for name in self.available:
                    if policy_matches(name, patterns):
                        reasons.setdefault(name, "c")
        return reasons

    def tests_for_helper(self, path: Path) -> dict[str, str]:
        """A changed helper under `tests/` selects the test modules that import it by name.

        Why: `tests/offline_env.py` and the `*_fixture.py` files are neither source modules nor
        test modules, so before this they mapped to nothing and the command failed closed. It is
        one hop, because a helper's importers are the modules that can actually be affected.
        """
        return {test_name: "helper" for test_name, imports in self.test_imports.items()
                if path.stem in imports}

    def tests_for_test(self, module: str) -> dict[str, str]:
        """A test change selects itself and the same-basename tests of what it imports.

        Why not the full source radius here: every test file imports `coordinator_io`, so reusing
        `tests_for_source` would turn any test edit into three quarters of the suite — the very
        widening this tool exists to replace.
        """
        reasons: dict[str, str] = {module: "self"} if module in self.available else {}
        for imported in self.test_imports.get(module, set()):
            pair = self.same_basename.get(imported)
            if pair:
                reasons.setdefault(pair, "a")
        return reasons


def changed_paths(range_spec: str) -> list[str]:
    completed = subprocess.run(["git", "diff", "--name-only", range_spec],
                               cwd=ROOT.parent, capture_output=True, text=True)
    if completed.returncode != 0:
        raise SystemExit(f"git diff --name-only {range_spec} failed: {completed.stderr.strip()}")
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def select(range_spec: str) -> tuple[dict[str, dict[str, str]], list[str], list[str]]:
    """Return (change -> {module: reason}, skipped changes, unmapped changes)."""
    radius = Radius()
    selection: dict[str, dict[str, str]] = {}
    skipped: list[str] = []
    unmapped: list[str] = []
    for change in changed_paths(range_spec):
        path = Path(change)
        name = path.stem
        if str(path).startswith("swarm/tests/") and path.name.startswith("test_") and path.suffix == ".py":
            area = path.parent.name
            reasons = radius.tests_for_test(f"{area}.{name}" if area != "tests" else name)
        elif str(path).startswith("swarm/tests/") and path.name in RUNNER_PATHS:
            patterns = RUNNER_PATHS[path.name]
            reasons = {module: "runner" for module in radius.available
                       if policy_matches(module, patterns)}
        elif str(path).startswith("swarm/tests/"):
            reasons = radius.tests_for_helper(path)
        elif str(path).startswith("swarm/") and path.suffix == ".py" and name in radius.sources:
            reasons = radius.tests_for_source(name)
        elif str(path).startswith("swarm/") and path.suffix == ".py":
            package = path.parent.name
            reasons = radius.tests_for_source(package) if package in radius.sources else {}
        else:
            skipped.append(change)
            continue
        if reasons:
            selection[change] = reasons
        elif name in UNTESTED:
            skipped.append(change)
        else:
            unmapped.append(change)
    return selection, skipped, unmapped


def describe(reasons: dict[str, str], total: int) -> str:
    """One line per changed file, collapsed when the radius is most of the suite."""
    if len(reasons) > 12:
        by_reason: dict[str, int] = {}
        for reason in reasons.values():
            by_reason[reason] = by_reason.get(reason, 0) + 1
        detail = ", ".join(f"{count} x {reason}" for reason, count in sorted(by_reason.items()))
        return f"{len(reasons)}/{total} modules ({detail}); --json for the names"
    return ", ".join(f"{module} ({reason})" for module, reason in sorted(reasons.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--range", required=True, dest="range_spec",
                        help="a revision or range passed to `git diff --name-only`")
    parser.add_argument("--json", action="store_true", help="print only the machine-readable result")
    args = parser.parse_args(argv)

    if not changed_paths(args.range_spec):
        print(f"selection: 0/0 modules — nothing changed in {args.range_spec}", file=sys.stderr)
        return 2
    selection, skipped, unmapped = select(args.range_spec)
    modules = sorted({module for reasons in selection.values() for module in reasons})
    total = len(module_names())
    if args.json:
        # Human lines go to stderr so the wrapper can capture stdout as one JSON object; without
        # that split it would have to run the scan twice and could report a different selection.
        for change, reasons in selection.items():
            print(f"selection: {change} -> {describe(reasons, total)}", file=sys.stderr)
        for change in skipped:
            print(f"selection: {change} -> skipped (not a scanned source or test module)",
                  file=sys.stderr)
        print(f"selection: {len(modules)}/{total} modules", file=sys.stderr)
        print(json.dumps({"modules": modules, "unmapped": unmapped, "skipped": skipped}))
        if unmapped:
            for change in unmapped:
                print(f"run_blast.sh: no test module reaches {change}; add one, or record it in "
                      f"UNTESTED", file=sys.stderr)
            return 2
        return 2 if not modules else 0
    for change, reasons in selection.items():
        print(f"selection: {change} -> {describe(reasons, total)}")
    for change in skipped:
        print(f"selection: {change} -> skipped (not a scanned source or test module)")
    print(f"selection: {len(modules)}/{total} modules")
    if unmapped:
        for change in unmapped:
            print(f"run_blast.sh: no test module reaches {change}; add one, or record it in UNTESTED",
                  file=sys.stderr)
        return 2
    if not modules:
        print(f"selection: 0 modules — nothing in {args.range_spec} maps to a test module",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
