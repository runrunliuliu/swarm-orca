"""Role-separated S5 handoff, projecting existing receipts rather than an outbox.

pull publishes a task; accept records receipt of responsibility; complete invokes
the existing producer once. Unknown execution is inspected, never replayed. The
original bootstrap owner confirms lifecycle outputs when an owner is bound.
"""

import argparse
import os
import re
from pathlib import Path
import sys

from coordinator_io import (bound_lock, canonical, digest, file_ref, now, parse, pinned,
                            publish_new, read_json, require, timestamp)
from coordinator_startup import check_actor_context, identity, require_operator_context, run_gate, validate, KIND


ACTIONS = {"materials": "coordinator", "review": "operator",
           "dispatch": "coordinator", "continuation": "coordinator"}
OUTPUTS = {"materials": "materials.json", "review": "review.json",
           "dispatch": "admission.json", "continuation": "continuation-receipt.json"}


def refresh_slot(spec, target):
    path = Path(target)
    return (path.parent == Path(spec["state_root"]) and
            re.fullmatch(r"review-refresh-[1-9][0-9]*-(intent|gate|receipt)\.json", path.name) is not None)


def slots(spec):
    root = Path(spec["state_root"])
    result = {}
    for action, actor in ACTIONS.items():
        for suffix in ("task", "accepted", "executing", "complete"):
            result[str(root / f"{action}-{suffix}.json")] = actor
        result[str(root / OUTPUTS[action])] = actor
    result[str(root / "first-contract.json")] = "operator"
    result[str(root / "operator-gate.json")] = "operator"
    result[str(root / "run-readiness-gate.json")] = "coordinator"
    result[str(root / "binding.json")] = "coordinator"
    if spec["execution"]["mode"] == "native-event":
        result[spec["execution"]["trigger"]["readiness"]] = "operator"
    return result


def authority(plan):
    from bootstrap_tool import connect
    return connect(plan["bootstrap_owner"])


def publish(plan, target, value, *, actor):
    target = Path(target)
    if plan["bootstrap_owner"] is None:
        publish_new(target, value)
    else:
        control, owner = authority(plan)
        def check():
            require(owner.active(control)["actor"] == actor, "startup_original_role_required")
        refs = [plan["spec"]] if "spec" in plan else []
        raw = value if isinstance(value, bytes) else canonical(value) + b"\n"
        reply = owner.commit_new(control, actor=actor, target=str(target), raw=raw,
                                 prerequisites=refs, recheck=check)
        require(reply.status == "confirmed", "startup_output_unconfirmed")
    return confirmed(plan, target)


def confirmed(plan, target):
    ref = file_ref(target)
    if plan["bootstrap_owner"] is not None:
        from startup_runtime import local_confirmation
        local = local_confirmation.get()
        if local is not None:
            owner, owner_ref = local
            require(plan["bootstrap_owner"] == owner_ref, "startup_original_owner_required")
            control = owner.control
        else:
            control, owner = authority(plan)
        require(owner.query(control, ref).status == "confirmed", "startup_output_unconfirmed")
    return ref


def context(ref, *, call=None, actor=None):
    from operator_startup import load, created
    plan, start, session, _ = load(ref)
    if call is not None:
        from operator_monitor import bind_contract
        call = bind_contract(call, session)
    require(plan["schema_version"] == 2, "startup_new_lifecycle_required")
    require(not os.path.lexists(Path(plan["state_root"]) / "STOP"), "startup_persistent_stop")
    if plan["bootstrap_owner"] is not None:
        control, owner = authority(plan)
        stop = Path(control.attempt_binding["path"]).parent / "control" / "STOP.json"
        require(not os.path.lexists(stop), "startup_persistent_stop")
        if actor:
            require(owner.active(control)["actor"] == actor, "startup_original_role_required")
    if actor:
        check_actor_context(session, actor)
        if actor == "operator":
            require_operator_context(session)
        require(timestamp(now()) < timestamp(plan["bootstrap_deadline"]), "startup_handoff_deadline_expired")
    creation = created(ref, call=call)
    require(creation is not None, "startup_run_created_required")
    confirmed(plan, creation["receipt"]["path"])
    contract = dict(session, run=creation["run"])
    if actor and plan["bootstrap_owner"] is None:
        # Standalone lifecycle still checks a real session, not just an env hint.
        if actor == "coordinator":
            from coordinator_tui_continue import fence
            options = {"call": lambda cli, runtime, args: call(args, runtime, 20)} if call else {}
            fence(contract, **options)
        else:
            from operator_session import observe_identity
            from operator_monitor import bind_contract
            terminal = bind_contract(call, contract)(["terminal", "show", "--terminal", contract[actor]["terminal"]], contract["runtime"], 20)["terminal"]
            observe_identity(cli=contract["cli"]["path"], runtime=contract["runtime"], operator=contract["operator"],
                workspace=terminal["worktreeId"], profile=contract["observation"]["profile"],
                log_root=contract["observation"]["log_root"],
                max_age_seconds=contract["freshness"]["context_max_age_seconds"])
    return plan, start, contract, creation


def commands(ref, action, actor):
    base = [sys.executable, "-B", str(Path(__file__).resolve())]
    pins = ["--plan", ref["path"], "--plan-sha256", ref["sha256"], "--actor", actor]
    result = {mode + "_argv": [*base, mode, *pins, "--action", action,
                              *(["--execute"] if mode != "inspect" else [])]
            for mode in ("accept", "complete", "inspect")}
    result["pull_argv"] = [*base, "pull", *pins, "--execute"]
    if action != "dispatch":
        result["complete_argv"] += ["--input", "CANDIDATE_INPUT_PATH", "--input-sha256", "RAW_SHA256"]
    return result


def review_head(plan):
    root = Path(plan["state_root"])
    ref = confirmed(plan, root / "review.json")
    value = parse(pinned(ref))
    for index in range(1, len(list(root.glob("review-refresh-*-intent.json"))) + 1):
        intent = confirmed(plan, root / f"review-refresh-{index}-intent.json")
        following = confirmed(plan, root / f"review-refresh-{index}-receipt.json")
        next_value = parse(pinned(following))
        require(next_value["previous"] == ref and next_value["intent"] == intent
                and next_value["contract"] == value["contract"]
                and next_value["materials"] == value["materials"], "startup_review_refresh_changed")
        require(next_value["gate"] == confirmed(plan, root / f"review-refresh-{index}-gate.json"),
                "startup_review_refresh_changed")
        ref, value = following, next_value
    return ref, value


def dispatch_intents(root):
    return sorted(root.glob("first-dispatch*/dispatch-intent.json"))


def candidate_template(action, plan, contract, inputs):
    root = Path(plan["state_root"])
    if action == "materials":
        return dict(contract={"path": "CANDIDATE_RUN_CONTRACT_PATH", "sha256": "RAW_SHA256"},
                    worker="WORKER_PLAN_WITHOUT_FIRST_DISPATCH" if plan["workers"] == "required" else None,
                    reason="BUSINESS_REASON", authority=[{"path": "AUTHORITY_EVIDENCE_PATH", "sha256": "RAW_SHA256"}])
    if action == "review":
        return dict(materials=confirmed(plan, root / "materials.json"), decision="INDEPENDENT_DECISION",
                    notes="ORIGINAL_OPERATOR_REVIEW_NOTES")
    if action == "continuation":
        admitted = admission(inputs[0], confirmed(plan, root / "admission.json"))
        return dict(schema_version=1, contract=admitted["contract"], dispatch_gate=admitted["dispatch_gate"],
                    scheduler=plan["sender"], output_dir=str(Path(plan["continuation_publication"]).parent),
                    acceptance={"path": "ACCEPTANCE_PATH", "sha256": "RAW_SHA256"},
                    deadline=plan["runtime"]["deadline"] if "runtime" in plan else "AUTHORIZED_DEADLINE",
                    source={"path": "DOMAIN_SOURCE_PATH", "sha256": "RAW_SHA256"},
                    receipt={"path": "DOMAIN_RECEIPT_PATH", "sha256": "RAW_SHA256"})
    return None


def inspect(ref, *, creation=None, call=None, observe_idle=False):
    plan, _, contract, current = context(ref, call=call)
    if call is not None:
        from operator_monitor import bind_contract
        call = bind_contract(call, contract)
    require(creation is None or current == creation, "startup_run_binding_changed")
    root = Path(plan["state_root"])
    inputs = [ref, current["receipt"]]
    for action, actor in ACTIONS.items():
        done = root / f"{action}-complete.json"
        if os.path.lexists(done):
            receipt = read_json(done)
            require(receipt["lifecycle"] == ref and receipt["action"] == action,
                    "startup_action_binding_changed")
            confirmed(plan, done)
            require(receipt["result"] == confirmed(plan, root / OUTPUTS[action])
                    and receipt["accepted"] == confirmed(plan, root / f"{action}-accepted.json"),
                    "startup_action_binding_changed")
            executing = read_json(confirmed(plan, root / f"{action}-executing.json")["path"])
            require(executing["accepted"] == receipt["accepted"] and executing["lifecycle"] == ref
                    and executing["action"] == action, "startup_action_binding_changed")
            inputs.append(file_ref(done))
            continue
        attempted = os.path.lexists(root / f"{action}-executing.json")
        # The original native journal is always the source for an uncertain dispatch.
        intents = dispatch_intents(root)
        if action == "dispatch" and intents:
            attempted = True
        accepted = root / f"{action}-accepted.json"
        result = dict(ok=False, state="reconciliation_required" if attempted else "awaiting_" + action,
                      runtime_ready=False, acceptance_complete=False, next_owner=actor,
                      missing=[action], action=action, identity=contract[actor], run=contract["run"],
                      inputs=inputs, deadline=plan["bootstrap_deadline"],
                      responsibility_accepted=os.path.lexists(accepted), retry_allowed=False,
                      **commands(ref, action, actor))
        result["candidate_template"] = candidate_template(action, plan, contract, inputs)
        if action == "dispatch" and not attempted:
            reviewed_ref, reviewed = review_head(plan)
            gate = parse(pinned(reviewed["gate"]))
            remaining = (timestamp(gate["valid_until"]) - timestamp(now())).total_seconds()
            worker = read_json(root / "materials.json")["worker"]
            required = worker.get("timeout_ms", 60000) / 1000 + 15 if worker is not None else 0
            if remaining <= required:
                actor = "operator"
                result.update(state="operator_gate_expired" if remaining <= 0 else "operator_gate_window_insufficient",
                              next_owner="operator", missing=["fresh_operator_gate"],
                              identity=contract[actor],
                              refresh_template=dict(previous=reviewed_ref, decision="INDEPENDENT_DECISION",
                                                    notes="ORIGINAL_OPERATOR_REVIEW_NOTES"),
                              refresh_argv=[sys.executable, "-B", str(Path(__file__).resolve()), "refresh-review",
                                            "--plan", ref["path"], "--plan-sha256", ref["sha256"], "--actor", "operator",
                                            "--input", "INDEPENDENT_REVIEW_PATH", "--input-sha256", "RAW_SHA256", "--execute"])
        if os.path.lexists(accepted):
            result["accepted"] = confirmed(plan, accepted)
        if attempted:
            if os.path.lexists(root / f"{action}-executing.json"):
                result["original_intent"] = file_ref(root / f"{action}-executing.json")
            if intents:
                require(len(intents) == 1, "startup_multiple_dispatch_intents")
                result["native_intent"] = file_ref(intents[0])
                result["request_id"] = read_json(intents[0])["request_id"]
                result["native_reconcile_argv"] = [contract["cli"]["path"], "--runtime", contract["runtime"],
                    "orchestration", "request-show", "--request", result["request_id"]]
        # Native idle is diagnostic only; not a legal turn-end or recovery permit.
        if call:
            shown = call(["terminal", "show", "--terminal", contract[actor]["terminal"]], contract["runtime"], 20)
            terminal = shown.get("terminal", {})
            result["role_observation"] = {k: terminal.get(k) for k in
                                          ("handle", "incarnationId", "connected", "orphaned", "status")}
            if terminal.get("connected") is False or terminal.get("orphaned") is True:
                result.update(state="role_unavailable", recovery="original_role_review_required")
            elif terminal.get("status") in ("idle", "exited"):
                result.update(state="handoff_incomplete_role_idle", recovery="original_role_review_required")
            elif observe_idle and terminal.get("connected") is True:
                from terminal_idle_wait import IdleWaitResult, idle_wait_args
                observed = call(idle_wait_args(contract[actor]["terminal"]), contract["runtime"], 20)
                require(isinstance(observed, IdleWaitResult), "startup_role_idle_unverifiable")
                result["role_observation"]["tui_wait"] = dict(state=observed.state, reason=observed.reason)
                if observed.state == "ready":
                    result.update(state="handoff_incomplete_role_idle", recovery="original_role_review_required")
                elif observed.state == "interaction_required":
                    result.update(state="role_interaction_required", recovery="original_role_review_required")
        return result
    return dict(ok=False, state="awaiting_monitor", runtime_ready=False, acceptance_complete=False,
                next_owner="sender", missing=["monitor_ready"], run=contract["run"])


def task(ref, actor, *, call=None):
    plan, _, contract, creation = context(ref, call=call, actor=actor)
    pending = inspect(ref, creation=creation, call=call)
    if pending["next_owner"] != actor or "action" not in pending:
        return pending
    action = pending["action"]
    target = Path(plan["state_root"]) / f"{action}-task.json"
    if not os.path.lexists(target):
        publish(plan, target, dict(lifecycle=ref, action=action, actor=actor, identity=contract[actor],
                                  run=contract["run"], inputs=pending["inputs"],
                                  deadline=plan["bootstrap_deadline"], published_at=now()), actor=actor)
    pending["task"] = confirmed(plan, target)
    return pending


def accept(ref, actor, action, *, call=None):
    plan, _, contract, _ = context(ref, call=call, actor=actor)
    pending = task(ref, actor, call=call)
    require(pending.get("action") == action and ACTIONS.get(action) == actor
            and pending["next_owner"] == actor
            and not pending["state"] == "reconciliation_required", "startup_action_not_available")
    target = Path(plan["state_root"]) / f"{action}-accepted.json"
    if not os.path.lexists(target):
        publish(plan, target, dict(task=pending["task"], lifecycle=ref, actor=actor,
                                  identity=contract[actor], accepted_at=now()), actor=actor)
    return dict(ok=True, accepted=confirmed(plan, target), **commands(ref, action, actor))


def material(plan, contract, value):
    require(isinstance(value, dict) and set(value) == {"contract", "worker", "reason", "authority"},
            "startup_materials_invalid")
    candidate = parse(pinned(value["contract"]))
    validate(candidate)
    require(identity(candidate) == identity(contract) and candidate["run"] == contract["run"]
            and set(candidate["observation"]["roots"]) <= set(contract["observation"]["roots"]),
            "startup_materials_binding_changed")
    require(isinstance(value["reason"], str) and value["reason"].strip()
            and isinstance(value["authority"], list) and value["authority"], "startup_authority_evidence_required")
    for pin in value["authority"]:
        pinned(pin)
    if plan["workers"] == "required":
        worker = value["worker"]
        require(isinstance(worker, dict) and "first_dispatch" not in worker
                and worker.get("run") == contract["run"]["id"] and worker.get("cli") == contract["cli"]["path"],
                "startup_worker_candidate_invalid")
        from coordinator_worker_plan import build_plan
        build_plan(worker)
    else:
        require(value["worker"] is None, "startup_no_worker_decision_required")
    return value


def complete(ref, actor, action, input_ref=None, *, call=None, dispatch_call=None):
    plan, _, contract, creation = context(ref, call=call, actor=actor)
    if call is not None:
        from operator_monitor import bind_contract
        call = bind_contract(call, contract)
    require(ACTIONS.get(action) == actor, "startup_original_role_required")
    root = Path(plan["state_root"])
    with bound_lock(root, ref, "startup-role-action"):
        pending = inspect(ref, creation=creation, call=call)
        require(pending.get("action") == action and pending["state"] != "reconciliation_required",
                "startup_action_requires_reconciliation")
        require(pending["next_owner"] == actor, "startup_fresh_operator_review_required")
        accepted = confirmed(plan, root / f"{action}-accepted.json")
        require(read_json(accepted["path"])["task"] == confirmed(plan, root / f"{action}-task.json"),
                "startup_action_binding_changed")
        value = parse(pinned(input_ref)) if input_ref else None
        # Deterministic mistakes fail before taking the execution fence.
        if action == "materials":
            material(plan, contract, value)
        elif action == "review":
            require(isinstance(value, dict) and set(value) == {"materials", "decision", "notes"}
                    and value["materials"] == confirmed(plan, root / "materials.json")
                    and value["decision"] == "approve" and isinstance(value["notes"], str)
                    and value["notes"].strip(), "startup_independent_review_required")
        elif action == "dispatch":
            require(input_ref is None, "startup_dispatch_has_no_mutable_input")
        else:
            require(isinstance(value, dict), "startup_continuation_inputs_required")
            # Deterministic continuation input mistakes must fail before the execution
            # fence: a schema error after start_execution() leaves an "executing"
            # marker with no complete receipt, which the inspector can only report as
            # reconciliation_required. This validates the input the action would write
            # (including the lifecycle/execution additions) without publishing anything.
            # Admission evidence is still rechecked after the fence, together with the
            # fresh context read, so later drift is caught before any write.
            from coordinator_tui_prepare import validate_inputs as validate_continuation_inputs
            validate_continuation_inputs(dict(value, startup_lifecycle=ref, execution=plan["execution"],
                                              startup_evidence=file_ref(root / "admission.json")),
                                           pre_execution=True)
        context(ref, call=call, actor=actor)
        def start_execution():
            publish(plan, root / f"{action}-executing.json", dict(lifecycle=ref, action=action,
                    accepted=accepted, input=input_ref, started_at=now()), actor=actor)
        if action != "dispatch":
            start_execution()
        if action == "materials":
            result = material(plan, contract, value)
            if not os.path.lexists(root / "binding.json"):
                publish(plan, root / "binding.json", dict(lifecycle=ref, spec=plan["spec"],
                    strict_start=plan["strict_start"], creation=creation["receipt"], run=contract["run"],
                    identity=identity(contract), bootstrap_owner=plan["bootstrap_owner"]), actor=actor)
        elif action == "review":
            materials = material(plan, contract, read_json(root / "materials.json"))
            contract_ref = publish(plan, root / "first-contract.json", pinned(materials["contract"]), actor=actor)
            gate = run_gate(contract_ref, phase="first-dispatch" if plan["workers"] == "required" else "run-readiness",
                            actor=actor, previous=parse(pinned(creation["receipt"]))["gate"])
            context(ref, call=call, actor=actor)
            gate_ref = publish(plan, root / "operator-gate.json", gate, actor=actor)
            result = dict(value, contract=contract_ref, gate=gate_ref, reviewed_at=now())
        elif action == "dispatch":
            from coordinator_first_dispatch import dispatch
            review_ref, review = review_head(plan)
            materials = material(plan, contract, read_json(root / "materials.json"))
            contract_ref = review["contract"]
            if plan["workers"] == "required":
                revision = len(list(root.glob("review-refresh-*-receipt.json")))
                first = root / (f"first-dispatch-{revision}" if revision else "first-dispatch")
                first.mkdir(mode=0o700, exist_ok=True)
                request = dict(materials["worker"], first_dispatch=dict(contract=contract_ref,
                               operator_gate=review["gate"], state_root=str(first)))
                if os.path.lexists(first / "request.json"):
                    require(read_json(first / "request.json") == request, "startup_dispatch_candidate_changed")
                else:
                    publish_new(first / "request.json", request)
                started = False
                def before_dispatch():
                    nonlocal started
                    context(ref, call=call, actor=actor)
                    if not started:
                        start_execution()
                        started = True
                options = {"before_dispatch": before_dispatch}
                if call:
                    options["query"] = lambda cli, runtime, args: call(args, runtime, 20)
                if dispatch_call:
                    options["call"] = dispatch_call
                dispatch(file_ref(first / "request.json"), **options)
                result = dict(kind="worker-dispatched", contract=contract_ref, run=contract["run"],
                              evidence=file_ref(first / "dispatched.json"), review=review_ref)
            else:
                gate = run_gate(contract_ref, phase="run-readiness", actor=actor, previous=review["gate"])
                start_execution()
                gate_ref = publish(plan, root / "run-readiness-gate.json", gate, actor=actor)
                result = dict(kind="no-worker-readiness", contract=contract_ref, run=contract["run"],
                              evidence=gate_ref, review=review_ref)
        else:
            from coordinator_tui_prepare import prepare
            admitted = admission(ref, confirmed(plan, root / "admission.json"))
            require(value.get("contract") == admitted["contract"] and value.get("dispatch_gate") == admitted["dispatch_gate"],
                    "startup_continuation_admission_required")
            value.update(startup_lifecycle=ref, execution=plan["execution"], startup_evidence=file_ref(root / "admission.json"))
            inputs = root / "continuation-inputs.json"
            publish_new(inputs, value)
            options = {"call": lambda cli, runtime, args: call(args, runtime, 20)} if call else {}
            result = prepare(file_ref(inputs), **options)
        context(ref, call=call, actor=actor)
        result_ref = publish(plan, root / OUTPUTS[action], result, actor=actor)
        receipt = publish(plan, root / f"{action}-complete.json", dict(lifecycle=ref, action=action,
            accepted=accepted, result=result_ref, completed_at=now()), actor=actor)
        return dict(ok=True, completed=receipt, result=result_ref, runtime_ready=False,
                    next_step="pull_same_lifecycle_immediately_no_long_worker_wait")


def admission(ref, evidence_ref):
    """Static admission check used before any continuation initialization writes."""
    from operator_startup import load
    plan, _, session, _ = load(ref)
    root = Path(plan["state_root"])
    require(evidence_ref == confirmed(plan, root / "admission.json"), "startup_admission_binding_changed")
    value = parse(pinned(evidence_ref))
    contract = parse(pinned(value["contract"]))
    require(identity(contract) == identity(session), "startup_admission_binding_changed")
    materials = material(plan, contract, read_json(confirmed(plan, root / "materials.json")["path"]))
    review_ref, review = review_head(plan)
    binding = read_json(confirmed(plan, root / "binding.json")["path"])
    require(binding["lifecycle"] == ref and binding["run"] == contract["run"]
            and binding["identity"] == identity(contract), "startup_admission_binding_changed")
    require(value["review"] == review_ref and review["decision"] == "approve"
            and review["materials"] == file_ref(root / "materials.json")
            and review["contract"] == value["contract"]
            and pinned(materials["contract"]) == pinned(value["contract"])
            and contract["run"] == value["run"], "startup_admission_binding_changed")
    if plan["workers"] == "required":
        require(value["kind"] == "worker-dispatched", "startup_dispatch_acceptance_required")
        from coordinator_first_dispatch import verify_accepted
        accepted = verify_accepted(value["evidence"], contract_ref=value["contract"])
        request = parse(pinned(accepted["request"]))
        require({k: v for k, v in request.items() if k != "first_dispatch"} == materials["worker"]
                and request["first_dispatch"]["operator_gate"] == review["gate"], "startup_dispatch_candidate_changed")
        gate_ref = accepted["gate"]
    else:
        require(value["kind"] == "no-worker-readiness", "startup_run_readiness_required")
        gate_ref = value["evidence"]
    gate = parse(pinned(gate_ref))
    phase = "first-dispatch" if plan["workers"] == "required" else "run-readiness"
    require(gate.get("kind") == KIND and gate.get("ok") is True and gate.get("actor") == "coordinator"
            and gate.get("phase") == phase and gate.get("contract_sha256") == value["contract"]["sha256"]
            and gate.get("identity_sha256") == digest(canonical(identity(contract)))
            and gate.get("previous_sha256") == review["gate"]["sha256"]
            and gate.get("run", {}).get("id") == contract["run"]["id"]
            and gate["run"].get("consumer_generation") == contract["run"]["generation"], "startup_admission_gate_changed")
    require(timestamp(gate["started_at"]) <= timestamp(gate["completed_at"])
            <= timestamp(gate["valid_until"]), "startup_admission_gate_changed")
    return dict(value, gate=gate, dispatch_gate=gate_ref if plan["workers"] == "required" else None)


def refresh_review(ref, input_ref, *, call=None):
    """Original Operator rechecks; only before ANY dispatch execution intent."""
    plan, _, contract, creation = context(ref, call=call, actor="operator")
    root = Path(plan["state_root"])
    with bound_lock(root, ref, "startup-role-action"):
        require(not dispatch_intents(root) and not os.path.lexists(root / "dispatch-executing.json")
                and not os.path.lexists(root / "admission.json"), "startup_refresh_after_dispatch_forbidden")
        previous, review = review_head(plan)
        value = parse(pinned(input_ref))
        require(set(value) == {"previous", "decision", "notes"} and value["previous"] == previous
                and value["decision"] == "approve" and isinstance(value["notes"], str) and value["notes"].strip(),
                "startup_independent_review_required")
        index = len(list(root.glob("review-refresh-*-receipt.json"))) + 1
        prefix = root / f"review-refresh-{index}"
        intent = publish(plan, str(prefix) + "-intent.json", dict(lifecycle=ref, input=input_ref,
                         previous=previous, operator=contract["operator"], started_at=now()), actor="operator")
        gate = run_gate(review["contract"], phase="first-dispatch" if plan["workers"] == "required" else "run-readiness",
                        actor="operator", previous=parse(pinned(creation["receipt"]))["gate"])
        context(ref, call=call, actor="operator")
        gate_ref = publish(plan, str(prefix) + "-gate.json", gate, actor="operator")
        result = publish(plan, str(prefix) + "-receipt.json", dict(review, **value, gate=gate_ref,
                         intent=intent, reviewed_at=now()), actor="operator")
        return dict(ok=True, review=result, retry_allowed=False, next_owner="coordinator")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("pull", "accept", "complete", "inspect", "refresh-review", "trigger-ready", "trigger-template"))
    parser.add_argument("--plan", required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--actor", choices=("coordinator", "operator"), required=True)
    parser.add_argument("--action", choices=tuple(ACTIONS))
    parser.add_argument("--input", help="Pinned candidate document; trigger-ready takes an independent review, not the raw preflight (see trigger-template)")
    parser.add_argument("--input-sha256")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--with-release-window", action="store_true",
                        help="trigger-template only: explicit v2 release deadline and safety margin")
    args = parser.parse_args(argv)
    try:
        ref = dict(path=args.plan, sha256=args.plan_sha256)
        require(not args.with_release_window or args.mode == "trigger-template", "startup_unexpected_release_window")
        require(args.mode in ("inspect", "trigger-template") or args.execute, "startup_explicit_execute_required")
        require(bool(args.input) == bool(args.input_sha256), "startup_input_pin_required")
        require(args.mode not in ("accept", "complete") or args.action is not None,
                "startup_action_required")
        # Existing generated inspect_argv includes an action hint. Inspect still
        # reports the actual next action, never mutates or trusts that hint.
        require(args.mode in ("accept", "complete", "inspect") or args.action is None,
                "startup_unexpected_action")
        needs_input = args.mode in ("refresh-review", "trigger-ready") or (
            args.mode == "complete" and args.action != "dispatch")
        require(not needs_input or args.input is not None, "startup_input_pin_required")
        require(needs_input or args.input is None, "startup_unexpected_input")
        from operator_monitor import native
        if args.mode == "trigger-template":
            # Deliberately scoped to the original Operator's independent review
            # workflow, not a general schema inspector or proof of identity.
            # Coordinator self-inspection would need a separate read-only entry.
            require(args.actor == "operator", "startup_original_role_required")
            from operator_startup import load
            from startup_execution import trigger_template
            plan, _, _, _ = load(ref)
            require(plan["execution"]["mode"] == "native-event", "startup_native_trigger_required")
            result = dict(ok=True, candidate_template=trigger_template(with_window=args.with_release_window),
                          execution_authorized=False, automatic_sends_allowed=False)
        elif args.mode == "inspect":
            result = inspect(ref, call=native, observe_idle=True)
        elif args.mode == "pull":
            result = task(ref, args.actor, call=native)
        elif args.mode == "accept":
            result = accept(ref, args.actor, args.action, call=native)
        elif args.mode in ("refresh-review", "trigger-ready"):
            require(args.actor == "operator", "startup_original_role_required")
            from startup_execution import attest_trigger
            result = (refresh_review if args.mode == "refresh-review" else attest_trigger)(
                ref, dict(path=args.input, sha256=args.input_sha256), call=native)
        else:
            result = complete(ref, args.actor, args.action,
                              dict(path=args.input, sha256=args.input_sha256) if args.input else None, call=native)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        from operator_readiness import unavailable
        result = dict(ok=False, state="review_required", reason=unavailable(exc), retry_allowed=False)
        # Export only these exact signed-RPC rejection strings, never arbitrary
        # exception bodies. This is diagnostic, not permission to replay.
        if isinstance(exc, ValueError) and str(exc) in {
                "bootstrap_rpc_rejected:startup_release_window_invalid",
                "bootstrap_rpc_rejected:startup_trigger_window_insufficient",
                "bootstrap_rpc_rejected:startup_trigger_readiness_expired",
                "bootstrap_rpc_rejected:bootstrap_owner_busy_not_executed"}:
            result["reason"] = str(exc)
        from blocking_io import BlockingIOTimeout
        if isinstance(exc, BlockingIOTimeout):
            result["diagnostics"] = exc.details
        if result["reason"] == "startup_trigger_review_required":
            from startup_execution import trigger_template
            result["candidate_template"] = trigger_template()
    print(canonical(result).decode())
    return 2 if result.get("ok") is False else 0


if __name__ == "__main__":
    raise SystemExit(main())
