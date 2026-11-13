"""Resumable Operator bootstrap in the dedicated native monitor sender shell.

prepare is static. run observes strict creation and Coordinator publication,
prepares/reconciles one deployment, then calls its existing foreground run/verify.
No Agent launch, remote-shell send, business executor or identity synthesis.
"""

import argparse
from pathlib import Path
import os
import shlex
import subprocess
import sys
import time
from types import SimpleNamespace

from coordinator_io import (bound_lock, canonical, digest, file_ref, now, parse, pinned,
                            publish_new, read_json, replace_json, require, timestamp)
from coordinator_startup import KIND, identity
import tui_adapter
from coordinator_creation_time import creation_bounds
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_readiness as readiness
from blocking_io import bounded, run as bounded_io, BlockingIOTimeout


INPUT_KEYS = {"schema_version", "strict_start", "continuation_publication", "sender",
              "state_root", "monitor_state_root", "deployment_dir", "poll_seconds", "bootstrap_deadline"}
NEW_KEYS = {"execution", "workers", "bootstrap_owner"}


def _load_strict_start(ref):
    """Read the pinned strict start config a lifecycle plan was built on.

    Two shapes exist in the field: a v4 activation that wraps a base config plus a lifecycle spec,
    and the older base config itself. The builder that wrote them is gone, so this reads their
    *structure* and pins every ref; it no longer re-derives them from a request (that cross-check
    belonged to the removed handshake and its inputs are no longer published).
    """
    config = parse(pinned(ref))
    if config.get("schema_version") == 4:
        require(set(config) == {"schema_version", "base_config", "lifecycle_spec"},
                "strict_activation_invalid")
        spec = parse(pinned(config["lifecycle_spec"]))
        require(spec["schema_version"] == 2, "strict_activation_spec_invalid")
        base, contract, _, directory = _load_strict_start(config["base_config"])
        require(base["schema_version"] in (1, 2, 3) and "base_config" not in base,
                "strict_activation_nested")
        require(Path(ref["path"]) == directory.parent / "lifecycle" / "activation.json"
                and Path(config["lifecycle_spec"]["path"]) == directory.parent / "lifecycle" / "spec.json",
                "strict_activation_path_invalid")
        return (dict(base, lifecycle_spec=config["lifecycle_spec"],
                     base_config=config["base_config"]), contract, spec, directory)
    require(config.get("schema_version") in (1, 2, 3), "strict_config_unsupported")
    contract = parse(pinned(config["contract"]))
    require(contract["schema_version"] == 2 and contract["run"] is None,
            "strict_session_requires_v2_session_contract")
    from coordinator_strict import caller_result
    initial = caller_result(parse(pinned(config["caller_receipt"])), contract["runtime"])
    require(initial["caller"]["terminalHandle"] == contract["coordinator"]["terminal"],
            "strict_start_caller_mismatch")
    directory = path(config["directory"], directory=True)
    require(any(directory.is_relative_to(Path(root)) for root in contract["observation"]["roots"]),
            "strict_start_directory_outside_roots")
    return config, contract, initial, directory


def input_keys(data):
    return INPUT_KEYS | (NEW_KEYS | ({"runtime"} if "runtime" in data else set())
                         if data.get("schema_version") == 2 else set())


def validate_inputs(data):
    require(isinstance(data, dict) and set(data) == input_keys(data)
            and type(data["schema_version"]) is int and data["schema_version"] in (1, 2),
            "startup_inputs_invalid")
    if data["schema_version"] == 2:
        from startup_execution import validate
        validate(data["execution"])
        if "runtime" in data:
            from startup_runtime import validate_policy
            validate_policy(data["runtime"])
        require(data["workers"] in ("required", "not-applicable"), "startup_worker_policy_required")
        if data["bootstrap_owner"] is not None:
            pinned(data["bootstrap_owner"])
    start, contract, _, directory = _load_strict_start(data["strict_start"])
    if data["schema_version"] == 2 and os.path.lexists(directory.parent / "attempt-binding.json"):
        require(data["bootstrap_owner"] == file_ref(directory.parent / "control" / "owner.json"),
                "startup_original_owner_required")
        require(timestamp(data["bootstrap_deadline"]) <= timestamp(read_json(directory.parent / "attempt-binding.json")["deadline"]),
                "startup_deadline_exceeds_original_attempt")
    require(tui_adapter.is_tui(contract["adapter"]), "startup_tui_contract_required")
    require(type(data["poll_seconds"]) is int and 1 <= data["poll_seconds"] <= 60,
            "startup_poll_invalid")
    timestamp(data["bootstrap_deadline"])
    sender = data["sender"]
    require(isinstance(sender, dict) and set(sender) == {"terminal", "incarnation", "workspace"}
            and all(isinstance(v, str) and v for v in sender.values())
            and sender["terminal"] != contract["coordinator"]["terminal"], "startup_sender_invalid")
    roots = [deploy.private_directory(data[k]) for k in ("state_root", "monitor_state_root", "deployment_dir")]
    publication = Path(data["continuation_publication"])
    require(publication.is_absolute() and publication == publication.resolve()
            and publication.name == "continuation-ref.json", "startup_publication_path_invalid")
    for target in [*roots, publication.parent]:
        require(any(target.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
                "startup_path_outside_roots")
    distinct = [*roots, publication.parent, directory]
    require(all(not a.is_relative_to(b) and not b.is_relative_to(a)
                for i, a in enumerate(distinct) for b in distinct[i + 1:]), "startup_directories_overlap")
    return start, contract, directory


def validate_spec(spec, base_ref):
    """Also used by the owner before admitting dynamic role output slots."""
    require(isinstance(spec, dict) and set(spec) == input_keys(spec) - {"strict_start"} | {"lifecycle_path"}
            and spec.get("schema_version") == 2, "startup_spec_invalid")
    _, _, directory = validate_inputs({k: v for k, v in spec.items() if k != "lifecycle_path"} | {"strict_start": base_ref})
    output = directory.parent / "lifecycle"
    require(spec["lifecycle_path"] == str(output / "lifecycle.json"), "startup_owner_layout_required")
    targets = [Path(spec[k]) for k in ("state_root", "monitor_state_root", "deployment_dir")]
    targets.append(Path(spec["continuation_publication"]).parent)
    require(all(not a.is_relative_to(b) and not b.is_relative_to(a)
                for a in targets for b in (output, directory.parent / "control", directory)),
            "startup_directories_overlap")
    if spec["execution"]["mode"] == "native-event":
        require(spec["execution"]["trigger"]["readiness"] == str(Path(spec["state_root"]) / "trigger-ready.json"),
                "startup_trigger_path_invalid")
    return spec


def load(ref):
    plan = parse(pinned(ref))
    new = plan.get("schema_version") == 2
    require(isinstance(plan, dict) and set(plan) == input_keys(plan) | {"sources", "python"}
            | (NEW_KEYS | {"spec"} if new else set()), "startup_plan_invalid")
    require(plan["sources"] == deploy.sources(), "startup_source_changed")
    require(plan["python"] == str(Path(sys.executable).resolve()), "startup_python_changed")
    start, contract, directory = validate_inputs({k: plan[k] for k in input_keys(plan)})
    if new:
        spec = parse(pinned(plan["spec"]))
        validate_spec(spec, start["base_config"])
        require(spec == {**{k: plan[k] for k in input_keys(plan) - {"strict_start"}},
                         "lifecycle_path": ref["path"]}
                and start.get("lifecycle_spec") == plan["spec"], "startup_spec_binding_changed")
    return plan, start, contract, directory




def validate_continuation_binding(ref, config, contract, *, require_executing=True):
    """Called before Coordinator initialization writes; no publication required yet.

    ``require_executing=False`` runs the same deterministic checks before the lifecycle
    action takes its execution fence, where the dispatch/continuation markers do not
    exist yet. It never replaces the post-fence call, which keeps the defaults.
    """
    plan, _, session, _ = load(ref)
    output = Path(plan["continuation_publication"]).parent
    require(identity(contract) == identity(session), "startup_coordinator_identity_changed")
    require(config["scheduler"] == plan["sender"]
            and config["state_root"] == str(output / "state")
            and config["checkpoint_head"] == str(output / "checkpoint-head.json"),
            "startup_continuation_binding_changed")
    require(set(contract["observation"]["roots"]) <= set(session["observation"]["roots"]),
            "startup_continuation_scope_changed")
    if plan["schema_version"] == 2:
        if "runtime" in plan:
            require(config["deadline"] == plan["runtime"]["deadline"], "startup_runtime_deadline_changed")
        require(config.get("execution") == plan["execution"] and "startup_evidence" in config,
                "startup_continuation_admission_required")
        # This branch confirmed a publication ledger written by the removed strict handshake. A plan
        # that still asks for it cannot be validated, and pretending otherwise would let a resumed
        # continuation run on an unverified plan, so it stops with its own code.
        require(False, "strict_bootstrap_handshake_retired")


def created(ref, *, call=None):
    plan, start, contract, directory = load(ref)
    call = monitor.bind_contract(call, contract)
    target = directory / "created.json"
    if not os.path.lexists(target):
        require(not any(os.path.lexists(directory / name) for name in
                        ("create-intent.json", "create-response.json")),
                "startup_creation_requires_reconciliation")
        return None  # Never replay create; its original executor owns reconciliation.
    created_ref = file_ref(target)
    value = parse(pinned(created_ref))
    require(isinstance(value, dict) and value.get("ok") is True and value.get("kind") == "strict_start_created"
            and value.get("config_sha256") == plan["strict_start"]["sha256"]
            and value.get("request_id") == start["request_id"], "startup_created_receipt_changed")
    intent, response = read_json(directory / "create-intent.json"), read_json(directory / "create-response.json")
    require(intent.get("config") == plan["strict_start"] and intent.get("gate") == value.get("gate")
            and intent.get("request_id") == start["request_id"]
            and response.get("coordinatorPolicy") == "strict-v1"
            and response.get("run") == value.get("run"), "startup_creation_evidence_changed")
    gate = parse(pinned(value["gate"]))
    require(isinstance(gate, dict) and gate.get("ok") is True
            and gate.get("phase") == "session" and gate.get("actor") == "operator"
            and gate.get("schema_version") == 2 and gate.get("kind") == KIND
            and gate.get("binding") == identity(contract)
            and gate.get("identity_sha256") == digest(canonical(identity(contract)))
            and gate.get("contract_sha256") == start["contract"]["sha256"], "startup_creation_gate_changed")
    run = value["run"]
    require(isinstance(run, dict) and isinstance(run.get("id"), str) and run["id"].startswith("run_")
            and run.get("objective") == start["objective"]
            and run.get("coordinator_handle") == contract["coordinator"]["terminal"]
            and type(run.get("consumer_generation")) is int and run["consumer_generation"] > 0,
            "startup_created_run_changed")
    created_start, created_end = creation_bounds(run["created_at"])
    require(timestamp(gate["started_at"]) <= timestamp(gate["completed_at"]) <= created_start
            and created_end <= min(timestamp(gate["valid_until"]), timestamp(start["deadline"]))
            and created_start <= timestamp(now()), "startup_creation_time_changed")
    observed = (call or monitor.native)(["orchestration", "run-show", "--id", run["id"]], contract["runtime"], 20)
    require(observed.get("coordinatorPolicy") == "strict-v1" and not observed.get("strictRetirement")
            and all(observed.get("run", {}).get(k) == run[k] for k in
                    ("id", "coordinator_handle", "consumer_generation")), "startup_run_binding_changed")
    pinned(created_ref)
    return dict(receipt=created_ref, run={"id": run["id"], "generation": run["consumer_generation"]})




def own_sender(plan, contract, call):
    # Reuse exactly the monitor's inherited-context fence, not a target preflight.
    shell = SimpleNamespace(startup_contract=contract, data=dict(schema_version=2, sender=plan["sender"],
                                     binding={"runtime": contract["runtime"]}))
    monitor.sender_fence(shell, lambda args, runtime: call(args, runtime, 20))


def read_state(plan, ref):
    target = Path(plan["state_root"]) / "state.json"
    if not os.path.lexists(target):
        return dict(schema_version=1, plan=ref, milestones={}, continuation=None, deployment=None,
                    prepare_intent=False, attempts=[], current=None)
    state = read_json(target)
    require(set(state) == {"schema_version", "plan", "milestones", "continuation", "deployment",
                           "prepare_intent", "attempts", "current"}
            and type(state["schema_version"]) is int and state["schema_version"] == 1 and state["plan"] == ref
            and type(state["prepare_intent"]) is bool
            and isinstance(state["milestones"], dict)
            and set(state["milestones"]) <= {"run_created", "continuation_ready", "monitor_ready", "runtime_ready"}
            and all(isinstance(v, dict) and set(v) == {"observed_at", "evidence"}
                    for v in state["milestones"].values())
            and isinstance(state["attempts"], list)
            and all(isinstance(a, dict) and a.get("outcome") in ("unknown", "exited")
                    for a in state["attempts"]),
            "startup_state_binding_changed")
    return state
