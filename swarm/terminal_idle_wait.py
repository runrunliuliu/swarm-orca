"""Narrow adapter for the scheduler's native terminal wait protocol.

An elapsed native wait is not a failed RPC. No other command or transport
failure gets this exception to the general query decoder's strict exit rule.
"""

from dataclasses import dataclass

from coordinator_io import parse
import progress_watch as watch


NATIVE_WAIT_MS = 1000
# CLI terminal.wait gives the RPC the native wait plus 5000ms. Allow another
# 6000ms for CLI startup/connection/return; the outer deadline must not win.
MIN_RPC_TIMEOUT_SECONDS = 12
BLOCKED_REASONS = frozenset({
    "codex-update-prompt", "codex-trust-workspace", "codex-cwd-prompt",
    "codex-model-migration-prompt", "codex-hooks-review-prompt", "codex-interactive-prompt",
    "agent-update-prompt", "agent-trust-workspace", "agent-cwd-prompt",
    "agent-hooks-review-prompt", "agent-interactive-prompt", "agent-approval-prompt",
})


def idle_wait_args(terminal):
    return ["terminal", "wait", "--terminal", terminal, "--for", "tui-idle",
            "--timeout-ms", str(NATIVE_WAIT_MS)]


def idle_wait_target(args):
    """Only the explicit, fixed-duration scheduler command, without extra flags."""
    if (len(args) == 8 and isinstance(args[3], str) and args[3]
            and args[3] not in ("active", "current") and not args[3].startswith("-")
            and list(args) == idle_wait_args(args[3])):
        return args[3]
    return None


@dataclass(frozen=True)
class IdleWaitResult:
    state: str
    reason: str | None = None


def require(condition, reason="tui_idle_response_invalid"):
    if not condition:
        raise watch.StopObservation(reason)


def decode_idle_wait(raw, code, runtime, terminal):
    try:
        data = parse(raw)
    except (ValueError, UnicodeError):
        raise watch.StopObservation("query_invalid_json") from None
    require(isinstance(data, dict) and type(data.get("ok")) is bool)
    meta = data.get("_meta")
    require(isinstance(meta, dict) and meta.get("runtimeId") == runtime, "runtime_mismatch")
    require(type(code) is int)
    if not data["ok"]:
        error = data.get("error")
        require(isinstance(error, dict) and isinstance(error.get("code"), str)
                and isinstance(error.get("message"), str) and "result" not in data)
        if code == 1 and error["code"] == "timeout":
            # No idle/terminal-identity evidence in this envelope. The caller
            # must fence the bound Run and both terminals again before pausing.
            return IdleWaitResult("pending", "tui_idle_timeout")
        return watch.decode_response(raw, code, runtime)  # always raises
    require("error" not in data and isinstance(data.get("result"), dict))
    wait = data["result"].get("wait")
    require(isinstance(wait, dict) and wait.get("handle") == terminal
            and wait.get("condition") == "tui-idle", "tui_idle_target_mismatch")
    require(type(wait.get("satisfied")) is bool
            and isinstance(wait.get("status"), str)
            and wait["status"] in ("running", "exited", "unknown")
            and "exitCode" in wait
            and (wait["exitCode"] is None or type(wait["exitCode"]) is int))
    require(wait["status"] == "running" and wait["exitCode"] is None
            and wait.get("exitCause") is None, "tui_idle_terminal_not_running")
    if wait["satisfied"]:
        require(code == 0 and "blockedReason" not in wait)
        return IdleWaitResult("ready")
    reason = wait.get("blockedReason")
    require(code == 1 and isinstance(reason, str) and reason in BLOCKED_REASONS)
    return IdleWaitResult("interaction_required", reason)
