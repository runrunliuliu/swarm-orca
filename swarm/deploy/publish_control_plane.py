#!/usr/bin/env python3
"""Publish the swarm control plane as an immutable, verifiable artifact.

Contract: docs/deploy/control-plane-publish.md. This tool only copies, hashes and
records what it copied; it never starts an Agent, a Run, a monitor or a service,
and it never edits the source tree.

Modes:

  plan      read-only (default). Print the copy plan, the exclusions that applied
            and the buildId the content would receive.
  publish   write a NEW artifact directory. Refuses an existing destination, a
            dirty source and an unpinned source unless explicitly allowed, then
            optionally switches a pointer with an atomic rename.
  verify    read-only. Recompute the manifest of an existing artifact and compare
            it with the identity file.

Exit codes: 0 ok, 2 usage, 78 a precondition or integrity check failed.
"""

import argparse
import getpass
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ARTIFACT = "swarm-control-plane"
SCHEMA_VERSION = 1
COPY_RULE_VERSION = 1
IDENTITY = ".swarm-build.json"
MANIFEST = "MANIFEST.sha256"
EXIT_PRECONDITION = 78

# Directory copies: (destination, source relative to --source-root, excluded prefixes).
DIR_RULES = (
    ("code", "swarm-orca/swarm", ("tests", "__pycache__")),
    ("private", "swarm", ("tests", "__pycache__", "docs/validation", "trials")),
    ("overlay", "skills", ("__pycache__",)),
)

# File copies: (destination, source relative to --source-root).
FILE_RULES = (
    ("code/AGENTS.md", "swarm-orca/AGENTS.md"),
    ("NOTICE.md", "swarm-orca/NOTICE.md"),
    ("MIGRATION_STATUS.md", "swarm-orca/MIGRATION_STATUS.md"),
    ("README.md", "swarm-orca/README.md"),
    ("workspace/AGENTS.md", "AGENTS.md"),
    ("workspace/swarm-private-integration.md", "swarm-private-integration.md"),
    ("workspace/workspaces.json", "workspaces.json"),
    ("workspace/workspace-directory-policy.md", "workspace-directory-policy.md"),
)

# Path components and suffixes that never enter an artifact.
SKIP_COMPONENTS = frozenset({".git", "__pycache__", ".pytest_cache", ".mypy_cache",
                            ".ruff_cache", ".DS_Store"})
SKIP_SUFFIXES = (".pyc", ".pyo")
SKIP_NAMES = frozenset({".gitignore"})


class Failure(Exception):
    """A precondition or integrity problem; the message is the reported reason."""


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def skipped(rel, excluded_prefixes):
    parts = rel.split("/")
    if any(part in SKIP_COMPONENTS for part in parts):
        return True
    if parts[-1] in SKIP_NAMES or parts[-1].endswith(SKIP_SUFFIXES):
        return True
    return any(rel == prefix or rel.startswith(prefix + "/") for prefix in excluded_prefixes)


def collect(source_root, exclusions):
    """Return (destination-relative paths, source paths, excluded prefixes) for the rules.

    Read-only: resolve everything before the caller writes anything. Symbolic links are
    refused rather than followed: a link inside the source would otherwise be read from
    outside the tree and stored as a regular file.
    """
    copies = []
    excluded = []
    for destination, source, prefixes in DIR_RULES:
        base = source_root / source
        if base.is_symlink():
            raise Failure("source-symlink: %s" % source)
        if not base.is_dir():
            raise Failure("source-directory-missing: %s" % source)
        excluded.extend("%s/%s" % (destination, prefix) for prefix in prefixes)
        for path in sorted(base.rglob("*")):
            rel = path.relative_to(base).as_posix()
            if path.is_symlink():
                raise Failure("source-symlink: %s/%s" % (source, rel))
            if not path.is_file() or skipped(rel, prefixes):
                continue
            copies.append(("%s/%s" % (destination, rel), path))
    for destination, source in FILE_RULES:
        path = source_root / source
        if path.is_symlink():
            raise Failure("source-symlink: %s" % source)
        if not path.is_file():
            raise Failure("source-file-missing: %s" % source)
        copies.append((destination, path))
    destinations = [destination for destination, _ in copies]
    duplicates = sorted({name for name in destinations if destinations.count(name) > 1})
    if duplicates:
        raise Failure("destination-collision: %s" % ", ".join(duplicates))
    return copies, sorted(set(excluded))


def build_id(entries):
    """Content identity: 12 hex characters over the sorted per-file digests."""
    digest = hashlib.sha256()
    for name, file_digest in sorted(entries):
        digest.update(("%s  %s\n" % (file_digest, name)).encode("utf-8"))
    return digest.hexdigest()[:12]


def git(source_root, relative, *args):
    try:
        result = subprocess.run(["git", "-C", str(source_root / relative)] + list(args),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "replace").strip()


def source_state(source_root):
    """Describe the source checkout; `unpinned` when git cannot answer."""
    state = {
        "sourceRoot": str(source_root),
        "orcaSrcCommit": git(source_root, ".", "rev-parse", "HEAD"),
        "orcaSrcBranch": git(source_root, ".", "rev-parse", "--abbrev-ref", "HEAD"),
        "swarmOrcaCommit": git(source_root, "swarm-orca", "rev-parse", "HEAD"),
        "swarmOrcaBranch": git(source_root, "swarm-orca", "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": None,
        "dirtyPaths": [],
        "unpinned": False,
    }
    statuses = []
    for relative in (".", "swarm-orca"):
        status = git(source_root, relative, "status", "--porcelain", "--ignore-submodules=dirty")
        if status is None:
            state["unpinned"] = True
            state["dirty"] = None
            return state
        statuses.extend(line for line in status.splitlines() if line.strip())
    state["dirty"] = bool(statuses)
    state["dirtyPaths"] = statuses
    return state


def require_publishable(state, allow_dirty, allow_unpinned):
    if state["unpinned"] and not allow_unpinned:
        raise Failure("source-unpinned: git could not describe the source tree")
    if state["dirty"] and not allow_dirty:
        raise Failure("source-dirty: %d path(s) modified; pass --allow-dirty" % len(state["dirtyPaths"]))


def plan(args):
    source_root = Path(args.source_root).resolve()
    copies, excluded = collect(source_root, {})
    entries = [(destination, sha256_file(path)) for destination, path in copies]
    return {
        "mode": "plan",
        "source": source_state(source_root),
        "copyRuleVersion": COPY_RULE_VERSION,
        "fileCount": len(entries),
        "totalBytes": sum(path.stat().st_size for _, path in copies),
        "buildId": build_id(entries),
        "included": sorted(destination for destination, _ in copies),
        "artifactRoot": str(Path(args.artifact_root).resolve()) if args.artifact_root else None,
        "excluded": excluded,
    }


def write_manifest(root, entries):
    body = "".join("%s  %s\n" % (file_digest, name) for name, file_digest in sorted(entries))
    (root / MANIFEST).write_text(body, encoding="utf-8")


def read_manifest(root):
    entries = []
    text = (root / MANIFEST).read_text(encoding="utf-8")
    for line in text.splitlines():
        if not line.strip():
            continue
        digest, _, name = line.partition("  ")
        if len(digest) != 64 or not name:
            raise Failure("manifest-invalid: %r" % line)
        entries.append((name, digest))
    return entries


PRIVATE_PREFIX = "private"
PUBLIC_FILE_MODE = 0o644
PRIVATE_FILE_MODE = 0o640
PUBLIC_DIR_MODE = 0o755
PRIVATE_DIR_MODE = 0o750


def apply_modes(staging, entries):
    """Fix modes explicitly so the artifact does not inherit the publisher's umask."""
    os.chmod(staging, PUBLIC_DIR_MODE)
    for destination, _ in entries:
        private = destination == PRIVATE_PREFIX or destination.startswith(PRIVATE_PREFIX + "/")
        os.chmod(staging / destination, PRIVATE_FILE_MODE if private else PUBLIC_FILE_MODE)
        parent = (staging / destination).parent
        while parent != staging:
            os.chmod(parent, PRIVATE_DIR_MODE if parent.relative_to(staging).as_posix().split("/")[0]
                     == PRIVATE_PREFIX else PUBLIC_DIR_MODE)
            parent = parent.parent


def publish(args):
    source_root = Path(args.source_root).resolve()
    state = source_state(source_root)
    require_publishable(state, args.allow_dirty, args.allow_unpinned_source)
    artifact_root = Path(args.artifact_root).resolve()
    if not artifact_root.is_dir():
        raise Failure("artifact-root-missing: %s" % artifact_root)

    copies, excluded = collect(source_root, {})
    staging = Path(tempfile.mkdtemp(prefix=".%s-staging-" % ARTIFACT, dir=str(artifact_root)))
    try:
        for destination, path in copies:
            target = staging / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        # Hash what was written, not what was read: a short or changed read must not pass.
        entries = [(destination, sha256_file(staging / destination))
                   for destination, _ in copies]
        identifier = build_id(entries)
        final = artifact_root / ("%s-%s" % (ARTIFACT, identifier))
        if final.exists():
            raise Failure("artifact-exists: %s" % final)
        apply_modes(staging, entries)
        write_manifest(staging, entries)
        os.chmod(staging / MANIFEST, PUBLIC_FILE_MODE)
        identity = {
            "schemaVersion": SCHEMA_VERSION,
            "artifact": ARTIFACT,
            "buildId": identifier,
            "installDir": str(final),
            "source": state,
            "copyRuleVersion": COPY_RULE_VERSION,
            "included": sorted(destination for destination, _ in entries),
            "excluded": excluded,
            "host": socket.gethostname(),
            "deployUser": getpass.getuser(),
            "platform": platform.platform(),
            "deployedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        (staging / IDENTITY).write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n",
                                        encoding="utf-8")
        os.chmod(staging / IDENTITY, PUBLIC_FILE_MODE)
        if args.switch_pointer:
            preflight_pointer(Path(args.switch_pointer))
        # Self-check the staged bytes before the artifact can become current.
        inspect_artifact(staging, expected_install_dir=final)
        os.rename(staging, final)
        staging = None
        pointer = None
        if args.switch_pointer:
            pointer = switch_pointer(Path(args.switch_pointer), final)
    except Failure as error:
        if staging is not None:
            raise Failure("%s (staging retained: %s)" % (error, staging))
        raise
    except OSError as error:
        raise Failure("publish-failed: %s (staging retained: %s)" % (error, staging))
    return {"mode": "publish", "artifact": str(final), "buildId": identifier,
            "fileCount": len(copies), "pointer": pointer, "source": state}


def preflight_pointer(pointer):
    parent = pointer.parent
    if not parent.is_dir():
        raise Failure("pointer-parent-missing: %s" % parent)
    if pointer.exists() and not pointer.is_symlink():
        raise Failure("pointer-not-a-symlink: %s" % pointer)


def switch_pointer(pointer, target):
    """Atomic switch: create a sibling symlink, then rename it over the pointer."""
    temporary = pointer.with_name(".%s.new-%d" % (pointer.name, os.getpid()))
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    os.symlink(os.path.relpath(target, pointer.parent), temporary)
    os.replace(temporary, pointer)
    return {"path": str(pointer), "target": os.readlink(pointer)}


def inspect_artifact(root, expected_install_dir=None):
    """Read-only integrity report for one artifact directory; raises Failure when it is not usable.

    The identity file is not covered by the manifest, so everything it claims that can be
    recomputed is recomputed: the buildId against the manifest, the directory name against
    the buildId, and `included` against the manifest's path set.
    """
    root = Path(root).resolve()
    identity_path = root / IDENTITY
    if identity_path.is_symlink():
        raise Failure("symlink-in-artifact: %s" % IDENTITY)
    if not identity_path.is_file():
        raise Failure("identity-missing: %s" % IDENTITY)
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    if identity.get("schemaVersion") != SCHEMA_VERSION:
        raise Failure("identity-schema-unsupported: %r" % identity.get("schemaVersion"))
    if identity.get("artifact") != ARTIFACT:
        raise Failure("identity-artifact-mismatch: %r" % identity.get("artifact"))
    expected_install = Path(expected_install_dir).resolve() if expected_install_dir else root
    recorded = Path(identity.get("installDir", "")).resolve()
    if recorded != expected_install:
        raise Failure("install-dir-mismatch: identity says %s" % recorded)
    expected = read_manifest(root)
    identifier = build_id(expected)
    if identity.get("buildId") != identifier:
        raise Failure("build-id-mismatch: identity says %r, content is %s"
                      % (identity.get("buildId"), identifier))
    if expected_install.name != "%s-%s" % (ARTIFACT, identifier):
        raise Failure("artifact-name-mismatch: %s is not %s-%s"
                      % (expected_install.name, ARTIFACT, identifier))
    if sorted(identity.get("included") or []) != sorted(name for name, _ in expected):
        raise Failure("included-mismatch: identity and manifest disagree")
    actual = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise Failure("symlink-in-artifact: %s" % path.relative_to(root).as_posix())
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel in (IDENTITY, MANIFEST):
            continue
        actual.append((rel, sha256_file(path)))
    expected_map, actual_map = dict(expected), dict(actual)
    missing = sorted(set(expected_map) - set(actual_map))
    extra = sorted(set(actual_map) - set(expected_map))
    changed = sorted(name for name in set(expected_map) & set(actual_map)
                     if expected_map[name] != actual_map[name])
    if missing or extra or changed:
        raise Failure("manifest-mismatch: missing=%s extra=%s changed=%s"
                      % (missing[:5], extra[:5], changed[:5]))
    return {"mode": "verify", "artifact": str(root), "buildId": identity.get("buildId"),
            "fileCount": len(actual), "source": identity.get("source")}


def verify(args):
    return inspect_artifact(Path(args.artifact))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", nargs="?", default="plan", choices=("plan", "publish", "verify"))
    parser.add_argument("--source-root", default=None,
                        help="checkout holding swarm-orca/, swarm/ and skills/ (plan, publish)")
    parser.add_argument("--artifact-root", default=None,
                        help="directory that holds immutable artifacts (plan, publish)")
    parser.add_argument("--artifact", default=None, help="artifact directory to verify")
    parser.add_argument("--allow-dirty", action="store_true",
                        help="publish a modified source; the artifact is then not a pin source")
    parser.add_argument("--allow-unpinned-source", action="store_true",
                        help="publish when git cannot describe the source tree")
    parser.add_argument("--switch-pointer", default=None,
                        help="symlink to repoint at the new artifact, atomically, after publish")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)
    if args.mode == "verify" and not args.artifact:
        parser.error("verify needs --artifact")
    if args.mode in ("plan", "publish") and not args.source_root:
        parser.error("%s needs --source-root" % args.mode)
    if args.mode == "publish" and not args.artifact_root:
        parser.error("publish needs --artifact-root")

    try:
        report = verify(args) if args.mode == "verify" else \
            (publish(args) if args.mode == "publish" else plan(args))
    except Failure as error:
        print("refused: %s" % error, file=sys.stderr)
        return EXIT_PRECONDITION

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print("%s %s" % (report["mode"], report.get("artifact") or report.get("buildId")))
        print("  buildId: %s" % report.get("buildId"))
        if "fileCount" in report:
            print("  files: %d" % report["fileCount"])
        source = report.get("source") or {}
        print("  source: %s @ %s dirty=%s unpinned=%s"
              % (source.get("orcaSrcCommit"), source.get("swarmOrcaCommit"),
                 source.get("dirty"), source.get("unpinned")))
        if report.get("pointer"):
            print("  pointer: %s -> %s" % (report["pointer"]["path"], report["pointer"]["target"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
