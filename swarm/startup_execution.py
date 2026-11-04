"""Pinned lifecycle execution policy. Observation never implies permission to send.

Historical continuations without a lifecycle retain their original contract. New
lifecycle configurations are explicit; there is no implicit manual-mode fallback.
Native-event/manual modes never send, including after an acceptance window ends.
"""

import os
from pathlib import Path

from coordinator_io import now, parse, pinned, read_json, require, timestamp


MODES = {"autonomous", "native-event", "manual"}


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
            from startup_handoff import authority
            control, owner = authority(plan)
            require(not os.path.lexists(Path(control.attempt_binding["path"]).parent / "control" / "STOP.json"),
                    "startup_persistent_stop")
            # Read-only confirmation; sender is not an authenticated review role.
            require(owner.query(control, config["startup_lifecycle"]).status == "confirmed",
                    "startup_output_unconfirmed")
            if "runtime" in plan:
                from startup_runtime import continuation_ref
                require(owner.runtime_observe(control, config["startup_lifecycle"], continuation_ref(config))["state"] == "ready",
                        "startup_original_owner_not_ready")
            else:
                require(owner.observe(control)["state"] == "ready", "startup_original_owner_not_ready")
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
            and receipt["schema_version"] == 1 and receipt["lifecycle"] == config["startup_lifecycle"]
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
    from startup_handoff import confirmed
    confirmed(plan, value["trigger"]["readiness"])
    require(not unknown_sends(config, plan["monitor_state_root"]), "startup_isolation_send_unknown")
    return receipt


def attest_trigger(ref, input_ref, *, call=None):
    """Publish an original Operator's trigger preflight, never an acceptance PASS."""
    from startup_handoff import context, publish, authority
    from coordinator_io import bound_lock
    from operator_startup import load
    # Cheap pinned input checks precede native identity queries / owner RPC.
    # The publication path repeats these checks; this is not authorization.
    trigger_candidate(input_ref)
    plan, _, _, _ = load(ref)
    if "runtime" in plan:
        from startup_runtime import established
        config_ref = read_json(plan["continuation_publication"])
        if plan["bootstrap_owner"] is not None:
            _, owner = authority(plan)
            result = owner.rpc("runtime-attest-trigger", lifecycle=ref, continuation=config_ref, candidate=input_ref)
            return dict(ok=True, trigger_readiness=result, acceptance_complete=False, automatic_sends_allowed=False)
        plan, _, contract = established(ref, config_ref)
        from coordinator_startup import check_actor_context, require_operator_context
        from operator_session import observe_identity
        check_actor_context(contract, "operator")
        require_operator_context(contract)
        from operator_monitor import native
        terminal = (call or native)(["terminal", "show", "--terminal", contract["operator"]["terminal"]], contract["runtime"], 20)["terminal"]
        observe_identity(cli=contract["cli"]["path"], runtime=contract["runtime"], operator=contract["operator"],
            workspace=terminal["worktreeId"], profile=contract["observation"]["profile"],
            log_root=contract["observation"]["log_root"], max_age_seconds=contract["freshness"]["context_max_age_seconds"])
        with bound_lock(Path(plan["state_root"]), ref, "startup-role-action"):
            value = trigger_review(ref, input_ref, plan, contract)
            result = publish(plan, plan["execution"]["trigger"]["readiness"], value, actor="operator")
        return dict(ok=True, trigger_readiness=result, acceptance_complete=False, automatic_sends_allowed=False)
    plan, _, contract, _ = context(ref, call=call, actor="operator")
    with bound_lock(Path(plan["state_root"]), ref, "startup-role-action"):
        value = trigger_review(ref, input_ref, plan, contract)
        context(ref, call=call, actor="operator")
        result = publish(plan, plan["execution"]["trigger"]["readiness"], value, actor="operator")
    return dict(ok=True, trigger_readiness=result, acceptance_complete=False, automatic_sends_allowed=False)


def trigger_template():
    """Unapproved review skeleton, deliberately invalid until independently filled."""
    return dict(decision=None, notes="", evidence=[], valid_until=None,
                trigger=dict(path="ABSOLUTE_PREFLIGHT_PATH", sha256="PREFLIGHT_SHA256"))


def trigger_candidate(input_ref):
    """Shared structural/pin checks; never infer a review from a raw preflight."""
    candidate = parse(pinned(input_ref))
    require(isinstance(candidate, dict) and set(candidate) == set(trigger_template())
            and candidate["decision"] == "ready" and isinstance(candidate["notes"], str) and candidate["notes"].strip()
            and isinstance(candidate["evidence"], list) and candidate["evidence"]
            and isinstance(candidate["valid_until"], str), "startup_trigger_review_required")
    timestamp(candidate["valid_until"])
    trigger = parse(pinned(candidate["trigger"]))
    require(isinstance(trigger, dict), "startup_trigger_scope_changed")
    for evidence in candidate["evidence"]:
        pinned(evidence)
    return candidate, trigger


def trigger_review(ref, input_ref, plan, contract):
    """Read-only validation shared by startup and the narrow runtime Operator RPC."""
    from startup_handoff import confirmed, admission
    require(plan["execution"]["mode"] == "native-event", "startup_native_trigger_required")
    candidate, trigger = trigger_candidate(input_ref)
    require(trigger.get("kind") == "native_event_trigger_preflight" and trigger.get("ready") is True
            and trigger.get("run") == contract["run"] and trigger.get("source") == plan["execution"]["trigger"]["source"]
            and isinstance(trigger.get("trigger_id"), str) and trigger["trigger_id"], "startup_trigger_scope_changed")
    checked = now()
    require(timestamp(trigger["checked_at"]) <= timestamp(checked) < timestamp(candidate["valid_until"])
            <= timestamp(trigger["valid_until"]),
            "startup_trigger_readiness_expired")
    limit = plan["runtime"]["deadline"] if "runtime" in plan else plan["bootstrap_deadline"]
    require(limit is None or timestamp(candidate["valid_until"]) <= timestamp(limit), "startup_trigger_readiness_expired")
    admitted = admission(ref, confirmed(plan, Path(plan["state_root"]) / "admission.json"))
    if trigger["source"] == "worker_done":
        require(admitted["kind"] == "worker-dispatched", "startup_worker_trigger_requires_worker")
        native = parse(pinned(parse(pinned(admitted["evidence"]))["response"]))
        require(trigger["trigger_id"] == native["dispatchId"], "startup_trigger_scope_changed")
    config_ref = read_json(plan["continuation_publication"])
    from coordinator_tui_continue import load
    config, _, _ = load(config_ref)
    require(config.get("startup_lifecycle") == ref and not unknown_sends(config, plan["monitor_state_root"]),
            "startup_isolation_send_unknown")
    return dict(schema_version=1, lifecycle=ref,
            run=contract["run"], source=trigger["source"], operator=contract["operator"], decision="ready",
            checked_at=checked, valid_until=candidate["valid_until"],
            evidence=[input_ref, candidate["trigger"], *candidate["evidence"]])


def startup_gate(config):
    """The historical dispatch field is null only on the reviewed no-Worker path."""
    if config.get("dispatch_gate") is not None:
        return parse(pinned(config["dispatch_gate"]))
    require("startup_evidence" in config and "startup_lifecycle" in config,
            "startup_run_readiness_required")
    from startup_handoff import admission
    return admission(config["startup_lifecycle"], config["startup_evidence"])["gate"]
