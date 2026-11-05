#!/bin/sh
# Reproducible offline baseline for this directory.
#
# The caller's shell may carry a private Operator policy (SWARM_WORKER_PROFILES) and a
# private RSI checkout (RSI_CHECKER_TEST_ROOT). Both change what "offline PASS" means,
# so this runner clears them instead of inheriting them. It reads no other config.
#
# Usage: tests/run_offline.sh [extra unittest options, e.g. -p "test_coordinator_tui_*"]
# Exit status is unittest's own exit status.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
    PYTHONPATH=.:tests python3 -B -m unittest discover -s tests "$@"
