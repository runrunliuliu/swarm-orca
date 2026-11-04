"""Explicit local TUI attribution, never a stream fallback or live process lease.

The private canonical hook mapping must match the native strict caller's public
fingerprint. Only the original Coordinator's fresh strict-caller-check can prove
current authority. Operator observation alone cannot open a mutation gate.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import subprocess

from coordinator_io import canonical, digest, parse, pinned, publish_new, timestamp
from coordinator_tui_errors import TuiError, failure, require
from coordinator_strict import caller_result
from operator_continuity_route import anchor_matches, runtime as transport_runtime
from log_io import prefix_digest, prefix_lines
from swarm_ledger import runtime_binding
from supervisor.config import SafetyError
from trae_coordinator import TUI_ADAPTER, TUI_EXECUTION, UUID, native, read_trae_runtime, verify_log


class Queries:
    environment = None

    def __init__(self, cli, runtime):
        self.cli, self.runtime_id = cli, transport_runtime(runtime)

    def read(self, *args):
        return native(self.cli, self.runtime_id, list(args))

    def verify_runtime(self):
        status = self.read("status")["runtime"]
        require(status.get("appVersion") == "1.4.219" and status.get("state") == "ready",
                "tui_runtime_unsupported")


def completed_log_turn(log):
    """Positive provider completion, never inferred from silence or an idle PTY.

    Read a finite, stable prefix. A partial append or a newer start/context makes
    the old completion unusable, including the gap before the next turn_context.
    """
    active, context, complete = None, None, None
    with runtime_binding.ordinary_file(log) as (source, info):
        sha = prefix_digest(source, info.st_size)
        source.seek(0)
        for line in prefix_lines(source, info.st_size):
            if not line.endswith(b"\n"):
                return None
            row = json.loads(line)
            require(isinstance(row, dict), "tui_turn_record_invalid")
            payload = row.get("payload", {})
            if row.get("type") == "event_msg" and payload.get("type") == "task_started":
                active, context, complete = payload.get("turn_id"), None, None
                require(isinstance(active, str) and UUID.fullmatch(active), "tui_turn_id_invalid")
            elif row.get("type") == "turn_context":
                complete = None
                context = row if active and payload.get("turn_id") == active else None
            elif row.get("type") == "event_msg" and payload.get("type") == "task_complete":
                require(active and context and payload.get("turn_id") == active,
                        "tui_turn_completion_mismatch")
                require(timestamp(context["timestamp"]) <= timestamp(row["timestamp"])
                        <= datetime.now(timezone.utc), "tui_turn_completion_time_invalid")
                complete = {"turn_id": active, "context_at": context["timestamp"],
                            "completed_at": row["timestamp"]}
        require(prefix_digest(source, info.st_size) == sha, "tui_log_history_changed")
        require(log.resolve() == log and (log.stat().st_dev, log.stat().st_ino) ==
                (info.st_dev, info.st_ino), "tui_log_replaced")
    return {**complete, "prefix_bytes": info.st_size, "prefix_sha256": sha} if complete else None


def _same_identity_runtime_rebind(before, anchor, permit, *, terminal, incarnation, workspace):
    """Allow only a proven Server epoch change for the exact same TUI binding."""
    if permit is None:
        return False
    return (isinstance(permit, dict) and isinstance(anchor, dict)
            and permit.get("schema_version") == 1
            and permit.get("kind") == "verified_same_coordinator_runtime_epoch_rebind"
            and permit.get("terminal") == terminal
            and permit.get("incarnation") == incarnation
            and permit.get("workspace") == workspace
            and anchor.get("runtime", {}).get("runtimeId") == permit.get("source_runtime")
            and before.get("runtime", {}).get("runtimeId") == permit.get("target_runtime")
            and {k: v for k, v in before.items() if k != "runtime"}
            == {k: v for k, v in anchor.items() if k != "runtime"})


def _observe(*, cli, runtime, terminal, incarnation, workspace, cwd, profile,
            caller_receipt, log_root, roots, trae_runtime_config, expected_thread=None,
            context_max_age_seconds=900, startup_anchor=None, completed_turn=False,
            caller_receipt_runtime=None, accepted_runtime_rebind=None):
    require(Path(cli).is_absolute() and Path(cli).is_file(), "verified_absolute_cli_required")
    version, execution = read_trae_runtime(trae_runtime_config)
    require(execution == TUI_EXECUTION, "explicit_tui_config_required")
    initial = caller_result(parse(pinned(caller_receipt)), caller_receipt_runtime or runtime)
    caller = initial["caller"]
    anchor = parse(pinned(startup_anchor)) if startup_anchor else None
    query = Queries(cli, runtime)
    options = dict(provider="trae", format="runtime-state", host=socket.gethostname(),
                   terminal_handle=terminal, worktree_id=workspace, profile=str(profile),
                   log_root=str(log_root), max_hook_age_seconds=86400 if completed_turn else context_max_age_seconds)
    require(not completed_turn or startup_anchor is not None, "tui_history_requires_startup_anchor")

    def snapshot():
        observed, hook = runtime_binding.observe(query, options, datetime.now(timezone.utc).timestamp())
        t = observed["terminal"]
        require(t["incarnationId"] == incarnation, "tui_incarnation_changed")
        target = query.read("worktree", "show", "--worktree", "id:" + workspace)["worktree"]
        require(target.get("id") == workspace and target.get("path") == str(cwd), "tui_workspace_changed")
        # Exactly mirrors 1.4.219 hashCanonical(OrchestrationCompatibilityCallerAuthority).
        authority = {k: caller[k] for k in ("terminalHandle", "paneKey", "processIncarnation", "hostScope")}
        authority["launchTokenHash"] = observed["launch_token_hash"]
        require(caller["terminalHandle"] == terminal
                and caller["paneKey"] == t["tabId"] + ":" + t["leafId"]
                and caller["processIncarnation"] == t["ptyId"] + ":" + incarnation
                and caller["hostScope"].get("kind") == "local"
                and digest(canonical(authority)) == caller["authorityFingerprint"],
                "tui_hook_strict_caller_mismatch")
        require(UUID.fullmatch(observed["session_id"]) is not None, "tui_invalid_session")
        return observed, hook

    before, hook = snapshot()
    sid = before["session_id"]
    require(expected_thread is None or sid == expected_thread, "tui_session_changed")
    if anchor is None:
        age = (datetime.now(timezone.utc) - timestamp(initial["checkedAt"])).total_seconds()
        require(0 <= age <= context_max_age_seconds, "tui_initial_caller_stale")
    else:
        binding = anchor.get("binding")
        require(anchor.get("schema_version") == 1 and anchor.get("kind") == "trae_tui_startup_anchor"
                and anchor.get("adapter") == TUI_ADAPTER
                and (anchor_matches(before, binding) or _same_identity_runtime_rebind(
                    before, binding, accepted_runtime_rebind,
                    terminal=terminal, incarnation=incarnation, workspace=workspace))
                and anchor.get("caller_receipt") == caller_receipt
                and anchor.get("thread_id") == expected_thread == sid, "tui_anchor_identity_changed")
        require(all(type(anchor.get("hook", {}).get(k)) in (int, float)
                    and hook[k] >= anchor["hook"][k] for k in hook), "tui_hook_regressed")
    log = Path(before["transcript_path"])
    ended = completed_log_turn(log) if completed_turn else None
    if completed_turn and ended is None:
        return None
    history = ({"now": timestamp(ended["completed_at"]),
                "max_age": (timestamp(ended["completed_at"]) - timestamp(ended["context_at"])).total_seconds()}
               if ended else {"max_age": context_max_age_seconds})
    evidence = verify_log(log, thread_id=sid, cwd=cwd, roots=roots, execution=execution,
                          cli_version=version, **history)
    if ended:
        require(all(evidence[k] == ended[k] for k in ("prefix_bytes", "prefix_sha256"))
                and evidence["observed_at"] == ended["context_at"], "tui_turn_changed_during_observation")
    if anchor:
        require(all(anchor.get(k) == evidence[k] for k in ("log_path", "log_device", "log_inode"))
                and type(anchor.get("prefix_bytes")) is int
                and 0 < anchor["prefix_bytes"] <= evidence["prefix_bytes"], "tui_log_replaced_or_truncated")
        with runtime_binding.ordinary_file(log) as (source, info):
            require((info.st_dev, info.st_ino) == (evidence["log_device"], evidence["log_inode"])
                    and prefix_digest(source, anchor["prefix_bytes"]) == anchor.get("prefix_sha256"),
                    "tui_log_history_changed")
        require(log.resolve() == log and (log.stat().st_dev, log.stat().st_ino) ==
                (evidence["log_device"], evidence["log_inode"]), "tui_log_replaced")
        pinned(startup_anchor)
    after, after_hook = snapshot()
    require(after == before and all(after_hook[k] >= hook[k] for k in hook), "tui_identity_or_hook_changed")
    pinned(caller_receipt)
    # I/O does not renew the original turn-context timestamp. It may have expired
    # while checking the history/hook even though verify_log initially passed.
    from trae_coordinator import ContextFreshnessError
    age = (datetime.now(timezone.utc) - timestamp(evidence["observed_at"])).total_seconds()
    if not completed_turn and not 0 <= age <= context_max_age_seconds:
        raise ContextFreshnessError(age, context_max_age_seconds)
    return {**evidence, "schema_version": 1, "adapter": TUI_ADAPTER,
            **({"completed_turn": ended} if ended else {}),
            "kind": ("trae_tui_completed_turn_observation" if completed_turn else
                     "trae_tui_session_observation" if anchor else "trae_tui_startup_anchor"),
            "runtime_id": query.runtime_id, "binding": before, "hook": after_hook,
            "caller_receipt": caller_receipt,
            "trust": "runtime-state-and-log-not-live-process-attested",
            "requires_live_caller_check": True, "execution_authorized": False}


def observe(**kwargs):
    try:
        return _observe(**kwargs)
    except SafetyError as exc:
        # The shared ledger reader uses a separate exception family. Normalize
        # it so all startup/CLI callers fail closed without exporting raw state.
        # Export only this exact known code, never arbitrary SafetyError text.
        code = ("tui_hook_stale_or_future" if str(exc) == "runtime_state_stale_or_future_hook"
                else "tui_runtime_state_unverifiable")
        raise TuiError(code) from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cli", "runtime", "terminal", "incarnation", "workspace", "cwd", "profile",
                 "caller-receipt", "caller-sha256", "log-root", "trae-runtime-config"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--root", action="append", dest="roots", default=[])
    parser.add_argument("--expected-thread")
    parser.add_argument("--startup-anchor")
    parser.add_argument("--startup-anchor-sha256")
    parser.add_argument("--save-startup-anchor", type=Path)
    args = vars(parser.parse_args(argv))
    try:
        args["caller_receipt"] = {"path": args["caller_receipt"], "sha256": args.pop("caller_sha256")}
        anchor, sha = args.pop("startup_anchor"), args.pop("startup_anchor_sha256")
        output = args.pop("save_startup_anchor")
        require(bool(anchor) == bool(sha) and not (anchor and output), "tui_anchor_pin_required")
        result = observe(**args, startup_anchor={"path": anchor, "sha256": sha} if anchor else None)
        if output:
            require(output.is_absolute() and output.parent.resolve() == output.parent, "tui_output_path_invalid")
            publish_new(output, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        print(json.dumps(failure(exc, "tui_observation_failed")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
