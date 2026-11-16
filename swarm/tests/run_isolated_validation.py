"""Explicit isolated validation root; no native agents or service operations.

Each scope is a `unittest discover` pattern; no module list is pinned here, so a scope cannot point
at a module that no longer exists.

Example: python3 -B tests/run_isolated_validation.py --parent <canonical NAS archive>
Test scratch is task-owned and cleaned by unittest fixtures; reports/source hashes
are immutable and retained in the unique validation directory.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coordinator_io import file_ref, path, publish_new, pinned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", required=True)
    parser.add_argument("--scope", choices=("all", "coordinator"), default="all",
                        help="unittest discover pattern set; no individual module is pinned")
    args = parser.parse_args()
    parent = path(args.parent, directory=True)
    root = Path(tempfile.mkdtemp(prefix="offline-isolated-validation-", dir=parent))
    scratch = root / "scratch"
    scratch.mkdir(mode=0o700)
    source = Path(__file__).resolve().parents[1]
    print(str(root), flush=True)
    sources = [file_ref(p) for p in sorted(source.glob("*.py"))] + [
        file_ref(p) for p in sorted((source / "tests").rglob("*.py"))]
    mount = subprocess.run(["findmnt", "-T", str(root), "-J", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"],
                           check=True, stdout=subprocess.PIPE, timeout=10)
    results = []
    patterns = {"all": ("test_bootstrap*.py", "test_coordinator*.py"),
                "coordinator": ("test_coordinator*.py",)}[args.scope]
    for pattern in patterns:
        started = time.monotonic()
        command = [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-p", pattern]
        completed = subprocess.run(command, cwd=source, env=dict(os.environ, TMPDIR=str(scratch)),
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        name = pattern.replace("test_", "").replace("*", "").replace(".py", ".log")
        publish_new(root / name, completed.stdout)
        print(completed.stdout.decode(errors="replace"), flush=True)
        results.append(dict(pattern=pattern, returncode=completed.returncode,
                            seconds=time.monotonic() - started, log=file_ref(root / name)))
    for ref in sources:
        pinned(ref)
    report = dict(schema_version=1, kind="offline_isolated_validation", root=str(root),
                  python=sys.version, source_root=str(source), results=results, sources=sources,
                  mount=json.loads(mount.stdout),
                  scope=args.scope,
                  native_mocked=True, live_acceptance=False, execution_authorized=False)
    publish_new(root / "report.json", report)
    for result in results:
        pinned(result["log"])
    receipt = file_ref(root / "report.json")
    pinned(receipt)
    print(json.dumps(receipt), flush=True)
    return int(any(r["returncode"] for r in results))


if __name__ == "__main__":
    raise SystemExit(main())
