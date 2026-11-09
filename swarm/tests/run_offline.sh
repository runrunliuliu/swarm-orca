#!/bin/sh
# Reproducible offline baseline for this directory.
#
# The caller's shell may carry a private Operator policy (SWARM_WORKER_PROFILES) and a
# private RSI checkout (RSI_CHECKER_TEST_ROOT). Both change what "offline PASS" means,
# so this runner clears them instead of inheriting them. It reads no other config.
#
# Usage: tests/run_offline.sh [--full | --fast | --list] [extra unittest options]
#
#   --full  (default) every discovered module. This is the gate before integration and
#           delivery, and the only mode that may be reported as PASS.
#   --fast  every module except the wall-time dominators named in SLOW below. Iteration
#           feedback for the area you are changing; never a gate claim.
#   --list  print the modules the current mode would run, then exit 0.
#
# Mode flags must come before unittest options, e.g. `tests/run_offline.sh --fast -v`.
# When tests run, the exit status is unittest's own. `--list` exits 0 and a
# mode/option conflict exits 2, and both are the script's own statuses, not the suite's.
#
# Why SLOW exists (measured 2026-11-09 on an idle machine: those 4 modules were 301 s of a
# 467 s full run, 65% of the suite). Their cost is real work — the owner-socket RPC path
# (about 2000 round trips, each with a subprocess signature verification), fsync durability
# and JSON canonicalisation — not sleeps. `--fast` runs the other 86 modules in about 163 s.
# Test counts are deliberately absent: they grow with the suite, so a fixed number in a
# comment goes stale. Do not "optimise" this by deleting the heavy modules or their
# assertions: they are the bootstrap/strict production-path evidence. Re-derive the list by
# timing each module with a one-off standard-library loop (`time python3 -B -m unittest
# <module>`); this directory is standard-library only, so do not add a third-party runner.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

SLOW='test_bootstrap_production test_bootstrap_workflow test_startup_handoff test_bootstrap_failures'

mode=full
list_only=0
while [ $# -gt 0 ]; do
    case $1 in
        --full) mode=full; shift ;;
        --fast) mode=fast; shift ;;
        --list) list_only=1; shift ;;
        *) break ;;
    esac
done

if [ "$mode" = fast ]; then
    for arg in "$@"; do
        case $arg in
            -p*|-k*|-s*|--pattern*|--start-directory*)
                # --fast selects whole modules, so a discovery pattern would be silently
                # ignored and the reported coverage would be wrong. Fail instead.
                echo "run_offline.sh: --fast selects modules and cannot be combined with $arg" >&2
                exit 2 ;;
        esac
    done
fi

modules() {
    for file in tests/test*.py; do
        module=$(basename "$file" .py)
        if [ "$mode" = fast ]; then
            case " $SLOW " in
                *" $module "*) continue ;;
            esac
        fi
        printf '%s\n' "$module"
    done
}

if [ "$list_only" = 1 ]; then
    modules
    exit 0
fi

if [ "$mode" = fast ]; then
    exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
        PYTHONPATH=.:tests python3 -B -m unittest $(modules) "$@"
fi
exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
    PYTHONPATH=.:tests python3 -B -m unittest discover -s tests "$@"
