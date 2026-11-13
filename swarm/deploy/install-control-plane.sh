#!/usr/bin/env bash
# Install the swarm control plane on this host, idempotently, and prove it afterwards.
#
# The artifact stays portable; this script only manages the three host-side facts:
#   * one published artifact under --artifact-root, selected by an atomic pointer switch;
#   * the four skill links, pointing at <pointer>/code/skills/<name>;
#   * a host-local values file that this script validates but never invents.
#
# Read-only by default. `--apply` writes. Both modes print the same plan, so a dry run is real
# evidence rather than a different code path.
#
# Exit codes: 0 converged, 3 changes would be made (--check only), 78 a precondition failed.
#
# Safety: a dirty source is refused unless --allow-dirty; an existing non-symlink skill entry is
# refused rather than replaced; a missing host override stops with a template instead of guessing
# paths; if the post-install readiness check fails, the pointer is switched back.
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
# Test seam: the post-install probe. Unset means "run the real readiness check".
PROBE="${SWARM_INSTALL_PROBE:-}"

fail() { printf 'install-control-plane: %s\n' "$*" >&2; exit "$EXIT_PRECONDITION"; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
changes=0

usage() {
  cat <<'USAGE'
Usage: install-control-plane.sh [--source-root <dir>] [--artifact-root <dir>] [--pointer <path>]
                                [--skills-dir <dir>] [--host-override <path>]
                                [--apply] [--provision] [--allow-dirty] [--allow-unpinned-source]
                                [--skip-skills] [--help]

  --source-root <dir>   checkout holding swarm-orca/, swarm/ and skills/ (required)
  --artifact-root <dir> where artifacts live (default /opt/swarm)
  --pointer <path>      pointer symlink (default <artifact-root>/current)
  --skills-dir <dir>    skill directory to manage (default ~/.agents/skills)
  --host-override <p>   host-local values (default <artifact-root>/hosts/<hostname>.json)
  --apply               write; without it the script only reports the plan
  --provision           create <artifact-root> with sudo when it is missing
  --allow-dirty         publish a modified source (the artifact is then not a pin source)
  --allow-unpinned-source  publish when git cannot describe the source tree
  --skip-skills         do not manage the four skill links
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --artifact-root) ARTIFACT_ROOT="${2:-}"; shift 2 ;;
    --pointer) POINTER="${2:-}"; shift 2 ;;
    --skills-dir) SKILLS_DIR="${2:-}"; shift 2 ;;
    --host-override) HOST_OVERRIDE="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --provision) PROVISION=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --allow-unpinned-source) ALLOW_UNPINNED=1; shift ;;
    --skip-skills) SKIP_SKILLS=1; shift ;;
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
if [ ! -d "$ARTIFACT_ROOT" ]; then
  if [ "$PROVISION" = 0 ]; then
    fail "artifact root is missing: $ARTIFACT_ROOT (pass --provision to create it with sudo)"
  fi
  note "artifact root missing, --provision given"
  changes=$((changes + 1))
fi
[ -d "$ARTIFACT_ROOT" ] && [ ! -w "$ARTIFACT_ROOT" ] \
  && fail "artifact root is not writable by $(id -un): $ARTIFACT_ROOT"

# The override is never invented: print the shape and stop, so the operator supplies host facts.
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

# ---------------------------------------------------------------- artifact

step "artifact"
artifact="$ARTIFACT_ROOT/swarm-control-plane-$build_id"
needs_publish=1
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
else
  [ -d "$SKILLS_DIR" ] || fail "skills directory missing: $SKILLS_DIR"
  for name in "${SKILLS[@]}"; do
    entry="$SKILLS_DIR/$name"
    wanted="$POINTER/code/skills/$name"
    if [ -L "$entry" ]; then
      current="$(readlink "$entry")"
      if [ "$current" = "$wanted" ]; then
        note "$name: ok"
        continue
      fi
      note "$name: will point at $wanted (was $current)"
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
  [ "$APPLY" = 1 ] || exit 0
else
  note "$changes change(s) required"
  if [ "$APPLY" = 0 ]; then
    note "dry run: pass --apply to perform them"
    exit "$EXIT_CHANGES"
  fi
fi

# ---------------------------------------------------------------- apply

set_pointer() {
  local target="$1" temporary="$POINTER.new-$$"
  ln -sfn "$target" "$temporary" && mv -Tf "$temporary" "$POINTER"
}

previous_target=""
if [ -L "$POINTER" ]; then
  previous_target="$(readlink "$POINTER")"
fi

if [ "$PROVISION" = 1 ] && [ ! -d "$ARTIFACT_ROOT" ]; then
  step "provision"
  sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" "$ARTIFACT_ROOT" \
    || fail "provisioning failed: $ARTIFACT_ROOT"
  note "created $ARTIFACT_ROOT"
fi

if [ "$needs_publish" = 1 ]; then
  step "publish"
  publish_args=(publish --source-root "$SOURCE_ROOT" --artifact-root "$ARTIFACT_ROOT"
                --switch-pointer "$POINTER")
  [ "$ALLOW_DIRTY" = 1 ] && publish_args+=(--allow-dirty)
  [ "$ALLOW_UNPINNED" = 1 ] && publish_args+=(--allow-unpinned-source)
  publisher "${publish_args[@]}" || fail "publish failed"
fi

if [ "$SKIP_SKILLS" = 0 ] && [ "${#skill_changes[@]}" -gt 0 ]; then
  step "link skills"
  for name in "${skill_changes[@]}"; do
    entry="$SKILLS_DIR/$name"
    temporary="$entry.new-$$"
    ln -sfn "$POINTER/code/skills/$name" "$temporary" || fail "link failed: $name"
    mv -Tf "$temporary" "$entry" || fail "replacing link failed: $name"
    note "$name -> $(readlink "$entry")"
  done
fi

# ---------------------------------------------------------------- prove it

step "verify"
if [ -n "$PROBE" ]; then
  # Test seam: the probe stands in for the readiness tool and reports its own exit status.
  "$PROBE" || probe_status=$?
  probe_status="${probe_status:-0}"
else
  probe_args=(--project "$SOURCE_ROOT" --require-host-override
              --host-override "$HOST_OVERRIDE" --skills-dir "$SKILLS_DIR")
  # A dirty or unpinned publication is a trial artifact by definition; demanding a pin would make
  # --allow-dirty unusable. Say so instead of silently weakening the check.
  if [ "$dirty" = "True" ] || [ "$unpinned" = "True" ]; then
    note "pin check skipped: this artifact is not a pin source (dirty=$dirty unpinned=$unpinned)"
  else
    probe_args+=(--require-pin)
  fi
  python3 -B "$POINTER/code/control_plane_readiness.py" "${probe_args[@]}" || probe_status=$?
  probe_status="${probe_status:-0}"
fi

if [ "$probe_status" -ne 0 ]; then
  printf 'install-control-plane: readiness failed (exit %s)\n' "$probe_status" >&2
  if [ -n "$previous_target" ]; then
    set_pointer "$previous_target" && printf '  pointer restored to %s\n' "$previous_target" >&2
  else
    printf '  no previous pointer to restore\n' >&2
  fi
  exit "$probe_status"
fi

note "ready"
exit 0
