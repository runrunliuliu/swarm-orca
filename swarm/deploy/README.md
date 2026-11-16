# Deploy

| File | Purpose |
| --- | --- |
| `install.sh` | **First command on a new host.** Detects the workspace root, checks the environment, then hands off to `install-control-plane.sh` with the flags you passed. Read-only unless `--apply`. |
| `install-control-plane.sh` | The mechanism: publish, switch the pointer, manage the four skill links, verify. Two phases, rollback on failure. |
| `publish_control_plane.py` | Builds a verifiable artifact from a workspace root (`plan` / `publish` / `verify`). |
| `orca-server/` | runit definition and the safe restart helper for a headless Orca server. Not part of the control plane. |

Contract: [control-plane publish](../docs/deploy/control-plane-publish.md). The control plane is the
machine-level bundle of `code/` (orchestration and readiness tooling), `private/` (models, worker
profiles, policy), `overlay/`, the workspace policy files and the four skills; a host selects one
immutable copy through `/opt/swarm/current` and keeps its own values in
`/opt/swarm/hosts/<hostname>.json`.

## New host, in order

```bash
# 1. See the plan. Nothing is written; exit 3 means changes are pending.
swarm/deploy/install.sh --source-root /path/to/workspace

# 2. Create the host-local values once (the installer prints the template and exits 78 without it).
mkdir -p /opt/swarm/hosts                     # or --artifact-root elsewhere
$EDITOR /opt/swarm/hosts/$(hostname).json

# 3. Apply, then confirm it is idempotent.
swarm/deploy/install.sh --source-root /path/to/workspace --apply
swarm/deploy/install.sh --source-root /path/to/workspace      # exit 0, "converged"
```

`sudo` is needed once for `/opt/swarm` when it does not exist yet (`--provision`). Nothing in this
repository runs any of this automatically: installing the repository changes no host state, which is
why `install.sh` exists as the single discoverable entry point.

## Read-only checks worth knowing

```bash
swarm/deploy/install-control-plane.sh --source-root <root>            # converged or pending
python3 -B /opt/swarm/current/code/control_plane_readiness.py --project <project> --require-pin
python3 -B /opt/swarm/current/code/deploy/publish_control_plane.py verify --artifact /opt/swarm/current
```
