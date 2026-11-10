"""Execute offline unittest modules concurrently, one process per module.

`run_offline.sh` decides which modules a mode selects and hands that list to this helper on
stdin, so selection stays in exactly one place. Running modules in separate processes is the
only assertion-preserving way to shorten the gate: the slow modules are dominated by real
owner-socket RPC and per-message signature verification (the slowest single module needs about
100 s), so concurrency helps without skipping, merging or weakening a single test.

Standard library only, like the rest of this directory. Exit status is 0 only when every
requested module ran and unittest reported success for all of them; a failure prints the
captured output of each failing module so the log still carries the failing assertions.
"""

import argparse
import concurrent.futures
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def count_tests(output):
    """Return the test count a unittest run reported, or None when it is unknown."""
    for line in reversed(output.splitlines()):
        if line.startswith("Ran ") and " test" in line:
            head = line[len("Ran "):].split(" ")
            if head and head[0].isdigit():
                return int(head[0])
    return None


def run_module(module, extra):
    started = time.monotonic()
    completed = subprocess.run(
        [sys.executable, "-B", "-m", "unittest", module, *extra],
        cwd=ROOT, capture_output=True, text=True
    )
    return module, completed, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, required=True,
                        help="modules to run at once; must be a positive integer")
    parser.add_argument("extra", nargs=argparse.REMAINDER,
                        help="options forwarded to each module's unittest run")
    args = parser.parse_args()
    extra = args.extra[1:] if args.extra[:1] == ["--"] else args.extra
    modules = [line.strip() for line in sys.stdin if line.strip()]
    if args.jobs < 1:
        parser.error("--jobs must be a positive integer")
    if not modules:
        print("run_modules.py: no modules were selected", file=sys.stderr)
        return 2

    started = time.monotonic()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for module, completed, seconds in pool.map(lambda m: run_module(m, extra), modules):
            results.append((module, completed, seconds))
            print(f"{module}\t{'ok' if completed.returncode == 0 else 'FAILED'}\t{seconds:.1f}s",
                  flush=True)

    failed = [(module, completed) for module, completed, _ in results if completed.returncode]
    counts = [count_tests(completed.stdout + completed.stderr)
              for _, completed, _ in results]
    # Why unknown stays unknown: a module whose count cannot be parsed must not be summed as
    # zero, otherwise the log would claim a smaller suite than the one that ran.
    known = all(count is not None for count in counts)
    total = sum(counts) if known else None

    print("", flush=True)
    for module, completed in failed:
        print(f"--- {module} (exit {completed.returncode}) ---", flush=True)
        print((completed.stdout + completed.stderr).rstrip(), flush=True)
        print("", flush=True)

    ran = len(results)
    # Why compare counts: the helper's contract is "everything you were given ran", so a
    # silently dropped module has to fail the run instead of shrinking it.
    missing = len(modules) - ran
    print(f"modules: {ran}/{len(modules)}   jobs: {args.jobs}   elapsed: "
          f"{time.monotonic() - started:.1f}s", flush=True)
    print(f"tests: {total if known else 'unknown (a module reported no count)'}", flush=True)
    if failed:
        print(f"FAILED ({len(failed)} module(s))", flush=True)
        return 1
    if missing:
        print(f"FAILED ({missing} module(s) never ran)", flush=True)
        return 1
    print("OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
