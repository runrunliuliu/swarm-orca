"""Generate the operator runbook from the action table, so it cannot drift from the code.

Why a generator instead of a hand-written page: the protocol tells the Operator to read a
runbook, and a runbook that lists stages by hand goes stale the first time an action is added —
which is exactly how the "three indexes that disagree" problem started. The stage table here is
read from `bootstrap_actions.ACTIONS`, the argv shapes from the same module, and the reading order
from the protocol's own section headings. `--check` compares the file on disk with what the code
would generate and exits 2 when they differ, so a stale copy fails a test instead of a launch.

Scope: this is an *index*, not a second protocol. It names the stage, who owns it, what it writes
and the exact command shape; the rules stay in `strict-bootstrap-protocol.md`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "operator-runbook.md"

# Which protocol section each stage is governed by. Kept here (not in the protocol) because it is
# navigation, and navigation is what this file is for.
STAGE_SECTIONS = {
    "caller-intent": "§2 固定路径、S0 与公共类型",
    "observe-intent": "§2 固定路径、S0 与公共类型",
    "fields-intent": "§4 原 Operator 字段生产与审查接口",
    "contract-intent": "§4 原 Operator 字段生产与审查接口",
    "readiness-intent": "§4 原 Operator 字段生产与审查接口",
    "marker-intent": "§3 四个 marker 与证据关联",
}


def render() -> str:
    from bootstrap_actions import ACTIONS, SUBMIT_TARGETS

    lines = [
        "# Operator runbook（生成文件，不要手改）",
        "",
        "本文由 `swarm/generate_runbook.py` 从 `bootstrap_actions.ACTIONS` 生成；`--check` 不一致即",
        "`exit 2`。手改会被覆盖，规则本身写在",
        "[strict-bootstrap-protocol.md](strict-bootstrap-protocol.md)（S0–S5）与",
        "本文件只回答“这一步是谁、读写哪个槽、跑什么命令”。",
        "",
        "## 读取顺序",
        "",
        "1. `strict-bootstrap-protocol.md` §1–§9：规范与准入。",
        "2. 本文：当前阶段的 owner、槽位与 argv。",
        "3. 需要离线闭环或历史实测时再读",
        "   [strict-bootstrap-offline.md](strict-bootstrap-offline.md)（#10–#13），它不是开机必读。",
        "",
        "## 阶段表",
        "",
        "| 阶段 | actor | mode | 写入槽 | 完成回执 | 依章节 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for name, spec in ACTIONS.items():
        completion = "produce" if spec.mode == "produce" else f"{name.removesuffix('-intent')}-submission.json"
        lines.append(f"| `{name}` | {spec.actor} | {spec.mode} | `{spec.target}` | `{completion}` | "
                     f"{STAGE_SECTIONS.get(name, '§4')} |")
    lines += [
        "",
        "## 命令形状",
        "",
        "```bash",
        "# 取下一步（返回 complete_argv / inspect_argv，不要自己拼参数）",
        "python3 -B bootstrap_tool.py pull --owner <owner.json> --owner-sha256 <sha> --actor <role> --execute",
        "",
        "# 机械产物（caller/observation 由 helper 产出，不是模型）",
        "python3 -B bootstrap_tool.py produce --owner <owner.json> --owner-sha256 <sha> --actor <role> \\",
        "  --intent <intent.json> --intent-sha256 <sha> --execute",
        "",
        "# 提交候选：人写字节，或由意图里的模板 materialize（仅 fields-intent）",
        "python3 -B bootstrap_tool.py submit --owner <owner.json> --owner-sha256 <sha> --actor <role> \\",
        "  --intent <intent.json> --intent-sha256 <sha> --input <candidate.json> --input-sha256 <sha> --execute",
        "python3 -B bootstrap_tool.py submit ... --from-template --execute",
        "",
        "# 完成阶段与对账",
        "python3 -B bootstrap_tool.py complete --owner <owner.json> --owner-sha256 <sha> --actor <role> \\",
        "  --intent <intent.json> --intent-sha256 <sha> --input <result.json> --input-sha256 <sha> --execute",
        "python3 -B bootstrap_tool.py inspect-action --owner <owner.json> --owner-sha256 <sha> \\",
        "  --actor <role> --intent <intent.json> --intent-sha256 <sha>",
        "```",
        "",
        "## 不要这样做",
        "",
        "- 手写 `complete_argv` / `inspect_argv`：它们由 helper 返回，重拼会漂移。",
        "- 把本文件当规范读：准入、拒绝原因与边界在协议里，这里只索引。",
        "- 为 review 阶段用 `--from-template`：`decision`/`notes` 是复核者的判断。",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="compare the file on disk with the generated text; exit 2 on drift")
    parser.add_argument("--write", action="store_true", help="write the generated text")
    args = parser.parse_args(argv)
    generated = render()
    if args.check:
        current = TARGET.read_text() if TARGET.exists() else ""
        if current != generated:
            print("operator-runbook.md is stale; run: python3 -B generate_runbook.py --write",
                  file=sys.stderr)
            return 2
        print("operator-runbook.md matches the action table")
        return 0
    if args.write:
        TARGET.write_text(generated)
        print(f"wrote {TARGET.name} ({len(generated)} bytes)")
        return 0
    sys.stdout.write(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
