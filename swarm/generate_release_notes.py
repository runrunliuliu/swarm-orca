"""Generate release notes from the PR merges on the mainline.

Why generated rather than hand-written: the facts a changelog would state already exist three
times — commit bodies that carry the change and its boundary, design documents that hold their own
status, and the deployment records (private) that know which artifact is actually serving. A
hand-written note is therefore a fourth copy of the same facts and the only one nothing re-derives,
so it is the one that goes stale first. This script derives the note from git, and `--check` fails
when the file and the history disagree, the same contract `generate_orientation.py` uses.

What it deliberately does not claim:

- `deployed` or `verified`. Which build a host serves depends on a build and a restart that git
  cannot see, so every entry's status is `merged`; the deployment facts stay with the private
  deployment record and are tied back by the build id.
- an artifact impact. The `orcad` server bundle and the renderer are one repository but different
  artifacts: a renderer-only PR was rebuilt to a byte-identical server artifact (measured
  2026-11-20, `942f41d9`), so a note says `需构建比对` for any non-renderer change under `orca/`
  and `不进` only when there is none.
- a PR title. A GitHub merge commit records the number and the branch, not the title, so the
  headline here is the subject of the PR's own newest commit and the row lists the rest verbatim.

Usage:

    python3 -B generate_release_notes.py --range <from>..<to>            # print
    python3 -B generate_release_notes.py --range <from>..<to> --write    # write the default path
    python3 -B generate_release_notes.py --check                         # every committed note

Exit codes: 0 ok, 1 a git command failed, 2 usage error or drift.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NOTES_DIR = ROOT / "docs" / "release-notes"

# Ordered: the order is what a reader sees in the layer cell, so it must not depend on path order
# inside a diff.
LAYERS = ("orca", "renderer", "swarm", "repo")
LAYER_LABELS = {
    "orca": "orca",
    "renderer": "renderer",
    "swarm": "swarm",
    "repo": "repo",
}

# Printed once under the overview table instead of repeated in every row.
LAYER_LEGEND = (
    "层：`orca` = 服务端 / 主进程与共享代码；`renderer` = 客户端渲染层；"
    "`swarm` = 脚本 / 文档 / 技能；`repo` = 仓库根文件。"
    "`需构建比对` 表示该 PR 动了 `orca/` 的非 renderer 路径，是否进 orcad 构件只有构建能回答；"
    "`不进` 表示没有这类改动（renderer-only 曾被实测重建出逐字节相同的服务构件）。"
)

# A PR with more commits than this prints the newest ones and says how many it did not print. The
# count and the range are printed either way, so nothing is silently missing.
MAX_COMMITS_SHOWN = 10

PR_SUBJECT = re.compile(r"^Merge pull request #(\d+) from ([^\s]+)/(\S+)$")
RANGE_LINE = re.compile(r"^- range: `([^`]+)`$")
DATE_LINE = re.compile(r"^- date: `([^`]+)`$")


def git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, timeout=120
    )
    if completed.returncode != 0:
        raise SystemExit(
            f"git {' '.join(args)} failed ({completed.returncode}): {completed.stderr.strip()}"
        )
    return completed.stdout


def repo_root(start: Path) -> Path:
    return Path(git(start, "rev-parse", "--show-toplevel").strip())


def short_sha(root: Path, rev: str) -> str:
    return git(root, "rev-parse", "--short=12", rev).strip()


def commit_date(root: Path, rev: str) -> str:
    return git(root, "show", "-s", "--format=%cs", rev).strip()


def split_range(spec: str) -> tuple[str, str]:
    """`<from>..<to>`, or a usage error — never an empty note that reads as "nothing landed"."""
    start, _, end = spec.partition("..")
    if not start or not end:
        print(f"range must be <from>..<to>, got {spec!r}", file=sys.stderr)
        raise SystemExit(2)
    return start, end


def layer_of(path: str) -> str:
    if path.startswith("orca/src/renderer/"):
        return "renderer"
    if path.startswith("orca/"):
        return "orca"
    if path.startswith("swarm/"):
        return "swarm"
    return "repo"


def artifact_verdict(layers: list[str]) -> str:
    """Does the PR affect the orcad server artifact? Only a build can answer yes; only this answers no.

    Why conservative: saying `不进` wrongly tells an operator a rebuild is unnecessary, and the
    renderer is the one subtree measured to rebuild byte-identically. Everything else under `orca/`
    is left as `需构建比对` because the bundle boundary is a build detail, not a path rule.
    """
    if not layers:
        return "无改动"
    return "需构建比对" if "orca" in layers else "不进"


def pr_merges(root: Path, start: str, end: str) -> tuple[list[dict], int]:
    """Mainline PR merges in the range, newest first, plus the number of non-PR merges skipped."""
    out = git(
        root,
        "log",
        "--first-parent",
        "--merges",
        "--format=%H%x1f%P%x1f%s",
        f"{start}..{end}",
    )
    prs: list[dict] = []
    skipped = 0
    for line in out.splitlines():
        if not line.strip():
            continue
        sha, parents, subject = line.split("\x1f")
        match = PR_SUBJECT.match(subject.strip())
        if not match:
            # `Merge remote-tracking branch 'origin/main' …` and similar: a mainline merge that is
            # not a PR. Counted in the header rather than dropped silently.
            skipped += 1
            continue
        parent_list = parents.split()
        if len(parent_list) != 2:
            skipped += 1
            continue
        prs.append(
            {
                "number": int(match.group(1)),
                "owner": match.group(2),
                "branch": match.group(3),
                "merge": sha,
                "commits": pr_commits(root, sha),
                "paths": git(root, "diff", "--name-only", f"{sha}^1", f"{sha}^2").splitlines(),
            }
        )
    return prs, skipped


def pr_commits(root: Path, merge: str) -> list[tuple[str, str]]:
    out = git(
        root,
        "log",
        "--first-parent",
        "--no-merges",
        "--reverse",
        "--format=%h%x1f%s",
        f"{merge}^1..{merge}^2",
    )
    commits: list[tuple[str, str]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        sha, subject = line.split("\x1f")
        commits.append((sha, subject.strip()))
    return commits


def headline(pr: dict) -> str:
    """The PR's own first commit, which is usually the change the branch was opened for.

    Why not the newest commit: a follow-up `fix(...)` subject would name the review finding rather
    than the feature, and the merge commit itself carries no title (only the number and branch).
    """
    return pr["commits"][0][1] if pr["commits"] else f"PR #{pr['number']}"


def cell(text: str) -> str:
    """A markdown table cell: a `|` in a commit subject would otherwise split the row."""
    return text.replace("|", "\\|")


def render(root: Path, spec: str, date: str | None = None) -> str:
    start, end = split_range(spec)
    prs, skipped = pr_merges(root, start, end)
    note_date = date or commit_date(root, end)
    days = git(root, "log", "--first-parent", "--merges", "--format=%h", f"{start}..{end}").split()

    lines = [
        f"# 发布说明 {note_date}（{len(prs)} 个 PR）",
        "",
        f"- range: `{spec}`",
        f"- date: `{note_date}`",
        f"- 生成: `python3 -B generate_release_notes.py --range {spec} --write`"
        f"（`--check` 校验本文件与历史一致）",
        f"- 来源: `git log --first-parent --merges`，即合并进 main 的分支合并；"
        f"本区间 {len(days)} 条主线合并中，{len(prs)} 条是 PR，{skipped} 条非 PR 合并未生成条目。",
        "",
        "状态词只有 `merged`：它们证明代码已进 main，不证明已部署或已验收。"
        "`deployed <buildId>` 与 `verified` 属于部署方的私有记录，本文件不推断。",
        "",
        "## 一览",
        "",
        "| PR | 标题 | 层 | 服务构件（orcad） |",
        "| --- | --- | --- | --- |",
    ]
    for pr in prs:
        layers = [name for name in LAYERS if name in {layer_of(p) for p in pr["paths"]}]
        lines.append(
            f"| #{pr['number']} | {cell(headline(pr))} | "
            f"{'、'.join(LAYER_LABELS[name] for name in layers) or '—'} | "
            f"{artifact_verdict(layers)} |"
        )
    lines.extend(["", LAYER_LEGEND, "", "## 明细", ""])

    if not prs:
        lines.extend([f"本区间没有合并进 main 的 PR。", ""])
    for pr in prs:
        layers = [name for name in LAYERS if name in {layer_of(p) for p in pr["paths"]}]
        lines.extend(
            [
                f"### PR #{pr['number']} · `{short_sha(root, pr['merge'])}` · {headline(pr)}",
                "",
                f"- 分支：`{pr['owner']}/{pr['branch']}`",
                f"- 层：{'、'.join(LAYER_LABELS[name] for name in layers) or '—'}"
                f"（{len(pr['paths'])} 个文件）",
                f"- 服务构件：`{artifact_verdict(layers)}`",
                f"- 状态：`merged`",
            ]
        )
        shown = pr["commits"][-MAX_COMMITS_SHOWN:]
        if shown:
            lines.append(f"- 提交（{len(pr['commits'])}）：")
            for sha, subject in shown:
                lines.append(f"  - `{sha}` {cell(subject)}")
            if len(pr["commits"]) > len(shown):
                lines.append(
                    f"  - …另有 {len(pr['commits']) - len(shown)} 条，见 "
                    f"`git log {pr['merge']}^1..{pr['merge']}^2`"
                )
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def default_path(root: Path, spec: str) -> Path:
    _, end = split_range(spec)
    return NOTES_DIR / f"{commit_date(root, end)}-{short_sha(root, end)}.md"


def declared_range(text: str) -> str | None:
    """The range a committed note claims to describe, so `--check` re-derives instead of trusting."""
    for line in text.splitlines():
        match = RANGE_LINE.match(line)
        if match:
            return match.group(1)
        if line.startswith("## "):
            break
    return None


def declared_date(text: str) -> str | None:
    for line in text.splitlines():
        match = DATE_LINE.match(line)
        if match:
            return match.group(1)
        if line.startswith("## "):
            break
    return None


def check(root: Path, path: Path) -> bool:
    if not path.exists():
        print(f"{path}: missing", file=sys.stderr)
        return False
    text = path.read_text(encoding="utf-8")
    spec = declared_range(text)
    if spec is None:
        print(f"{path}: no `- range:` line to re-derive from", file=sys.stderr)
        return False
    expected = render(root, spec, declared_date(text))
    if expected != text:
        print(
            f"{path}: stale; regenerate with:\n"
            f"  python3 -B generate_release_notes.py --range {spec} --write --out {path}",
            file=sys.stderr,
        )
        return False
    print(f"{path}: matches {spec}")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--range", dest="spec", help="<from>..<to>, e.g. c692b58d..ba78a850")
    parser.add_argument("--date", help="note date; defaults to the committer date of <to>")
    parser.add_argument("--write", action="store_true", help="write the note instead of printing it")
    parser.add_argument("--out", help="path to write, or the single file to check")
    parser.add_argument("--check", action="store_true", help="verify committed notes against git")
    parser.add_argument("--repo", default=str(ROOT), help="path inside the repository to inspect")
    args = parser.parse_args(argv)
    root = repo_root(Path(args.repo))

    if args.check:
        targets = [Path(args.out)] if args.out else sorted(NOTES_DIR.glob("*.md"))
        targets = [path for path in targets if path.name != "README.md"]
        if not targets:
            print("no release notes to check", file=sys.stderr)
            return 2
        return 0 if all(check(root, path) for path in targets) else 2

    if not args.spec:
        parser.error("--range is required unless --check is given")
    text = render(root, args.spec, args.date)
    if args.write:
        target = Path(args.out) if args.out else default_path(root, args.spec)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        print(f"wrote {target}")
        return 0
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
