#!/usr/bin/env bash
# Install the swarm control plane on this host, idempotently, and prove it afterwards.
#
# The artifact stays portable; this script only manages three host-side facts:
#   * one published artifact under --artifact-root, selected by an atomic pointer switch;
#   * the four skill links, pointing at <pointer>/code/skills/<name>;
#   * a host-local values file that this script validates but never invents.
#
# Two phases, so a bad artifact never becomes current:
#   A. publish without touching the pointer, then verify the artifact and run readiness against
#      it explicitly (control plane + configs + host override + its own skills).
#   B. commit: switch the pointer, update the links, then run readiness again through the
#      installed paths. Any failure in B rolls the pointer and the links back.
#
# Read-only unless --apply. Both modes print the same plan, so a dry run is real evidence.
# Exit codes: 0 converged, 3 changes would be made (read-only mode), 78 a precondition failed.
set -uo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PUBLISHER="$SCRIPT_DIR/publish_control_plane.py"
readonly SKILLS=(orca-cli orchestration swarm-orchestration worktree-delivery)
readonly EXIT_CHANGES=3
readonly EXIT_PRECONDITION=78

SOURCE_ROOT=""
ARTIFACT_ROOT="${SWARM_ARTIFACT_ROOT:-/opt/swarm}"
POINTER=""
SKILLS_DIR="${SWARM_SKILLS_DIR:-$HOME/.agents/skills}"
HOST_OVERRIDE=""
APPLY=0
PROVISION=0
ALLOW_DIRTY=0
ALLOW_UNPINNED=0
SKIP_SKILLS=0
FORCE_LINKS=0
WORK=""

fail() { printf 'install-control-plane: %s\n' "$*" >&2; exit "$EXIT_PRECONDITION"; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: install-control-plane.sh --source-root <dir> [--artifact-root <dir>] [--pointer <path>]
                                [--skills-dir <dir>] [--host-override <path>]
                                [--apply] [--check] [--provision] [--allow-dirty]
                                [--allow-unpinned-source] [--skip-skills] [--force-links] [--help]

  --source-root <dir>      checkout holding swarm-orca/, swarm/ and skills/ (required)
  --artifact-root <dir>    where artifacts live (default /opt/swarm)
  --pointer <path>         pointer symlink (default <artifact-root>/current)
  --skills-dir <dir>       skill directory to manage (default ~/.agents/skills)
  --host-override <path>   host-local values (default <artifact-root>/hosts/<hostname>.json)
  --apply                  write; without it the script only reports the plan
  --check                  explicit alias for the read-only default (no writing)
  --provision              create <artifact-root> with sudo when it is missing
  --allow-dirty            publish a modified source (the artifact is then not a pin source)
  --allow-unpinned-source  publish when git cannot describe the source tree
  --skip-skills            do not manage the four skill links
  --force-links            replace skill symlinks that this installer does not manage
USAGE
}

require_value() {
  local flag="$1" value="${2:-}"
  [ -n "$value" ] || fail "$flag requires a value"
  case "$value" in --*) fail "$flag requires a value, got option $value" ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-root) require_value "$1" "${2:-}"; SOURCE_ROOT="$2"; shift 2 ;;
    --artifact-root) require_value "$1" "${2:-}"; ARTIFACT_ROOT="$2"; shift 2 ;;
    --pointer) require_value "$1" "${2:-}"; POINTER="$2"; shift 2 ;;
    --skills-dir) require_value "$1" "${2:-}"; SKILLS_DIR="$2"; shift 2 ;;
    --host-override) require_value "$1" "${2:-}"; HOST_OVERRIDE="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --check) APPLY=0; shift ;;
    --provision) PROVISION=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --allow-unpinned-source) ALLOW_UNPINNED=1; shift ;;
    --skip-skills) SKIP_SKILLS=1; shift ;;
    --force-links) FORCE_LINKS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

POINTER="${POINTER:-$ARTIFACT_ROOT/current}"
HOST_OVERRIDE="${HOST_OVERRIDE:-$ARTIFACT_ROOT/hosts/$(hostname).json}"

command -v python3 >/dev/null 2>&1 || fail "python3 not found"
[ -f "$PUBLISHER" ] || fail "publisher missing next to this script: $PUBLISHER"
[ -n "$SOURCE_ROOT" ] || fail "--source-root is required (a checkout holding swarm-orca/, swarm/ and skills/)"
[ -d "$SOURCE_ROOT" ] || fail "source root is not a directory: $SOURCE_ROOT"

publisher() { python3 -B "$PUBLISHER" "$@"; }
cleanup_work() { [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK"; }

# ---------------------------------------------------------------- rollback

ROLLBACK_ARMED=0
POINTER_EXISTED=0
PREVIOUS_POINTER=""
PREVIOUS_LINKS=()
CREATED_LINKS=()
PREVIOUS_TEMP=()

temp_link_for() {
  # A unique directory in the destination's parent: `ln -s` into it cannot collide, and the
  # rename target stays on the same filesystem.
  local destination="$1"
  mktemp -d "$(dirname "$destination")/.install-cp.XXXXXX"
}

link_atomically() {
  # Args: <link path> <target>. Never uses `ln -f`: an existing directory at the temp path would
  # make `ln` succeed by nesting the link inside it and the rename would then fail.
  local path="$1" target="$2" holder temp
  holder="$(temp_link_for "$path")" || return 1
  temp="$holder/link"
  if ! ln -s "$target" "$temp"; then rm -rf "$holder"; return 1; fi
  if [ ! -L "$temp" ]; then rm -rf "$holder"; return 1; fi
  if ! mv -Tf "$temp" "$path"; then rm -rf "$holder"; return 1; fi
  rmdir "$holder" 2>/dev/null || true
  return 0
}

rollback() {
  local status=$?
  [ "$ROLLBACK_ARMED" = 1 ] || { cleanup_work; return 0; }
  ROLLBACK_ARMED=0
  printf 'install-control-plane: rolling back\n' >&2
  for entry in "${PREVIOUS_LINKS[@]+"${PREVIOUS_LINKS[@]}"}"; do
    link_atomically "${entry%%|*}" "${entry#*|}" \
      && printf '  restored %s -> %s\n' "${entry%%|*}" "${entry#*|}" >&2
  done
  for entry in "${CREATED_LINKS[@]+"${CREATED_LINKS[@]}"}"; do
    [ -L "$entry" ] && rm -f "$entry" && printf '  removed %s\n' "$entry" >&2
  done
  if [ "$POINTER_EXISTED" = 1 ]; then
    link_atomically "$POINTER" "$PREVIOUS_POINTER" \
      && printf '  pointer restored to %s\n' "$PREVIOUS_POINTER" >&2
  else
    [ -L "$POINTER" ] && rm -f "$POINTER" && printf '  pointer removed (it did not exist before)\n' >&2
  fi
  cleanup_work
  return "$status"
}
trap rollback EXIT

# ---------------------------------------------------------------- plan

step "plan"
plan_json="$(publisher plan --source-root "$SOURCE_ROOT" --json)" || fail "publisher plan failed"
read -r build_id dirty unpinned < <(printf '%s' "$plan_json" | python3 -c '
import json, sys
report = json.load(sys.stdin)
source = report["source"]
print(report["buildId"], source.get("dirty"), bool(source.get("unpinned")))')
note "buildId:   $build_id"
note "source:    dirty=$dirty unpinned=$unpinned"
note "artifact:  $ARTIFACT_ROOT/swarm-control-plane-$build_id"
note "pointer:   $POINTER"
note "override:  $HOST_OVERRIDE"

# ---------------------------------------------------------------- preconditions

step "preconditions"
if [ "$dirty" = "True" ] && [ "$ALLOW_DIRTY" = 0 ]; then
  fail "source is dirty; commit it or pass --allow-dirty (a dirty artifact is not a pin source)"
fi
if [ "$unpinned" = "True" ] && [ "$ALLOW_UNPINNED" = 0 ]; then
  fail "git cannot describe the source; pass --allow-unpinned-source to publish anyway"
fi
if [ ! -d "$ARTIFACT_ROOT" ] && [ "$PROVISION" = 0 ]; then
  fail "artifact root is missing: $ARTIFACT_ROOT (pass --provision to create it with sudo)"
fi
[ -d "$ARTIFACT_ROOT" ] && [ ! -w "$ARTIFACT_ROOT" ] \
  && fail "artifact root is not writable by $(id -un): $ARTIFACT_ROOT"

if [ ! -f "$HOST_OVERRIDE" ]; then
  cat >&2 <<EOF
install-control-plane: host override missing: $HOST_OVERRIDE

Write it first; this script will not guess host paths:

{
  "schemaVersion": 1,
  "label": "<host label>",
  "hostnames": ["$(hostname)"],
  "verifiedOn": "$(date -u +%Y-%m-%d)",
  "paths": {
    "worktreeBase": "/absolute/worktree/base",
    "artifactRoot": "$ARTIFACT_ROOT",
    "serverCli": "/absolute/executable/orca-server-cli"
  },
  "runtime": {"default": "<runtime name>", "legacy": "<runtime name>"},
  "projectSetups": {"<repo name>": "<setup id>"}
}
EOF
  exit "$EXIT_PRECONDITION"
fi

# Validate the host override before anything is written. Only possible when a control plane is
# already installed; a first install is covered by the phase-A probe on the new artifact.
if [ -L "$POINTER" ] && [ -d "$(readlink -f "$POINTER" 2>/dev/null)" ]; then
  installed="$(readlink -f "$POINTER")"
  python3 -B "$installed/code/control_plane_readiness.py" --project "$SOURCE_ROOT" \
    --control-plane "$installed" --require-host-override --host-override "$HOST_OVERRIDE" \
    --skills-dir "$SKILLS_DIR" >/dev/null \
    || fail "pre-flight check failed against the installed control plane (host override, skills or configs): $HOST_OVERRIDE"
  note "host override and installed skills validated before writing"
fi

# ---------------------------------------------------------------- artifact

step "artifact"
artifact="$ARTIFACT_ROOT/swarm-control-plane-$build_id"
needs_publish=1
changes=0
if [ -d "$artifact" ]; then
  if publisher verify --artifact "$artifact" >/dev/null 2>&1; then
    needs_publish=0
    note "already published and verified: $(basename "$artifact")"
  else
    fail "artifact exists but does not verify: $artifact"
  fi
else
  note "will publish $(basename "$artifact")"
  changes=$((changes + 1))
fi

# ---------------------------------------------------------------- skills

step "skills"
skill_changes=()
if [ "$SKIP_SKILLS" = 1 ]; then
  note "skipped (--skip-skills)"
elif [ ! -d "$SKILLS_DIR" ]; then
  fail "skills directory missing: $SKILLS_DIR"
else
  for name in "${SKILLS[@]}"; do
    entry="$SKILLS_DIR/$name"
    wanted="$POINTER/code/skills/$name"
    if [ -L "$entry" ]; then
      current="$(readlink "$entry")"
      if [ "$current" = "$wanted" ]; then
        note "$name: ok"
        continue
      fi
      case "$current" in
        "$ARTIFACT_ROOT"/*|"$ARTIFACT_ROOT") note "$name: will follow $wanted (was $current)" ;;
        *)
          if [ "$FORCE_LINKS" = 0 ]; then
            fail "$name points at a link this installer does not manage: $current (pass --force-links)"
          fi
          note "$name: will replace unmanaged link $current"
          ;;
      esac
    elif [ -e "$entry" ]; then
      fail "$name exists and is not a symlink; refusing to replace it: $entry"
    else
      note "$name: will create $wanted"
    fi
    skill_changes+=("$name")
    changes=$((changes + 1))
  done
fi

# ---------------------------------------------------------------- verdict

step "verdict"
if [ "$changes" -eq 0 ]; then
  note "converged; nothing to do"
  exit 0
fi
note "$changes change(s) required"
if [ "$APPLY" = 0 ]; then
  note "read-only: pass --apply to perform them"
  exit "$EXIT_CHANGES"
fi

# ---------------------------------------------------------------- phase A: never touch the pointer

step "phase A: publish and prove the artifact"
if [ "$PROVISION" = 1 ] && [ ! -d "$ARTIFACT_ROOT" ]; then
  sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" "$ARTIFACT_ROOT" \
    || fail "provisioning failed: $ARTIFACT_ROOT"
  note "created $ARTIFACT_ROOT"
fi

if [ "$needs_publish" = 1 ]; then
  publish_args=(publish --source-root "$SOURCE_ROOT" --artifact-root "$ARTIFACT_ROOT")
  [ "$ALLOW_DIRTY" = 1 ] && publish_args+=(--allow-dirty)
  [ "$ALLOW_UNPINNED" = 1 ] && publish_args+=(--allow-unpinned-source)
  publisher "${publish_args[@]}" || fail "publish failed"
fi
publisher verify --artifact "$artifact" >/dev/null || fail "artifact does not verify: $artifact"
note "artifact verified"

readiness=(python3 -B "$artifact/code/control_plane_readiness.py")
probe=(--require-host-override --host-override "$HOST_OVERRIDE" --control-plane "$artifact"
       --skills-dir "$artifact/code/skills")
if [ "$dirty" = "True" ] || [ "$unpinned" = "True" ]; then
  note "pin check skipped for the artifact probe: dirty=$dirty unpinned=$unpinned"
else
  probe+=(--require-pin)
fi
"${readiness[@]}" --project "$SOURCE_ROOT" "${probe[@]}" >/dev/null \
  || fail "artifact failed the readiness probe (nothing was changed on this host)"
note "artifact passed the readiness probe"

# ---------------------------------------------------------------- phase B: commit with rollback

step "phase B: switch and link"
if [ -L "$POINTER" ]; then
  POINTER_EXISTED=1
  PREVIOUS_POINTER="$(readlink "$POINTER")"
fi
WORK="$(mktemp -d)"
ROLLBACK_ARMED=1

if [ "$(readlink "$POINTER" 2>/dev/null)" != "$artifact" ]; then
  link_atomically "$POINTER" "$artifact" || fail "pointer switch failed"
  note "pointer -> $artifact"
else
  note "pointer already at $artifact"
fi

if [ "$SKIP_SKILLS" = 0 ]; then
  for name in "${skill_changes[@]+"${skill_changes[@]}"}"; do
    entry="$SKILLS_DIR/$name"
    wanted="$POINTER/code/skills/$name"
    if [ -L "$entry" ]; then
      PREVIOUS_LINKS+=("$entry|$(readlink "$entry")")
    else
      CREATED_LINKS+=("$entry")
    fi
    link_atomically "$entry" "$wanted" || fail "linking $name failed"
    note "$name -> $(readlink "$entry")"
  done
fi

step "verify"
verify_skills="$SKILLS_DIR"
# With --skip-skills the links are somebody else's business: verify the artifact's own skills.
[ "$SKIP_SKILLS" = 1 ] && verify_skills="$POINTER/code/skills"
probe=(--project "$SOURCE_ROOT" --require-host-override --host-override "$HOST_OVERRIDE"
       --skills-dir "$verify_skills")
if [ "$dirty" = "True" ] || [ "$unpinned" = "True" ]; then
  note "pin check skipped: this artifact is not a pin source (dirty=$dirty unpinned=$unpinned)"
else
  probe+=(--require-pin)
fi
python3 -B "$POINTER/code/control_plane_readiness.py" "${probe[@]}" || fail "readiness failed after the switch"

ROLLBACK_ARMED=0
cleanup_work
note "ready"
exit 0
