"""Run one bounded search from inside a worktree, and report what it cost.

Why a helper instead of a documented `rg` line: the rule this exists for - "search inside your own
worktree, never above it" - is only followed if the fast form is one command with no flags to
remember. The measured difference on this host's NFS workspace mount is not subtle: a recursive
walk of the workspace root did not return in 25 s, while one checkout answered in 0.07-0.26 s
(warm caches) over the same mount.

What it enforces: the target must pass `search_guard.evaluate()` (so a path above the worktree, or
a workspace root holding several checkouts, is refused with the same message the agent-runtime hook
gives), `git grep` is used when the target is a checkout (tracked files only, indexed), `rg` gets
`node_modules`/`.git` excluded, and the elapsed time goes to stderr so a brief can require a number
instead of an impression.

What it does not do: it does not shorten the search - `--max-depth` is a default, not a truncation
policy - and it grants nothing. The result is the search's own output and exit code.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time

import search_guard as guard

EXIT_OK = 0
EXIT_PRECONDITION = 78
EXIT_UNAVAILABLE = 127

# The documented in-worktree bound (search_guard.SUGGESTED_DEPTH is the one quoted for a search of
# the workspace root): deep enough for `orca/src/main/runtime/...`, cheap enough to stay one turn.
DEFAULT_DEPTH = 6
EXCLUDES = ("!node_modules", "!.git")


def worktree(cwd, root=None):
    return os.path.realpath(root) if root else guard.worktree_root(os.path.realpath(cwd))


def build_argv(pattern, path, globs, mode, depth, root):
    """The exact argv for one search; `--dry-run` prints this instead of running it."""
    if mode == "git":
        relative = os.path.relpath(path, root)
        argv = ["git", "-C", root, "grep", "-n", "-I", "--no-color", pattern, "--"]
        argv.append(relative if relative != "." else ".")
        argv.extend(globs)
        return argv
    argv = ["rg", "-n", "--max-depth", str(depth)]
    for exclude in EXCLUDES:
        argv.extend(["-g", exclude])
    for glob in globs:
        argv.extend(["-g", glob])
    argv.extend([pattern, path])
    return argv


def scope_refusal(path, cwd, root):
    """The guard's verdict on walking `path`; the same one the agent-runtime hook reports."""
    verdict = guard.evaluate(shlex.join(["rg", "PATTERN", path]), cwd, root)
    return verdict if verdict["decision"] == guard.DENY else None


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Search one worktree, with the scope rule and the exclusions already applied.")
    parser.add_argument("pattern")
    parser.add_argument("--path", default=".", help="target directory (default: the worktree)")
    parser.add_argument("--glob", action="append", default=[], help="extra path glob, repeatable")
    parser.add_argument("--mode", choices=("auto", "git", "rg"), default="auto")
    parser.add_argument("--max-depth", type=int, default=DEFAULT_DEPTH, help="rg traversal depth")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--root", default=None, help="worktree boundary (default: git top level)")
    parser.add_argument("--dry-run", action="store_true", help="print the argv, run nothing")
    args = parser.parse_args(argv)

    cwd = os.path.realpath(args.cwd)
    if not os.path.isdir(cwd):
        print(f"fast_search: --cwd is not a directory: {cwd}", file=sys.stderr)
        return EXIT_PRECONDITION
    root = worktree(cwd, args.root)
    path = os.path.realpath(os.path.join(cwd, os.path.expanduser(args.path)))
    refusal = scope_refusal(path, cwd, root)
    if refusal is not None:
        print(guard.explain(refusal), file=sys.stderr)
        return EXIT_PRECONDITION
    if not os.path.exists(path):
        print(f"fast_search: no such path: {path}", file=sys.stderr)
        return EXIT_PRECONDITION

    mode = args.mode
    if mode == "auto":
        # `git grep` reads the index, so it applies when the target is a checkout itself; anything
        # else (a subdirectory that is not its own repository) goes to `rg` with exclusions.
        mode = "git" if guard.is_checkout(path) else "rg"
    program = "git" if mode == "git" else "rg"
    if not args.dry_run and not shutil.which(program):
        print(f"fast_search: {program} is not on PATH", file=sys.stderr)
        return EXIT_UNAVAILABLE
    command = build_argv(args.pattern, path, args.glob, mode, args.max_depth, root)
    if args.dry_run:
        print(shlex.join(command))
        return EXIT_OK

    started = time.monotonic()
    done = subprocess.run(command, capture_output=True, text=True)
    elapsed = time.monotonic() - started
    hits = len(done.stdout.splitlines())
    if done.stdout:
        sys.stdout.write(done.stdout)
    if done.stderr:
        sys.stderr.write(done.stderr)
    print(f"fast_search: {program} {hits} hit(s) in {elapsed:.2f} s", file=sys.stderr)
    return done.returncode


if __name__ == "__main__":
    sys.exit(main())
