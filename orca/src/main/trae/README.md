# Trae workspace trust for Swarm Workers

Fresh Trae Worker launches with `launch_source: orchestration` pre-trust their
resolved start directory before spawning the PTY. This uses the existing
`agentWorkspaceTrustEnabled` setting: absent means enabled, `false` disables it.
Manual launches, floating terminals, reattaches and restores do not get this grant.

Trae's [documented project trust configuration](https://docs.trae.cn/cli_config-file)
is a `[projects."/exact/path"]` table with `trust_level = "trusted"` in
`TRAE_HOME/traecli.toml` (default: `~/.trae/traecli.toml`). The writer runs on the
execution host and uses that host's final launch environment. SSH sends the existing
optional workspace-trust request to the relay; an older relay without the Trae
preset leaves the CLI to ask. WSL launches still ask rather than writing the
Windows host's config.

The grant never targets a filesystem root, a home or an ancestor of a home. It
stores the exact start path and its realpath, not the main checkout or a parent
workspace. It does not change hooks, approval mode, sandboxing or launch arguments.
Trae 0.209.1's dotted `-c` override does not reliably preserve dots inside quoted
path keys, so the grant uses the config file rather than command-line interpolation.

Writes are queued by canonical config path, protected by a file lock, and applied
with the existing atomic TOML writer and rolling backup. New config files use
mode `0600`; existing modes and config symlinks are preserved. Lock contention or
an expired launch deadline leaves the CLI to ask, without a late queued grant.

The content edit is deliberately append-only. Existing entries for either spelling
of the target path are preserved, including explicit `untrusted` decisions. Inline
or dotted project-map declarations, unrecognized table layouts and incomplete
multiline values are left untouched; this is not a general TOML repair facility.
Other settings and comments remain byte-for-byte intact.

Tests cover 16 concurrent grants, local and SSH spawn routing, the opt-out,
restores, broad-path refusal, config/workspace symlinks and file-lock contention.
These tests do not establish a successful live Worker run; the change must be built
and deployed before the running Orca service can use it.
