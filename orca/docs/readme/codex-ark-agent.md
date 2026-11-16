# Codex Ark terminal agent

Codex Ark is a separate `codex-ark` entry next to Codex in the agent picker and
settings. Install the launcher on the execution host and make `codex-ark`
available on its PATH. Orca does not install or start its server during detection.

The two entries share Codex's terminal input behavior, composer readiness signal,
permission-bypass flag and resume argument syntax. Commands, arguments and environment
overrides are stored under separate agent IDs; changing one does not change the other.
Existing migrated profiles receive Manual permissions for the new entry, following
Orca's new-agent policy. Fresh profiles use Orca's usual permission defaults.

The wrapper owns its configuration home, model catalog, authentication and connection.
Orca does not copy standard Codex overrides, inject `--no-daemon` or choose an OpenAI model
for Ark. Configure those provider-specific settings through the installed wrapper. The
Codex project link in settings describes the underlying CLI, not an Ark installer.

Workspace trust is the one exception: the wrapper forces
`CODEX_HOME` to its own install root, so the `[projects."<path>"] trust_level` record Orca
writes for Codex under `~/.codex` is not the one Ark reads. A fresh launch of
`codex-ark` therefore appends the same record to
`${CODEX_ARK_HOME:-<home>/.codex-ark}/config.toml` — the file the wrapper validates at
startup — before the PTY spawns, whichever surface started it (a dispatched Worker, a
workspace Orca just created, or a pane opened by hand). Answering Ark's own trust menu
writes that same record, so pre-writing it only removes the question. Reattaches and
restores still ask, a start folder that is a home or a disk root is never written, and
the `agentWorkspaceTrustEnabled` setting turns the grant off.
Orca never creates that config: an unreadable wrapper home leaves the CLI to ask, since a
config without the wrapper's provider/model/catalog keys makes `codex-ark` refuse to start.

Trusting a hand-opened pane is a deliberate product decision, accepted by the repository owner
when the orchestration-only gate was removed: what the menu writes and what this code writes are
the same record, so the only thing the gate changed was who answered. There is no per-surface or
per-launch switch — the single control is the global `agentWorkspaceTrustEnabled` setting.

The wrapper may exec a process named `codex`. Explicit Ark launch ownership is retained
when compatible process evidence arrives; an ordinary Codex process without that owner
remains Codex. Native terminal titles are left unchanged.

This integration is terminal-only. Native chat, model discovery, standard Codex history
scanning and automatic installation into a Codex-specific skills home are not enabled
for Ark. Resume command generation uses `codex-ark resume <id>` when provider-session
metadata is available; this does not add a session-ID discovery or hook integration.
Remote host-authority resume is capability-gated so older hosts use the existing
legacy-launch fallback. No new RPC or stream opcode is introduced.

The registration and launch paths are shared by folder workspaces and Git worktrees.
Unit tests cover launch planning, identity, configuration separation, settings rendering
and the resume capability. Live TUI, real model calls, SSH reconnect and Windows/macOS
launcher availability require separate verification on the target host.
