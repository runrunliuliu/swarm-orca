#!/bin/sh
# Reproducible offline baseline for this directory.
#
# The caller's shell may carry a private Operator policy (SWARM_WORKER_PROFILES) and a
# private RSI checkout (RSI_CHECKER_TEST_ROOT). Both change what "offline PASS" means,
# so this runner clears them instead of inheriting them. It reads no other config.
#
# Usage: tests/run_offline.sh [--fast | --list] [--jobs N] [extra unittest options]
#
#   (default)  every discovered module. This is the gate before integration and delivery,
#           and the only run that may be reported as PASS.
#   --fast  every module except the wall-time dominators named in SLOW below. Iteration
#           feedback for the area you are changing; never a gate claim.
#   --list  print the modules the current mode would run, then exit 0.
#   --jobs N  run the selected modules N at a time, one process each (see below). The
#           default is 4; `--jobs 1` is the single-process form, and `--list` ignores it.
#
# Tests live under `tests/<area>/test_*.py` (bootstrap, coordinator, operators, trae,
# worker, core). A module's name is its dotted path relative to `tests/`, which is also
# the name unittest discovery reports, so `--list` and discovery can be compared.
#
# Mode flags must come before unittest options, e.g. `tests/run_offline.sh --fast -v`.
# When tests run, the exit status is unittest's own. `--list` exits 0 and a
# mode/option conflict exits 2, and both are the script's own statuses, not the suite's.
#
# Why SLOW exists (measured 2026-11-09 on an idle machine: those 4 modules were 301 s of a
# 467 s full run, 65% of the suite). Their cost is real work — the owner-socket RPC path
# (about 2000 round trips, each with a subprocess signature verification), fsync durability
# and JSON canonicalisation — not sleeps. `--fast` runs the other 87 modules in about 163 s.
# The four earliest entries are now seven modules because `core.test_startup_handoff` is split
# four ways (same 40 tests); that only changes the parallel floor, not the total work.
# Test counts are deliberately absent: they grow with the suite, so a fixed number in a
# comment goes stale. Do not "optimise" this by deleting the heavy modules or their
# assertions: they are the bootstrap/strict production-path evidence. Re-derive the list by
# timing each module with a one-off standard-library loop (`time python3 -B -m unittest
# <module>`); this directory is standard-library only, so do not add a third-party runner.
#
# Why --jobs exists: modules are independent processes already (no test in one imports state
# from another), so the full suite is bounded by its slowest module, not by the sum. Measured
# on this host, before the handoff split: 91 modules sequential 481 s, `--jobs 8` 104 s, same
# module set and test count. It deletes, merges and weakens nothing — it only stops independent modules from
# queueing. Selection still happens here; tests/run_modules.py only executes the list it is
# given. The default is 4 rather than 1: on a host with enough cores that is a straight win, and
# on an I/O-bound host it still turns the sum into the slowest module. Keep `--jobs 1` reachable
# because a claim on a single-process run has to stay reproducible, and always report the job
# count alongside any timing (the helper prints it).
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# `core.test_startup_handoff` is four modules instead of one so the parallel floor below is a
# quarter of the single module: `--jobs` schedules modules, and on the NAS workspace mount the
# one module needed 577 s (694,875 source re-reads, no RPC). Same 40 tests, same assertions.
SLOW='bootstrap.test_bootstrap_production bootstrap.test_bootstrap_workflow core.test_startup_handoff core.test_startup_handoff_prepare core.test_startup_handoff_trigger core.test_startup_handoff_monitor bootstrap.test_bootstrap_failures'

mode=full
list_only=0
# Default to 4 workers: the suite is independent modules, so the gate is bounded by the slowest
# module rather than by the sum (measured: 91 modules, sequential 481 s, `--jobs 8` 104 s on
# ext4). Discovery options still fall through to the sequential path below, and `--jobs 1` stays
# the reproducible single-process form, so a gate claim has to name the job count either way.
jobs=4
jobs_given=0
while [ $# -gt 0 ]; do
    case $1 in
        --full)
            # Dropped on purpose: the default already is the full suite, and an unparsed
            # `--full` would be handed to unittest and fail there for an unrelated reason.
            echo "run_offline.sh: --full was removed; the full suite is the default" >&2
            exit 2 ;;
        --fast) mode=fast; shift ;;
        --list) list_only=1; shift ;;
        --jobs)
            [ $# -ge 2 ] || { echo "run_offline.sh: --jobs needs a positive integer" >&2; exit 2; }
            jobs=$2
            jobs_given=1
            shift 2 ;;
        *) break ;;
    esac
done
case $jobs in
    ''|*[!0-9]*) echo "run_offline.sh: --jobs needs a positive integer, got '$jobs'" >&2; exit 2 ;;
esac
[ "$jobs" -ge 1 ] || { echo "run_offline.sh: --jobs needs a positive integer, got '$jobs'" >&2; exit 2; }

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

if [ "$jobs" -gt 1 ] && [ "$list_only" != 1 ]; then
    for arg in "$@"; do
        case $arg in
            -p|-p*|--pattern|--pattern=*|-s|--start-directory*)
                if [ "$jobs_given" = 1 ]; then
                    # Parallel mode runs named modules, so a discovery option would be handed to
                    # every module and rejected there. Refuse it here with the runner's own
                    # status instead of a confusing per-module failure.
                    echo "run_offline.sh: --jobs runs named modules and cannot be combined with $arg" >&2
                    exit 2
                fi
                # Default parallelism must not break the documented `-p` iteration path:
                # discovery selects tests, not modules, so run this one sequentially.
                jobs=1 ;;
        esac
    done
fi

modules() {
    for file in tests/test*.py tests/*/test*.py; do
        [ -f "$file" ] || continue
        module=$(basename "$file" .py)
        area=$(basename "$(dirname "$file")")
        if [ "$area" != tests ]; then
            module="$area.$module"
        fi
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

if [ "$jobs" -gt 1 ]; then
    # Why the list goes over stdin: selection stays in `modules()`, so a parallel gate cannot
    # drift from what `--list` prints. tests/run_modules.py only executes and aggregates.
    exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
        PYTHONPATH=.:tests python3 -B tests/run_modules.py --jobs "$jobs" -- "$@" <<EOF
$(modules)
EOF
fi
if [ "$mode" = fast ]; then
    exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
        PYTHONPATH=.:tests python3 -B -m unittest $(modules) "$@"
fi
exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
    PYTHONPATH=.:tests python3 -B -m unittest discover -s tests "$@"
