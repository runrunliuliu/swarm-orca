#!/bin/sh
# Run the offline modules a diff can affect, instead of the whole suite.
#
# Usage: tests/run_blast.sh --range <rev|range> [--dry-run] [--jobs N]
#
#   --range <rev>   anything `git diff --name-only` accepts: HEAD~1, a..b, a commit.
#   --dry-run       print the selection and stop (no module starts).
#
# Selection rules live in tests/blast_radius.py and are fixed there on purpose: same basename,
# tests that import the module, one hop of source importers, plus the explicit SHARED_MAP
# policy. It is not the transitive closure and it is not "grep for the name".
#
# What this cannot see: dynamic imports, modules invoked as a subprocess
# (`python3 <module>.py`), and coupling that exists only through fixtures. Those are stated
# here rather than papered over. An empty radius is exit 2, never a pass: "nothing was selected"
# and "nothing could break" are different claims.
#
# The run goes through tests/run_offline.sh --modules, so the summary says
# `selection: k/N modules (explicit)` and `TARGETED OK`. A targeted run is not an offline PASS.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

range_spec=
dry_run=0
jobs=
while [ $# -gt 0 ]; do
    case $1 in
        --range)
            [ $# -ge 2 ] || { echo "run_blast.sh: --range needs a revision or range" >&2; exit 2; }
            range_spec=$2; shift 2 ;;
        --dry-run) dry_run=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        --jobs) [ $# -ge 2 ] || { echo "run_blast.sh: --jobs needs a positive integer" >&2; exit 2; }
                jobs=$2; shift 2 ;;
        *) echo "run_blast.sh: unknown option: $1" >&2; exit 2 ;;
    esac
done
[ -n "$range_spec" ] || { echo "run_blast.sh: --range is required; it takes a revision or range" >&2; exit 2; }

# stdout is the JSON selection; the human-readable lines above it come on stderr.
json=$(PYTHONPATH=.:tests python3 -B tests/blast_radius.py --range "$range_spec" --json) || exit 2

set -- $(printf '%s' "$json" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["modules"]))')
[ $# -gt 0 ] || { echo "run_blast.sh: selection is empty; refusing to report a pass" >&2; exit 2; }
if [ "$dry_run" = 1 ]; then
    echo "run_blast.sh: dry run, $# module(s) would run"
    exit 0
fi
# The job count is passed through, never executed early: doing that would run the full suite and
# drop the selection this script just computed.
if [ -n "$jobs" ]; then
    exec sh tests/run_offline.sh --jobs "$jobs" --modules "$@"
fi
exec sh tests/run_offline.sh --modules "$@"
