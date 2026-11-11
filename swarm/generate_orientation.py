"""Generate ORIENTATION.md: where the symbols the protocol names actually live.

Why: a session that starts by reading the protocol then has to *find* the things it names. The
measured pane spent 23 symbol searches and 39 turns before its first real action, and 56% of path
references were redundant re-derivations of the same location. A generated index answers
"file:line" in one read instead of six searches.

What this deliberately is not: a copy of the code, or a full symbol dump. It indexes only the
top-level definitions and methods whose names appear in the protocol documents, and it stores a
line range plus the anchor that produced it. Copying bodies would create a second source of truth
that goes stale between releases; a line range can be verified, so `--check` verifies it.

Why `--check` fails instead of warning: a stale index is worse than no index. A wrong line range
sends the reader to unrelated code and removes the reason to search, which is exactly the failure
this is meant to prevent.
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "ORIENTATION.md"

# The documents whose referenced symbols are worth indexing: the required reading plus the
# normative protocol. Adding more here grows the index; the cap keeps it a one-screen lookup.
SOURCES_OF_TRUTH = (
    "strict-bootstrap-protocol.md",
    "coordinator-strict-start.md",
    "operator-prepare.md",
)


def _record(index: dict[str, list[tuple[str, int, int]]], file: str, node) -> None:
    """Record a symbol's range, starting at its first decorator when it has one.

    Why the decorator is inside the range: `@protect(...)` / `@dataclass(...)` change what the
    symbol means, and a reader who follows only the `def` line misses the line that says so.
    """
    start = min([dec.lineno for dec in getattr(node, "decorator_list", [])] + [node.lineno])
    index.setdefault(node.name, []).append((file, start, node.end_lineno or node.lineno))


def defined_symbols() -> dict[str, list[tuple[str, int, int]]]:
    """symbol -> [(file, first_line, last_line)] for top-level defs/classes and their methods."""
    index: dict[str, list[tuple[str, int, int]]] = {}
    for path in sorted(ROOT.glob("*.py")):
        if path.name in {"run_modules.py"}:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                _record(index, path.name, node)
                if isinstance(node, ast.ClassDef):
                    for child in node.body:
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            _record(index, path.name, child)
    return index


def named_in_docs(index: dict[str, list[tuple[str, int, int]]]) -> list[str]:
    """Symbols the documents point at as code, not words that happen to be prose.

    Why not a plain word match: `main`, `check`, `stop`, `run`, `read`, `text` and `path` are both
    function names and ordinary English, and matching them produced 280 rows of noise that defeated
    the point of a one-screen lookup. A symbol qualifies when it is inside backticks, or when its
    shape is unambiguously code (contains `_`, or is CamelCase). Dunders never qualify.
    """
    text = "\n".join((ROOT / name).read_text(encoding="utf-8")
                     for name in SOURCES_OF_TRUTH if (ROOT / name).exists())
    # Every identifier that appears inside a backticked span, so `bootstrap_protocol.layout(...)`,
    # `OperatorScheduler.submit/query` and `payload.submission` all name their symbol. Matching the
    # whole span against the bare name missed every dotted reference, which is how most of the
    # protocol points at code.
    code_spans = set()
    for span in re.findall(r"`([^`]+)`", text):
        code_spans.update(token for token in re.split(r"[^A-Za-z0-9_]+", span) if token)
    # A dotted access in prose (`payload.submission`, `record.recheck`) also names a symbol, and a
    # lowercase name is otherwise excluded as an ordinary word. Only the suffix is taken, so the
    # prose word "the submission" still does not qualify.
    code_spans.update(name for name in re.findall(r"[A-Za-z_][A-Za-z0-9_]*\.([a-z_][A-Za-z0-9_]*)", text))
    chosen = []
    for name in index:
        if name.startswith("__"):
            continue
        if name in code_spans:
            chosen.append(name)
            continue
        if not (name.isupper() or "_" in name or name[:1].isupper()):
            continue
        if re.search(r"\b" + re.escape(name) + r"\b", text):
            chosen.append(name)
    return sorted(chosen)


def render() -> str:
    from bootstrap_actions import command

    index = defined_symbols()
    names = named_in_docs(index)
    owner = {"path": "<owner.json>", "sha256": "<owner-sha256>"}
    intent = {"path": "<intent.json>", "sha256": "<intent-sha256>"}
    script = str(ROOT / "coordinator_launch.py")

    lines = [
        "# ORIENTATION（生成文件，不要手改）",
        "",
        "由 `swarm/generate_orientation.py --write` 生成；`--check` 与代码不一致即 `exit 2`。",
        "只放**位置**（路径 + 行区间），不放代码：代码只有一份，索引可以验证。",
        "",
        "## 最短必读顺序",
        "",
        "1. 本文件「入口 argv」——先知道这一步跑什么。",
        "2. `strict-bootstrap-protocol.md` §1–§9：规范与准入（离线材料不在必读内）。",
        "3. `operator-runbook.md`：阶段、owner、槽位。",
        "4. 需要看实现时，用下面「符号索引」里的行区间直接读，**不要先 grep 名字**。",
        "",
        "## 入口 argv",
        "",
        "```bash",
    ]
    for mode in ("pull", "produce", "submit", "complete", "inspect-action"):
        argv = [token.replace(script, "<swarm>/coordinator_launch.py")
                for token in command(owner, "<role>", mode, intent)]
        argv[0] = "python3"
        if mode != "inspect-action" and "--execute" not in argv:
            argv.append("--execute")
        lines.append(" ".join(argv))
    lines += [
        "```",
        "",
        f"## 符号索引（{len(names)} 个：协议文档点名的顶层定义与方法）",
        "",
        "| 符号 | 位置 | 锚点 |",
        "| --- | --- | --- |",
    ]
    for name in names:
        for file, start, end in index[name]:
            lines.append(f"| `{name}` | `{file}:{start}-{end}` | `def {name}` / `class {name}` |")
    lines += [
        "",
        "## 不要这样做",
        "",
        "- 先 grep 名字再逐回合找：本表就是那次搜索的结果。",
        "- 复制本表的行区间到别处：`--check` 会因区间漂移拒绝，说明代码变了，重读对应区间。",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="compare the file on disk with the generated index; exit 2 on drift")
    parser.add_argument("--write", action="store_true", help="write the generated index")
    parser.add_argument("--path", default=str(TARGET), help="file to check or write")
    args = parser.parse_args(argv)
    generated = render()
    path = Path(args.path)
    if args.check:
        current = path.read_text() if path.exists() else ""
        if current != generated:
            print("ORIENTATION.md is stale; run: python3 -B generate_orientation.py --write",
                  file=sys.stderr)
            return 2
        print("ORIENTATION.md matches the sources it indexes")
        return 0
    if args.write:
        path.write_text(generated)
        print(f"wrote {path.name} ({len(generated)} bytes)")
        return 0
    sys.stdout.write(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
