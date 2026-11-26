"""Refuse a recursive search that would walk outside the caller's own worktree.

Why this module exists: an agent that wants "some context" turns it into a recursive search of the
*directory above* its worktree. On this host that directory is an NFS4 mount (attribute caches at
30 s) holding twenty-odd checkouts, each with its own upstream copy and `node_modules`; one such
`grep -rl` ran 28 minutes without an answer, while the fact it was looking for (its own dispatch)
was one `worker-show` call away. Discipline written in a brief does not survive a change of model,
so the verdict has to be a function of the command text and of where the caller stands.

One rule: **a recursive search is allowed only when every target it walks is inside the current
worktree** (the git top level of the working directory, or the directory itself outside a
checkout). How deep it goes, which tool it uses and what it looks for are not judged here; the
refusal names the three fast forms instead of trying to police them.

What this is not: a permission boundary. A refusal is an efficiency verdict, so this module
fail-opens - an unparseable or unreadable command is allowed rather than guessed at, and a caller
(an agent-runtime hook) may ignore the answer. It runs nothing, resolves no pattern and reads no
search result; it only reads directory entries to recognise a workspace holding several checkouts.

Contract: `evaluate()` returns a dict, never raises. The CLI prints that dict as one line of JSON
(always exit 0: a `deny` is a decision, not a failure), or a short human form with `--explain`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys

ALLOW = "allow"
DENY = "deny"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PRECONDITION = 78

# Every word here is a tool that walks a tree, so its absence is the cheap prefilter: an ordinary
# command line never reaches the parser.
RECURSIVE_TOOLS = frozenset({"grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "fdfind", "find"})
GREP_FAMILY = frozenset({"grep", "egrep", "fgrep"})

# Command words that only carry another command: the tool to judge is the word after them.
WRAPPERS = frozenset({"sudo", "doas", "env", "time", "command", "nice", "nohup", "stdbuf", "xargs",
                      "watch"})
WRAPPER_VALUE_OPTIONS = {
    "sudo": frozenset({"-u", "-g", "-p", "-C", "-U", "-h", "-T", "-r", "-t", "-D"}),
    "doas": frozenset({"-u", "-C"}),
    "env": frozenset({"-u", "-C", "-S", "--unset", "--chdir"}),
    "nice": frozenset({"-n"}),
    "stdbuf": frozenset({"-i", "-o", "-e"}),
    "xargs": frozenset({"-n", "-P", "-I", "-L", "-s", "-d", "-E", "-a"}),
    "time": frozenset({"-f", "-o"}),
    "watch": frozenset({"-n", "-d"}),
}
SHELLS = frozenset({"bash", "sh", "zsh", "dash", "ksh"})
SEPARATORS = frozenset({"|", "||", "&&", ";", "&", "\n"})

# Short options that take the next word as their value, so that word is not a search target.
SHORT_VALUE = {
    "grep": frozenset("efmABCDd"),
    "egrep": frozenset("efmABCDd"),
    "fgrep": frozenset("efmABCDd"),
    "rg": frozenset("efgtTmjABCdDrM"),
    "ag": frozenset("efmABCgt"),
    "ack": frozenset("efmABCgt"),
    "fd": frozenset("dEetjSoc"),
    "fdfind": frozenset("dEetjSoc"),
}
# The same, spelled long. Unknown long options are treated as flags: guessing "this one has a
# value" turns a value into a fake path, which is a false refusal.
LONG_VALUE = frozenset({
    "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-count",
    "--max-depth", "--max-filesize", "--replace", "--encoding", "--path-separator", "--sort",
    "--threads", "--pre", "--context", "--after-context", "--before-context", "--max-columns",
    "--include", "--exclude", "--exclude-dir", "--include-dir", "--label", "--binary-files",
    "--devices", "--directories", "--group-separator", "--field-match-separator",
    "--context-separator", "--ignore-file", "--dfa-size-limit", "--regex-size-limit",
    "--max-results", "--search-path", "--extension", "--size", "--owner", "--exec",
    "--exec-batch", "--changed-within", "--changed-before", "--base-directory",
})
# Long options after which the tool reports something instead of walking files.
REPORT_ONLY = frozenset({"--version", "--help", "--type-list", "--generate", "--pcre2-version"})
# `grep -e PAT` / `rg -f FILE` already carry the pattern, so every positional is a path.
PATTERN_OPTIONS = frozenset({"-e", "--regexp", "-f", "--file"})
# `rg --files` lists paths instead of searching, so it has no leading pattern either.
NO_PATTERN = frozenset({"--files"})

SUBSTITUTION = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
MAX_SUBSTITUTION_DEPTH = 3
# Depth is not judged (only the boundary is), so this number exists only to make the suggested
# rewrite concrete: the documented bound for a search of the workspace root.
SUGGESTED_DEPTH = 3

WORKTREE_TIMEOUT_SECONDS = 5


def _tokenize(text):
    lexer = shlex.shlex(text, posix=True, punctuation_chars="|&;")
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def _segments(tokens):
    segment = []
    for token in tokens:
        if token in SEPARATORS:
            if segment:
                yield segment
            segment = []
            continue
        segment.append(token)
    if segment:
        yield segment


def _substitutions(command):
    """The script texts hidden in `$(...)` and backticks, so a wrapped search is still judged."""
    return [left or right for left, right in SUBSTITUTION.findall(command)]


def _basename(word):
    return os.path.basename(word.rstrip("/")) if word else word


def _prefix_token(token):
    """A `VAR=value` assignment, a leading option, or an empty word: never the command."""
    if not token or token.startswith("-"):
        return True
    name = token.split("=", 1)[0]
    return "=" in token and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is not None


def _command_index(tokens):
    """Index of the word that is the command, skipping `VAR=value` and carrying wrappers."""
    index = 0
    while index < len(tokens):
        if _prefix_token(tokens[index]):
            index += 1
            continue
        token = tokens[index]
        wrapper = _basename(token) if _basename(token) in WRAPPERS else None
        if wrapper is None:
            return index
        index += 1
        values = WRAPPER_VALUE_OPTIONS.get(wrapper, frozenset())
        while index < len(tokens) and tokens[index].startswith("-"):
            if tokens[index].split("=", 1)[0] in values and "=" not in tokens[index]:
                index += 2
            else:
                index += 1
    return None


def _scan(tool, args):
    """(positionals, flags, bare_pattern_flag) for one tool's argv tail.

    Short clusters are split into single flags (`-rl` is `-r` and `-l`), and an option that takes a
    value carries it inline (`-m5`, `-g*.ts`) or as the next word. What comes back is only what the
    scope rule needs, not a general argv model.
    """
    positionals, flags = [], set()
    values = SHORT_VALUE.get(tool, frozenset())
    index = 0
    while index < len(args):
        token = args[index]
        index += 1
        if token == "--":
            positionals.extend(args[index:])
            break
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            flags.add(name)
            if "=" not in token and name in LONG_VALUE:
                index += 1
            continue
        if token.startswith("-") and len(token) > 1:
            for offset, letter in enumerate(token[1:], start=1):
                flags.add("-" + letter)
                if letter in values:
                    # The rest of this word is the value; otherwise the next word is.
                    if offset == len(token) - 1:
                        index += 1
                    break
            continue
        positionals.append(token)
    return positionals, flags


def _recursive(tool, flags):
    if tool in GREP_FAMILY:
        return bool(flags & {"-r", "-R", "--recursive", "--dereference-recursive"})
    return True


def _targets(tool, args, positionals, flags):
    """The paths this invocation would walk, never empty: the working directory is the default."""
    if tool == "find":
        # `find` takes its path first and then only predicates: `find -name x` still means `.`.
        return [args[0]] if args and not args[0].startswith("-") else ["."]
    if tool in {"fd", "fdfind"}:
        return positionals[1:2] or ["."]
    if flags & PATTERN_OPTIONS or flags & NO_PATTERN:
        return positionals or ["."]
    return positionals[1:] or ["."]


def _expand(word, cwd):
    """Absolute target for one word, or None when it cannot be resolved with confidence."""
    word = word.strip()
    if not word:
        return None
    home = os.path.expanduser("~")
    if word == "~" or word.startswith("~/"):
        word = home + word[1:]
    elif word.startswith("$HOME"):
        word = home + word[len("$HOME"):]
    elif word.startswith("${HOME}"):
        word = home + word[len("${HOME}"):]
    if "$" in word or "*" in word or "?" in word or "[" in word:
        return None
    if not os.path.isabs(word):
        word = os.path.join(cwd, word)
    return os.path.realpath(word)


def _inside(target, root):
    return target == root or target.startswith(root.rstrip(os.sep) + os.sep)


def worktree_root(cwd):
    """The git top level of `cwd`, or `cwd` itself when it is not inside a checkout."""
    if is_checkout(cwd):
        # A checkout root is its own boundary; asking git would cost a subprocess per tool call.
        return os.path.realpath(cwd)
    try:
        done = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=WORKTREE_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return os.path.realpath(cwd)
    top = done.stdout.strip()
    return os.path.realpath(top) if done.returncode == 0 and top else os.path.realpath(cwd)


def is_checkout(path):
    """A checkout root: `.git` is a directory in a clone and a file in a linked worktree."""
    return os.path.exists(os.path.join(path, ".git"))


def _holds_other_checkouts(path):
    """True when `path` is a plain directory holding at least one other checkout.

    That shape - a workspace root above several repositories - is the one this guard exists for:
    nothing is answered at that level, and walking it is what cost 28 minutes.
    """
    try:
        entries = os.listdir(path)
    except OSError:
        return False
    return any(not name.startswith(".")
               and is_checkout(os.path.join(path, name))
               for name in entries)


def _suggestion_text(root):
    return (
        "git grep -n <pattern> -- '<glob>'      # tracked and indexed, repo-scoped",
        f"cd {root} && rg -n --max-depth {SUGGESTED_DEPTH} -g '!node_modules' -g '!.git' "
        "<pattern> .",
        "orca orchestration worker-show --dispatch <id>   # dispatch/task/worker state is an RPC, "
        "not a file search",
    )


def _refuse(tool, target, root, subject):
    return {"decision": DENY,
            "tool": tool,
            "target": target,
            "worktree": root,
            "reason": f"{tool} would walk {subject}, outside this worktree ({root})",
            "suggestions": list(_suggestion_text(root))}


def _judge_segment(tokens, cwd, root):
    """Verdict for one simple command, plus the directory it leaves behind for the next one."""
    index = _command_index(tokens)
    if index is None:
        return ALLOW, cwd, None
    word = _basename(tokens[index])
    rest = tokens[index + 1:]
    if word in SHELLS:
        # `bash -c '<script>'` and `bash -lc '<script>'`: judge the script, not the wrapper.
        for position, token in enumerate(rest):
            if token.startswith("-") and "c" in token[1:] and position + 1 < len(rest):
                verdict = _evaluate(" ".join(rest[position + 1:]), cwd, root)
                if verdict["decision"] == DENY:
                    return DENY, cwd, verdict
                break
        return ALLOW, cwd, None
    if word == "cd":
        # The next segment runs elsewhere, so the boundary check has to follow the move: bare `cd`
        # goes home, which is exactly the directory that must not be walked.
        target = rest[0] if rest and not rest[0].startswith("-") else "~"
        return ALLOW, _expand(target, cwd) or cwd, None
    if word not in RECURSIVE_TOOLS:
        return ALLOW, cwd, None
    positionals, flags = _scan(word, rest)
    if flags & REPORT_ONLY or not _recursive(word, flags):
        return ALLOW, cwd, None
    for target in _targets(word, rest, positionals, flags):
        resolved = _expand(target, cwd)
        if resolved is None:
            return DENY, cwd, _refuse(word, target, root,
                                      f"`{target}` (it cannot be resolved with confidence)")
        if not _inside(resolved, root):
            return DENY, cwd, _refuse(word, resolved, root, resolved)
        if resolved == root and not is_checkout(root) and _holds_other_checkouts(root):
            return DENY, cwd, _refuse(word, resolved, root,
                                      f"{resolved} (a directory holding other checkouts)")
    return ALLOW, cwd, None


def _evaluate(command, cwd, root=None):
    cwd = os.path.realpath(cwd) if cwd else os.getcwd()
    root = root or worktree_root(cwd)
    tokens = _tokenize(command)
    state = cwd
    for segment in _segments(tokens):
        verdict, state, refusal = _judge_segment(segment, state, root)
        if verdict == DENY:
            return refusal
    return {"decision": ALLOW, "worktree": root}


def evaluate(command, cwd, root=None, _depth=0):
    """The decision for one shell command line: `{"decision": "allow"|"deny", ...}`.

    Never raises and never runs the command. `root` defaults to the git top level of `cwd`, which
    is what a caller inside a worktree means by "my own tree".
    """
    try:
        verdict = _evaluate(command, cwd, os.path.realpath(root) if root else None)
        if verdict["decision"] == DENY or _depth >= MAX_SUBSTITUTION_DEPTH:
            return verdict
        for script in _substitutions(command):
            inner = evaluate(script, cwd, root, _depth + 1)
            if inner["decision"] == DENY:
                return inner
        return verdict
    except Exception as error:  # fail-open: an unreadable command is not evidence of a bad one
        return {"decision": ALLOW, "error": f"{type(error).__name__}: {error}"}


def explain(verdict):
    """The refusal as three sentences a reader can act on."""
    if verdict["decision"] == ALLOW:
        return f"allowed: {verdict.get('worktree', '')}".rstrip()
    lines = [f"refused: {verdict['reason']}", "use one of:"]
    lines.extend(f"  {line}" for line in verdict["suggestions"])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Decide whether a shell command may walk the filesystem recursively.")
    parser.add_argument("--cwd", default=os.getcwd(), help="directory the command would run in")
    parser.add_argument("--root", default=None,
                        help="worktree boundary; defaults to the git top level of --cwd")
    parser.add_argument("--command", default=None, help="command text (default: stdin)")
    parser.add_argument("--explain", action="store_true", help="human form instead of JSON")
    args = parser.parse_args(argv)
    command = args.command if args.command is not None else sys.stdin.read()
    if not command.strip():
        parser.error("no command text: pass --command or write it on stdin")
    if not os.path.isdir(args.cwd):
        print(f"search_guard: --cwd is not a directory: {args.cwd}", file=sys.stderr)
        return EXIT_PRECONDITION
    verdict = evaluate(command, args.cwd, args.root)
    print(explain(verdict) if args.explain else json.dumps(verdict, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
