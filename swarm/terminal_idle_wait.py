"""Narrow adapter for the scheduler's native terminal wait protocol.

An elapsed native wait is not a failed RPC. No other command or transport
failure gets this exception to the general query decoder's strict exit rule.

The native wait duration is a parameter, not a constant: the scheduler keeps asking for its 1 s
probe (that cadence *is* the scheduler), while an agent waiting on another pane asks for one long
blocking call instead of `sleep`-then-read. `MAX_NATIVE_WAIT_MS` is the repository's 300 s
per-call policy - the CLI accepts more, and this repo chooses not to, so an interrupt stays
distinguishable from a hang. `min_rpc_timeout_seconds()` scales the RPC budget with the wait: the
11 s is the CLI's native +5 s and its own startup/return +6 s, so a longer native wait with the
old 12 s budget would be truncated by the *outer* deadline instead of expiring natively.
"""

from dataclasses import dataclass

from coordinator_io import parse
import progress_watch as watch


NATIVE_WAIT_MS = 1000
# One call, not one wait: re-enter instead of asking for a longer window (I4).
MAX_NATIVE_WAIT_MS = 300_000
# CLI terminal.wait gives the RPC the native wait plus 5000ms. Allow another
# 6000ms for CLI startup/connection/return; the outer deadline must not win.
RPC_OVERHEAD_SECONDS = 11
BLOCKED_REASONS = frozenset({
    "codex-update-prompt", "codex-trust-workspace", "codex-cwd-prompt",
    "codex-model-migration-prompt", "codex-hooks-review-prompt", "codex-interactive-prompt",
    "agent-update-prompt", "agent-trust-workspace", "agent-cwd-prompt",
    "agent-hooks-review-prompt", "agent-interactive-prompt", "agent-approval-prompt",
})


def min_rpc_timeout_seconds(wait_ms=NATIVE_WAIT_MS):
    """The outer RPC budget for a native wait of `wait_ms` (ceil to whole seconds + overhead)."""
    return -(-wait_ms // 1000) + RPC_OVERHEAD_SECONDS


MIN_RPC_TIMEOUT_SECONDS = min_rpc_timeout_seconds()


def idle_wait_args(terminal, wait_ms=NATIVE_WAIT_MS):
    if type(wait_ms) is not int or not 1 <= wait_ms <= MAX_NATIVE_WAIT_MS:
        raise ValueError("wait_ms must be an int in 1..MAX_NATIVE_WAIT_MS")
    return ["terminal", "wait", "--terminal", terminal, "--for", "tui-idle",
            "--timeout-ms", str(wait_ms)]


def _idle_wait(args):
    """(terminal, wait_ms) for exactly this command shape, or None.

    Why the shape and not "contains a tui-idle wait": this is how the monitor decides a receipt
    belongs to `decode_idle_wait` instead of the strict general decoder. Recognising a command by
    resemblance sends a receipt to the looser decoder, so every flag, its order and the handle
    checks are required, and the duration is parsed rather than assumed. It is the duration that
    varies now, not the shape: a scheduler probe and a 300 s peer wait are the same command.
    """
    if not isinstance(args, (list, tuple)) or len(args) != 8:
        return None
    if list(args[:3]) != ["terminal", "wait", "--terminal"]:
        return None
    if list(args[4:7]) != ["--for", "tui-idle", "--timeout-ms"]:
        return None
    handle = args[3]
    if (not isinstance(handle, str) or not handle
            or handle in ("active", "current") or handle.startswith("-")):
        return None
    raw = args[7]
    # Digits only: "+5", " 5", "1e3" and unicode digits are not this argument's spelling.
    if not isinstance(raw, str) or not raw.isascii() or not raw.isdigit():
        return None
    wait_ms = int(raw)
    if not 1 <= wait_ms <= MAX_NATIVE_WAIT_MS:
        return None
    # The exact argv the builder produces: no extra flag, no proxied terminal, no leading zeros.
    if list(args) != idle_wait_args(handle, wait_ms):
        return None
    return handle, wait_ms


def idle_wait_target(args):
    """The terminal of a native tui-idle wait command, of any allowed duration."""
    parsed = _idle_wait(args)
    return None if parsed is None else parsed[0]


def idle_wait_ms(args):
    """The native wait duration the command asks for, when it is that command at all."""
    parsed = _idle_wait(args)
    return None if parsed is None else parsed[1]


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
