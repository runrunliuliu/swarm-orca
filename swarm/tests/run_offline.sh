#!/bin/sh
# Reproducible offline baseline for this directory.
#
# The caller's shell may carry a private Operator policy (SWARM_WORKER_PROFILES) and a
# private RSI checkout (RSI_CHECKER_TEST_ROOT). Both change what "offline PASS" means,
# so this runner clears them instead of inheriting them. It reads no other config.
#
# Usage: tests/run_offline.sh [--fast | --list] [--jobs N] [--modules a.b c.d] [extra unittest options]
#
#   (default)  every discovered module. Optional: a change is verified by the modules its
#           blast radius names, and only a run that actually executed every module may be
#           reported as an "offline PASS".
#   --modules a.b c.d  run exactly these modules (dotted names as printed by `--list`).
#           The summary then says `selection: k/N modules (explicit)` and the status word is
#           `TARGETED OK`, never `PASS`: a targeted run does not describe the whole suite.
#           Unknown names exit 2; a bare positional module name is refused instead of being
#           forwarded to unittest (that silently ran the whole suite), and `--jobs` defaults
#           to `min(4, k)` so one named module does not ask for four workers.
#   --fast  every module except the wall-time dominators named in SLOW below. Iteration
#           feedback for the area you are changing; never a gate claim.
#   --list  print the modules the current mode would run, then exit 0.
#   --jobs N  run the selected modules N at a time, one process each (see below). The
#           default is 4, measured on both a local ext4 tree and the NAS workspace mount;
#           `--jobs 1` is the reproducible single-process form; `--list` ignores it.
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
# on the ext4 host before the handoff split: 91 modules sequential 481 s, `--jobs 8` 104 s,
# same module set and test count. It deletes, merges and weakens nothing — it only stops
# independent modules from queueing. Selection still happens here; tests/run_modules.py only
# executes the list it is given.
#
# The default is 4 because concurrency is now cheap enough to be the normal form: with the
# per-process read reuse in coordinator_io, this NAS mount runs 99 modules / 2577 tests in
# 363 s sequentially and 115 s at `--jobs 4`, 99/99 modules OK. The 2026-11-10 measurement
# that used to forbid this — 94 modules in 892 s with `operators.test_operator_monitor_deploy`
# at 700 s (tui_action_window_insufficient) and `core.test_startup_handoff_monitor` at 788 s
# (tui_continuation_deadline), against 18 s and 193 s alone — was the same repeated source
# reads, not a property of parallel runs: those two modules now finish in 13.4 s and 22.0 s
# under 4-way load. `--jobs 1` stays the reproducible form, so a gate claim still has to name
# the job count the run used (the helper prints it).
#
# Where it cannot help at all it is refused rather than silently flattened: a job count larger
# than the number of selected modules only starts workers that never receive work, so `--jobs`
# must stay at 1 (or be omitted) for a selection that small.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# `core.test_startup_handoff` is four modules instead of one so the parallel floor below is a
# quarter of the single module: `--jobs` schedules modules, and on the NAS workspace mount the
# one module needed 577 s (694,875 source re-reads, no RPC). Same 40 tests, same assertions.
# Those re-reads are now reused per process identity, which is why the floor is no longer a
# multi-minute module.
SLOW='bootstrap.test_bootstrap_production bootstrap.test_bootstrap_workflow core.test_startup_handoff core.test_startup_handoff_prepare core.test_startup_handoff_trigger core.test_startup_handoff_monitor bootstrap.test_bootstrap_failures'

mode=full
list_only=0
# 4 workers by default: measured `--jobs 8` adds almost nothing over `--jobs 4` (the run is
# bounded by `bootstrap.test_bootstrap_production`, about 74 s), while 4 keeps the per-module
# slowdown small on a network mount. A discovery option (`-p`/`-s`) still runs sequentially
# because it selects tests, not modules.
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
        --modules)
            shift
            # Consume the module list that follows: every token up to the next option.
            [ $# -gt 0 ] || { echo "run_offline.sh: --modules needs at least one module name" >&2; exit 2; }
            while [ $# -gt 0 ]; do
                case $1 in
                    -*) break ;;
                esac
                explicit_modules="${explicit_modules:+$explicit_modules }$1"
                shift
            done ;;
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

# A positional module name used to be forwarded to unittest, which then ran the whole suite (and
# repeated the named module inside every worker). Refuse it here, where the exit status is the
# runner's own, instead of reporting a suite the caller never asked for.
# Each option's own argument is skipped, so `-p test_capacity_io.py` stays the documented
# iteration form instead of being read as a positional module name.
option_argument_pending=0
for arg in "$@"; do
    if [ "$option_argument_pending" = 1 ]; then
        option_argument_pending=0
        continue
    fi
    case $arg in
        -p|-s|-t|--pattern|--start-directory|--top-level-directory) option_argument_pending=1 ;;
        -p*|-s*|-t*|--pattern=*|--start-directory=*|--top-level-directory=*|\
        -v|-vv|-vvv|--verbose|-q|--quiet|-f|--failfast|-b|--buffer|-c|--catch) ;;
        -*) echo "run_offline.sh: unknown runner option: $arg" >&2
            exit 2 ;;
        *.*|*.py|*/*) echo "run_offline.sh: positional module names were removed; use --modules a.b c.d" >&2
            exit 2 ;;
        *) echo "run_offline.sh: unexpected positional argument: $arg" >&2
            exit 2 ;;
    esac
done

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

# The selection is either the explicit `--modules` list or what `modules()` prints. Both go
# through one printer so `--list` and a real run cannot drift apart.
selected() {
    if [ -n "${explicit_modules:-}" ]; then
        for module in $explicit_modules; do printf '%s\n' "$module"; done
    else
        modules
    fi
}

if [ -n "${explicit_modules:-}" ]; then
    if [ "$mode" = fast ]; then
        echo "run_offline.sh: --modules names exact modules and cannot be combined with --fast" >&2
        exit 2
    fi
    # One space-separated haystack with sentinels, so a module name can only match a whole token
    # (`test_log_io` must not match `core.test_log_io_x`).
    known=" $(modules | tr '\n' ' ') "
    known_count=$(printf '%s' "$known" | wc -w | tr -d ' ')
    for module in $explicit_modules; do
        case "$known" in
            *" $module "*) ;;
            *)
                printf 'run_offline.sh: unknown module: %s; --list prints the %s valid names\n' \
                    "$module" "$known_count" >&2
                exit 2 ;;
        esac
    done
    # A discovery option selects tests, not modules; combining it with an explicit module list
    # would report a coverage neither of them describes.
    for arg in "$@"; do
        case $arg in
            -p|-p*|--pattern|--pattern=*|-s|-s*|--start-directory|--start-directory=*)
                echo "run_offline.sh: --modules selects modules and cannot be combined with $arg" >&2
                exit 2 ;;
        esac
    done
    explicit_count=$(printf '%s\n' $explicit_modules | wc -l | tr -d ' ')
    if [ "$jobs_given" = 0 ]; then
        # `min(4, k)`: asking for four workers to run one module only starts workers that never
        # receive work, which the `--jobs` check below would refuse.
        jobs=4
        [ "$explicit_count" -lt 4 ] && jobs=$explicit_count
    fi
fi

if [ "$list_only" = 1 ]; then
    selected
    exit 0
fi

if [ -n "${explicit_modules:-}" ] || [ "$jobs" -gt 1 ]; then
    # A job count above the selected module count only starts workers that never receive work.
    # That cannot help, so it is refused here instead of being flattened silently: the caller
    # asked for something the runner would not do.
    selected_count=$(selected | wc -l | tr -d ' ')
    if [ "$jobs" -gt "$selected_count" ]; then
        echo "run_offline.sh: --jobs $jobs exceeds the $selected_count selected modules; use --jobs 1" >&2
        exit 2
    fi
    # Why the list goes over stdin: selection stays in `selected()`, so a parallel gate cannot
    # drift from what `--list` prints. tests/run_modules.py only executes and aggregates.
    # The two variables below let the helper report a targeted run as targeted; without them the
    # runner's own summary would have to duplicate the selection and could drift.
    exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
        RUN_OFFLINE_SELECTION="${explicit_modules:+explicit}" \
        RUN_OFFLINE_TOTAL="$(modules | wc -l | tr -d ' ')" \
        PYTHONPATH=.:tests python3 -B tests/run_modules.py --jobs "$jobs" -- "$@" <<EOF
$(selected)
EOF
fi
if [ "$mode" = fast ]; then
    exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
        PYTHONPATH=.:tests python3 -B -m unittest $(modules) "$@"
fi
exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
    PYTHONPATH=.:tests python3 -B -m unittest discover -s tests "$@"
