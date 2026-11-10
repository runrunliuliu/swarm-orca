"""Pi TUI session attribution for the strict Coordinator gate.

Pi writes a JSONL transcript (root `{"type":"session","id":<uuid>,"cwd":…}`,
per-turn assistant `model`/`provider`/`thinkingLevel`) and Orca's bundled Pi
status extension publishes the pane's `session_id`/`session_file`/launch token to
`/hook/pi`. This observer joins those two facts to the live process through the
same `runtime_binding` capture the Trae reader uses, and verifies the reviewed Pi
runtime policy against the transcript's newest turn.

It is not a weaker reader with a different shape: the returned observation has the
same keys as the Trae one, so the strict contract, the caller fingerprint check
and the anchor rules stay identical. What Pi genuinely cannot attest is stated by
`pi_policy` (no sandbox/approval/network fields), never invented here.
"""

from datetime import datetime, timezone
from pathlib import Path
import socket

from coordinator_io import canonical, digest, parse, pinned, timestamp
from coordinator_tui_errors import TuiError, require
from coordinator_strict import caller_result
from log_io import prefix_digest
import pi_policy as policy_reader
import pi_transcript
from trae_coordinator import ContextFreshnessError, UUID
from trae_tui import Queries
from swarm_ledger import runtime_binding
from supervisor.config import SafetyError
from tui_adapter import PI_ADAPTER


def _snapshot(query, options, *, incarnation, workspace, cwd, caller, terminal):
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


def _observe(*, cli, runtime, terminal, incarnation, workspace, cwd, profile, log_root, roots,
             caller_receipt, pi_policy, expected_thread=None,
             context_max_age_seconds=900, startup_anchor=None,
             caller_receipt_runtime=None):
    require(Path(cli).is_absolute() and Path(cli).is_file(), "verified_absolute_cli_required")
    policy = policy_reader.read_ref(pi_policy)
    initial = caller_result(parse(pinned(caller_receipt)), caller_receipt_runtime or runtime)
    caller = initial["caller"]
    anchor = parse(pinned(startup_anchor)) if startup_anchor else None
    query = Queries(cli, runtime)
    options = dict(provider="pi", format="runtime-state", host=socket.gethostname(),
                   terminal_handle=terminal, worktree_id=workspace, profile=str(profile),
                   log_root=str(log_root), max_hook_age_seconds=context_max_age_seconds,
                   require_launch_commitment=True)
    # The reviewed write roots are declared inputs; Pi exposes no sandbox policy,
    # so this reader never claims to have observed them.
    require(isinstance(roots, list) and roots, "invalid_write_roots")

    def snapshot():
        return _snapshot(query, options, incarnation=incarnation, workspace=workspace,
                         cwd=cwd, caller=caller, terminal=terminal)

    before, hook = snapshot()
    sid = before["session_id"]
    require(expected_thread is None or sid == expected_thread, "tui_session_changed")
    if anchor is None:
        age = (datetime.now(timezone.utc) - timestamp(initial["checkedAt"])).total_seconds()
        require(0 <= age <= context_max_age_seconds, "tui_initial_caller_stale")
    else:
        binding = anchor.get("binding")
        require(anchor.get("schema_version") == 1 and anchor.get("kind") == "pi_tui_startup_anchor"
                and anchor.get("adapter") == PI_ADAPTER and before == binding
                and anchor.get("caller_receipt") == caller_receipt
                and anchor.get("thread_id") == expected_thread == sid, "tui_anchor_identity_changed")
        require(all(type(anchor.get("hook", {}).get(k)) in (int, float)
                    and hook[k] >= anchor["hook"][k] for k in hook), "tui_hook_regressed")
        require(policy_reader.settings(policy) == anchor.get("policy")
                and anchor.get("policy_ref") == pi_policy, "pi_runtime_policy_changed")
    log = Path(before["transcript_path"])
    evidence = pi_transcript.read(log)
    require(evidence["session_id"] == sid, "tui_session_changed")
    require(evidence["cwd"] == str(cwd), "actual session metadata mismatch")
    observed = {"model_provider": evidence["effective"]["model_provider"],
                "model": evidence["effective"]["model"],
                "thinking_level": evidence["effective"]["thinking_level"]}
    require(observed == policy_reader.settings(policy), "actual session settings mismatch")
    if anchor:
        require(all(anchor.get(key) == value for key, value in
                    (("log_path", str(log)), ("log_device", evidence["file_identity"]["device"]),
                     ("log_inode", evidence["file_identity"]["inode"]))),
                "tui_log_replaced_or_truncated")
        require(type(anchor.get("prefix_bytes")) is int
                and 0 < anchor["prefix_bytes"] <= evidence["prefix"]["bytes"],
                "tui_log_replaced_or_truncated")
        with runtime_binding.ordinary_file(log) as (source, info):
            require(prefix_digest(source, anchor["prefix_bytes"]) == anchor.get("prefix_sha256"),
                    "tui_log_history_changed")
        pinned(startup_anchor)
    after, after_hook = snapshot()
    require(after == before and all(after_hook[k] >= hook[k] for k in hook),
            "tui_identity_or_hook_changed")
    pinned(caller_receipt)
    pinned(pi_policy)
    age = (datetime.now(timezone.utc) - timestamp(evidence["observed_at"])).total_seconds()
    if not 0 <= age <= context_max_age_seconds:
        raise ContextFreshnessError(age, context_max_age_seconds)
    return {"schema_version": 1, "adapter": PI_ADAPTER,
            "kind": "pi_tui_session_observation" if anchor else "pi_tui_startup_anchor",
            "thread_id": sid, "session_id": sid, "runtime_id": query.runtime_id,
            "binding": before, "hook": after_hook, "caller_receipt": caller_receipt,
            "policy": policy_reader.settings(policy), "policy_ref": pi_policy,
            "observed_at": evidence["observed_at"],
            "effective": {**observed, "cwd": evidence["cwd"]},
            "log_path": str(log), "log_device": evidence["file_identity"]["device"],
            "log_inode": evidence["file_identity"]["inode"],
            "prefix_bytes": evidence["prefix"]["bytes"],
            "prefix_sha256": evidence["prefix"]["sha256"],
            "trust": "runtime-state-and-log-not-live-process-attested",
            "requires_live_caller_check": True, "execution_authorized": False}


def observe(**kwargs):
    try:
        return _observe(**kwargs)
    except SafetyError as exc:
        # Never export a native payload or an arbitrary reader string.
        code = ("tui_hook_stale_or_future" if str(exc) == "runtime_state_stale_or_future_hook"
                else "tui_runtime_state_unverifiable")
        raise TuiError(code) from exc

