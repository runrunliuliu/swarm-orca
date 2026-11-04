"""Read-only native sender preflight, shared with the execution-time self fence."""

from coordinator_io import require


def preflight(sender, runtime, call):
    """Observe the target only; this never proves the caller owns that terminal."""
    require(isinstance(sender, dict) and set(sender) == {"terminal", "incarnation", "workspace"}
            and all(isinstance(v, str) and v.strip() for v in sender.values()),
            "invalid_monitor_sender")
    terminal = call(["terminal", "show", "--terminal", sender["terminal"]], runtime).get("terminal", {})
    require(all(terminal.get(k) == sender[v] for k, v in (
                ("handle", "terminal"), ("incarnationId", "incarnation"), ("worktreeId", "workspace")))
            and terminal.get("connected") is True and terminal.get("orphaned") is False
            # RuntimeTerminalSummary.agentIdentity is optional in 1.4.219:
            # shell summaries omit it. Keep the execution-time caller fence.
            and terminal.get("agentIdentity") is None
            and all(isinstance(terminal.get(k), str) and terminal[k] for k in ("tabId", "leafId")),
            "monitor_operator_terminal_unverifiable")
    return {k: terminal[k] for k in ("handle", "incarnationId", "worktreeId", "tabId", "leafId")}
