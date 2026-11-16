"""Pinned lifecycle execution policy. Observation never implies permission to send.

Historical continuations without a lifecycle retain their original contract. New
lifecycle configurations are explicit; there is no implicit manual-mode fallback.
Native-event/manual modes never send, including after an acceptance window ends.
"""

import os
from pathlib import Path

from coordinator_io import now, parse, pinned, read_json, require, timestamp
from blocking_io import bounded


MODES = {"autonomous", "native-event", "manual"}


def _handshake_retired(operation, *args, **kwargs):
    """A strict-handshake record cannot be confirmed any more; say so instead of crashing."""
    require(False, "strict_bootstrap_handshake_retired")


def validate(policy):
    require(isinstance(policy, dict) and set(policy) == {"mode", "trigger"}
            and policy["mode"] in MODES, "startup_execution_mode_required")
    if policy["mode"] == "native-event":
        trigger = policy["trigger"]
        require(isinstance(trigger, dict) and set(trigger) == {"source", "readiness"}
                and trigger["source"] in {"worker_done", "external_fact"},
                "startup_native_trigger_required")
        # A future, fixed publication path, not a fabricated ready flag.
        target = Path(trigger["readiness"])
        require(target.is_absolute() and target == target.resolve(), "startup_trigger_path_invalid")
    else:
        require(policy["trigger"] is None, "startup_unexpected_trigger")
    return policy


def policy(config):
    if "execution" not in config:
        if "startup_lifecycle" in config:
            from operator_startup import load
            plan, _, _, _ = load(config["startup_lifecycle"])
            require(plan["schema_version"] == 1, "startup_execution_mode_required")
        return None  # Historical contract, not a new-mode default.
    value = validate(config["execution"])
    require("startup_lifecycle" in config, "startup_lifecycle_required")
    from operator_startup import load
    plan, _, _, _ = load(config["startup_lifecycle"])
    require(plan["schema_version"] == 2 and plan["execution"] == value,
            "startup_execution_binding_changed")
    require(not os.path.lexists(Path(plan["state_root"]) / "STOP"), "startup_persistent_stop")
    if plan["bootstrap_owner"] is not None:
        require(not os.path.lexists(Path(plan["bootstrap_owner"]["path"]).parent / "STOP.json"),
                "startup_persistent_stop")
    return value


def can_send(config):
    value = policy(config)
    if value is not None:
        from operator_startup import load
        plan, _, _, _ = load(config["startup_lifecycle"])
        require(not os.path.lexists(Path(plan["state_root"]) / "STOP"), "startup_persistent_stop")
        if plan["bootstrap_owner"] is not None:
            # A plan written by the removed strict handshake cannot be confirmed any more; the
            # sender path for it fails closed instead of reading a ledger that no longer exists.
            _handshake_retired("authority")
        elif "runtime" in plan:
            from startup_runtime import established, continuation_ref
            established(config["startup_lifecycle"], continuation_ref(config))
    return value is None or value["mode"] == "autonomous"


def require_send(config):
    require(can_send(config), "startup_mode_forbids_send")


def unknown_sends(config, monitor_root=None):
    """Check every existing outbox, including Operator review delivery intents."""
    from coordinator_tui_continue import read_outbox
    root = Path(config["state_root"])
    state = read_outbox(root)
    entries = list(state["actions"].values())
    # Inspect the exact stored journal without manufacturing a config binding.
    if os.path.lexists(root / "scheduler.json"):
        journal = read_json(root / "scheduler.json")
        def visits(value):
            if isinstance(value, dict):
                if "attempted" in value and "delivery" in value:
                    entries.append(value)
                for item in value.values():
                    visits(item)
            elif isinstance(value, list):
                for item in value:
                    visits(item)
        visits(journal)
    if monitor_root is not None and os.path.lexists(Path(monitor_root) / "state.json"):
        entries.extend(read_json(Path(monitor_root) / "state.json").get("outbox", []))
    return any(e.get("attempted") is True and e.get("delivery") is None for e in entries)


def event_ready(config, contract):
    """An independent, pinned trigger attestation, never a live acceptance verdict.

The Operator publishes this only after auditing the designated trigger's actual
readiness. Native evidence and its scope must be present; expiry never enables
scheduler sends. All references are re-read at every readiness observation.
"""
    value = policy(config)
    require(value is not None and value["mode"] == "native-event", "startup_native_trigger_required")
    from operator_startup import load
    plan, _, _, _ = load(config["startup_lifecycle"])
    receipt = read_json(value["trigger"]["readiness"])
    require(set(receipt) == {"schema_version", "lifecycle", "run", "source", "operator",
                             "checked_at", "valid_until", "evidence", "decision"}
            | ({"release_window"} if receipt.get("schema_version") == 2 else set())
            and receipt["schema_version"] in (1, 2) and receipt["lifecycle"] == config["startup_lifecycle"]
            and receipt["run"] == contract["run"] and receipt["source"] == value["trigger"]["source"]
            and receipt["operator"] == contract["operator"] and receipt["decision"] == "ready"
            and isinstance(receipt["evidence"], list) and receipt["evidence"],
            "startup_trigger_readiness_invalid")
    require(timestamp(receipt["checked_at"]) <= timestamp(now()) < timestamp(receipt["valid_until"]),
            "startup_trigger_readiness_expired")
    limit = plan["runtime"]["deadline"] if "runtime" in plan else plan["bootstrap_deadline"]
    require(limit is None or timestamp(receipt["valid_until"]) <= timestamp(limit), "startup_trigger_readiness_expired")
    for ref in receipt["evidence"]:
        pinned(ref)
    _handshake_retired(plan,  value["trigger"]["readiness"])
    require(not unknown_sends(config, plan["monitor_state_root"]), "startup_isolation_send_unknown")
    # Evidence/owner reads may consume the entire validity window.
    trigger_window(receipt, publishing=False)
    return receipt


@bounded("trigger_ready", mutation=True)


def trigger_template(*, with_window=False):
    """Unapproved review skeleton, deliberately invalid until independently filled."""
    result = dict(decision=None, notes="", evidence=[], valid_until=None,
                trigger=dict(path="ABSOLUTE_PREFLIGHT_PATH", sha256="PREFLIGHT_SHA256"))
    if with_window:
        result["release_window"] = dict(deadline=None, publish_budget_seconds=30, reserve_seconds=120)
    return result


def trigger_window(value, *, publishing):
    """UTC deadlines only; no implicit extension or cross-host monotonic math.

    This is admission/consumption checking, not cancellation of a late write.
    Legacy reviews retain their schema and expiry; v2 explicitly pins a window.
    """
    current = timestamp(now())
    until = timestamp(value["valid_until"])
    require(current < until, "startup_trigger_readiness_expired")
    window = value.get("release_window")
    if window is None:
        require("release_window" not in value, "startup_release_window_invalid")
        return
    require(isinstance(window, dict) and set(window) == {"deadline", "publish_budget_seconds", "reserve_seconds"},
            "startup_release_window_invalid")
    for key, minimum in (("publish_budget_seconds", 30), ("reserve_seconds", 120)):
        require(type(window[key]) is int and minimum <= window[key] <= 3600, "startup_release_window_invalid")
    require(isinstance(window["deadline"], str), "startup_release_window_invalid")
    deadline = timestamp(window["deadline"])
    remaining = (min(until, deadline) - current).total_seconds()
    needed = window["reserve_seconds"] + (window["publish_budget_seconds"] if publishing else 0)
    require(remaining > needed, "startup_trigger_window_insufficient")


def trigger_candidate(input_ref):
    """Shared structural/pin checks; never infer a review from a raw preflight."""
    candidate = parse(pinned(input_ref))
    require(isinstance(candidate, dict) and set(candidate) == set(trigger_template())
            | ({"release_window"} if "release_window" in candidate else set())
            and candidate["decision"] == "ready" and isinstance(candidate["notes"], str) and candidate["notes"].strip()
            and isinstance(candidate["evidence"], list) and candidate["evidence"]
            and isinstance(candidate["valid_until"], str), "startup_trigger_review_required")
    timestamp(candidate["valid_until"])
    trigger = parse(pinned(candidate["trigger"]))
    require(isinstance(trigger, dict), "startup_trigger_scope_changed")
    for evidence in candidate["evidence"]:
        pinned(evidence)
    trigger_window(candidate, publishing=True)
    return candidate, trigger




def startup_gate(config):
    """The historical dispatch field is null only on the reviewed no-Worker path."""
    if config.get("dispatch_gate") is not None:
        return parse(pinned(config["dispatch_gate"]))
    require("startup_evidence" in config and "startup_lifecycle" in config,
            "startup_run_readiness_required")
    return _handshake_retired(config["startup_lifecycle"], config["startup_evidence"])["gate"]