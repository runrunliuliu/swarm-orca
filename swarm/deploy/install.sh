#!/usr/bin/env bash
# First-run entry point: install the swarm control plane on a host that has this checkout.
#
# Why this exists: `install-control-plane.sh` is the mechanism, but a first-time user has no way
# to know it is needed. This is the one command to show them. It detects the source root, checks
# the environment, prints what it is about to do, then hands off to the installer. It adds no
# behaviour of its own: same flags, same read-only default, same exit codes.
#
#   ./swarm/deploy/install.sh --source-root /path/to/workspace --apply
#
# Read-only unless --apply. Nothing calls this automatically.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALLER="$SCRIPT_DIR/install-control-plane.sh"
readonly EXIT_PRECONDITION=78

note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit "$EXIT_PRECONDITION"; }

SOURCE_ROOT=""
PASSTHROUGH=()

require_value() {
  local flag="$1" value="${2:-}"
  [ -n "$value" ] || fail "$flag requires a value"
  case "$value" in --*) fail "$flag requires a value, got option $value" ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-root) require_value "$1" "${2:-}"; SOURCE_ROOT="$2"; PASSTHROUGH+=("$1" "$2"); shift 2 ;;
    --help|-h)
      cat <<'USAGE'
Usage: install.sh [--source-root <dir>] [installer flags...]

  The first command to run on a new host. Without --source-root it accepts the detected
  workspace root (printed below) or the checkout's parent when that looks like one.

  Installer flags are passed through unchanged:
    --artifact-root <dir> --pointer <path> --skills-dir <dir> --host-override <path>
    --apply --check --provision --allow-dirty --allow-unpinned-source
    --skip-skills --force-links
USAGE
      exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

[ -f "$INSTALLER" ] || fail "installer missing next to this script: $INSTALLER"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v git >/dev/null 2>&1 || fail "git is required (the publisher records the source commit)"

step "environment"
note "checkout: $(cd "$SCRIPT_DIR/../.." && pwd)"
if command -v orca >/dev/null 2>&1; then
  note "orca CLI: $(command -v orca)"
else
  note "orca CLI: not on PATH — install it first if this host will run Agent sessions;"
  note "           the control plane itself does not need it for readiness."
fi
if [ -e /opt/orca/current ]; then
  note "orca build: $(readlink -f /opt/orca/current)"
else
  note "orca build: /opt/orca/current not found"
fi

step "source root"
looks_like_source_root() {
  local candidate="$1"
  [ -d "$candidate/swarm-orca/swarm" ] && [ -d "$candidate/swarm" ] && [ -d "$candidate/skills" ]
}

if [ -n "$SOURCE_ROOT" ]; then
  looks_like_source_root "$SOURCE_ROOT" \
    || fail "--source-root must contain swarm-orca/swarm, swarm/ and skills/: $SOURCE_ROOT"
  note "using --source-root: $SOURCE_ROOT"
else
  checkout_root="$(cd "$SCRIPT_DIR/../.." && pwd)"
  checkout_parent="$(cd "$checkout_root/.." && pwd)"
  # The detected root must own *this* checkout: a sibling or renamed copy with the same layout
  # would otherwise let the script publish a different tree than the one being run.
  if looks_like_source_root "$checkout_parent" \
     && [ "$(readlink -f "$checkout_root")" = "$(readlink -f "$checkout_parent/swarm-orca")" ]; then
    SOURCE_ROOT="$checkout_parent"
    note "detected workspace root: $SOURCE_ROOT"
    note "(it provides swarm-orca/swarm, swarm/ and skills/ for this checkout)"
  elif looks_like_source_root "$checkout_parent"; then
    fail "detected workspace $checkout_parent does not own this checkout: $checkout_root
       (its swarm-orca/ is $(readlink -f "$checkout_parent/swarm-orca")); pass --source-root explicitly"
  else
    cat >&2 <<EOF
install: cannot find the workspace root that holds swarm-orca/, swarm/ and skills/.

Pass it explicitly:

  $(basename "$0") --source-root /path/to/workspace --apply

A checkout embedded as a submodule usually has it one level up; a standalone clone does not,
and then the private policy/configuration inputs must come from that workspace.
EOF
    exit "$EXIT_PRECONDITION"
  fi
  PASSTHROUGH+=(--source-root "$SOURCE_ROOT")
fi

step "control plane"
printf '\nHanding off to install-control-plane.sh (read-only unless --apply):\n'
"$INSTALLER" "${PASSTHROUGH[@]}"
status=$?

case "$status" in
  0) printf '\nDone. Next: `orca terminal create` in any project and run the readiness check\n'
     printf '      python3 -B /opt/swarm/current/code/control_plane_readiness.py --project <project>\n' ;;
  3) printf '\nNothing was written. Re-run the same command with --apply.\n' ;;
  *) : ;;
esac
exit "$status"
