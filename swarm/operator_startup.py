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
import coordinator_strict_start as strict
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_readiness as readiness
from blocking_io import bounded, run as bounded_io, BlockingIOTimeout


INPUT_KEYS = {"schema_version", "strict_start", "continuation_publication", "sender",
              "state_root", "monitor_state_root", "deployment_dir", "poll_seconds", "bootstrap_deadline"}
NEW_KEYS = {"execution", "workers", "bootstrap_owner"}


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
    start, contract, _, directory = strict.load(data["strict_start"])
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


def prepare(inputs_ref, output_dir):
    data = parse(pinned(inputs_ref))
    require(data.get("schema_version") == 2, "startup_new_inputs_v2_required")
    _, contract, directory = validate_inputs(data)
    require("runtime" in data, "startup_runtime_policy_required")
    strict.require_unstarted_attempt(directory)
    output = deploy.private_directory(output_dir)
    require(output == directory.parent / "lifecycle", "startup_owner_layout_required")
    registered = directory.parent / "control" / "owner.json"
    if os.path.lexists(directory.parent / "attempt-binding.json"):
        require(data["bootstrap_owner"] == file_ref(registered), "startup_original_owner_required")
    require(any(output.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "startup_path_outside_roots")
    require(not any(output.iterdir()), "startup_prepare_requires_fresh_directory")
    distinct = [Path(data[k]) for k in ("state_root", "monitor_state_root", "deployment_dir")]
    distinct.extend([Path(data["continuation_publication"]).parent, directory])
    require(all(not output.is_relative_to(p) and not p.is_relative_to(output) for p in distinct),
            "startup_directories_overlap")
    require(0 < (timestamp(data["bootstrap_deadline"]) - timestamp(now())).total_seconds() <= 3600,
            "startup_bootstrap_window_must_be_bounded_to_one_hour")
    require(all(not any(Path(data[k]).iterdir()) for k in ("state_root", "monitor_state_root", "deployment_dir")),
            "startup_prepare_requires_fresh_directory")
    require(not os.path.lexists(data["continuation_publication"]), "startup_existing_continuation_requires_review")
    # Direction: spec -> activation (base strict config + spec) -> lifecycle.
    # Neither the spec nor activation contains the lifecycle's downstream hash.
    spec = {**{k: data[k] for k in input_keys(data) - {"strict_start"}},
            "lifecycle_path": str(output / "lifecycle.json")}
    validate_spec(spec, data["strict_start"])
    from startup_handoff import publish
    publish(data, output / "spec.json", spec, actor="operator")
    spec_ref = file_ref(output / "spec.json")
    activation = dict(schema_version=4, base_config=data["strict_start"], lifecycle_spec=spec_ref)
    publish(data, output / "activation.json", activation, actor="operator")
    plan = dict(data, strict_start=file_ref(output / "activation.json"), spec=spec_ref,
                sources=deploy.sources(), python=str(Path(sys.executable).resolve()))
    publish(data, output / "lifecycle.json", plan, actor="operator")
    return file_ref(output / "lifecycle.json")


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
        from startup_handoff import admission
        accepted = admission(ref, config["startup_evidence"])
        require(accepted["contract"] == config["contract"] and accepted["run"] == contract["run"]
                and accepted["dispatch_gate"] == config["dispatch_gate"], "startup_admission_binding_changed")
        if require_executing:
            from startup_handoff import confirmed
            root = Path(plan["state_root"])
            confirmed(plan, root / "dispatch-complete.json")
            confirmed(plan, root / "continuation-accepted.json")
            confirmed(plan, root / "continuation-executing.json")


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


def publication(ref, creation):
    plan, _, _, _ = load(ref)
    filename = Path(plan["continuation_publication"])
    if not os.path.lexists(filename):
        return None
    publication_ref = file_ref(filename)
    continuation_ref = parse(pinned(publication_ref))
    require(isinstance(continuation_ref, dict)
            and continuation_ref.get("path") == str(filename.parent / "continuation.json"),
            "startup_continuation_publication_changed")
    config, contract, _ = readiness.load(continuation_ref)
    require(config.get("startup_lifecycle") == ref and contract["run"] == creation["run"],
            "startup_continuation_run_changed")
    if plan["schema_version"] == 2:
        from startup_handoff import confirmed
        completed = parse(pinned(confirmed(plan, Path(plan["state_root"]) / "continuation-complete.json")))
        receipt = parse(pinned(completed["result"]))
        require(receipt["config"] == continuation_ref and receipt["publication"] == publication_ref,
                "startup_continuation_handoff_unconfirmed")
    checked = readiness.continuation(continuation_ref)
    pinned(publication_ref)
    return dict(publication=publication_ref, config=continuation_ref, readiness=checked)


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


@bounded("startup_status")
def status(ref, *, call=None):
    """Read current evidence, never promote a cached monitor_ready milestone."""
    plan, _, contract, _ = load(ref)
    call = monitor.bind_contract(call, contract)
    state = read_state(plan, ref)
    result = dict(ok=False, state="bootstrap", monitor_ready=False, autonomy_verified=False,
                  runtime_ready=False, acceptance_complete=False,
                  next_owner="coordinator", missing=["run_created"], observed_at=now())
    try:
        creation = created(ref, call=call)
        previous = state["milestones"].get("run_created")
        require(previous is None or previous["evidence"] == creation, "startup_run_binding_changed")
        if creation is not None:
            result.update(run=creation, missing=["continuation_ready"])
            if plan["schema_version"] == 2:
                from startup_handoff import inspect
                result.update(inspect(ref, creation=creation, call=call, observe_idle=True))
            published = publication(ref, creation)
            require(state["continuation"] is None or (published is not None
                    and state["continuation"] == published["config"]), "startup_continuation_changed")
            if published is not None:
                previous = state["milestones"].get("continuation_ready")
                require(previous is None or previous["evidence"] == {k: published[k] for k in ("publication", "config")},
                        "startup_continuation_changed")
                result = readiness.for_continuation(published["config"], call=call)
                result.update(run=creation, publication=published["publication"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        result.update(state="review_required", next_owner="operator", missing=[readiness.unavailable(exc)])
    result.update(milestones=state["milestones"], lifecycle=ref)
    return result


def run(ref, *, once=False, call=None):
    """One durable foreground executor; once bounds diagnostics, not deployment proof."""
    plan, _, contract, _ = load(ref)
    call = monitor.bind_contract(call, contract)
    own_sender(plan, contract, call)
    root = Path(plan["state_root"])
    with bound_lock(root, ref, "operator-startup"):
        state = read_state(plan, ref)

        def save(current):
            state["current"] = {"runtime_ready": False, "acceptance_complete": False,
                                **current, "observed_at": now()}
            replace_json(root / "state.json", state)

        def milestone(name, evidence):
            if name not in state["milestones"]:
                state["milestones"][name] = dict(observed_at=now(), evidence=evidence)

        try:
            while True:
                load(ref)
                own_sender(plan, contract, call)
                creation = created(ref, call=call)
                previous = state["milestones"].get("run_created")
                require(previous is None or previous["evidence"] == creation, "startup_run_binding_changed")
                if creation is not None:
                    milestone("run_created", creation)
                published = publication(ref, creation) if creation else None
                require(state["continuation"] is None or published is not None, "startup_continuation_changed")
                if published is not None:
                    require(state["continuation"] in (None, published["config"]), "startup_continuation_changed")
                    previous = state["milestones"].get("continuation_ready")
                    require(previous is None or previous["evidence"] == {k: published[k] for k in ("publication", "config")},
                            "startup_continuation_changed")
                    state["continuation"] = published["config"]
                    milestone("continuation_ready", {k: published[k] for k in ("publication", "config")})
                    save(dict(state="continuation_ready", next_owner="operator", missing=["monitor_ready"]))
                    break
                require(timestamp(now()) < timestamp(plan["bootstrap_deadline"]), "startup_publication_deadline_expired")
                if creation and plan["schema_version"] == 2:
                    from startup_handoff import inspect
                    save(inspect(ref, creation=creation, call=call, observe_idle=True))
                else:
                    save(dict(state="awaiting_continuation" if creation else "awaiting_run_created",
                              next_owner="coordinator", missing=["continuation_ready" if creation else "run_created"]))
                if once:
                    return state["current"]
                time.sleep(plan["poll_seconds"])

            # A valid blocked/complete projection is still not a continuation to execute.
            require(published["readiness"]["eligible"], "startup_checkpoint_requires_review")
            if "runtime" in plan:
                from startup_execution import can_send
                can_send(parse(pinned(published["config"])))
            elif not state["attempts"]:
                require(timestamp(now()) < timestamp(plan["bootstrap_deadline"]), "startup_publication_deadline_expired")
            if state["deployment"] is None:
                reconcile = state["prepare_intent"]
                state["prepare_intent"] = True
                save(dict(state="preparing_monitor", next_owner="operator", missing=["monitor_ready"]))
                state["deployment"] = deploy.prepare(published["config"], plan["monitor_state_root"],
                    plan["deployment_dir"], poll_seconds=plan["poll_seconds"], call=call, reconcile=reconcile)
                save(dict(state="prepared_not_started", next_owner="operator", missing=["monitor_ready"]))
            deployment_ref = state["deployment"]
            _, config = deploy.validate(deployment_ref)
            require(deployment_ref["path"] == str(Path(plan["deployment_dir"]) / "deployment.json")
                    and config.data["continuation"] == published["config"]
                    and config.data["state_root"] == plan["monitor_state_root"]
                    and config.data["sender"] == plan["sender"], "startup_deployment_changed")
            require(not monitor.persistently_stopped(config), "startup_persistent_stop")
            if state["attempts"]:
                last = state["attempts"][-1]
                # Unknown launch outcome is never another run(). The original
                # executor may still own the monitor; only read-only status is safe.
                require(last.get("outcome") == "exited" and last.get("returncode") == 0,
                        "startup_launch_requires_reconciliation")
                require(file_ref(config.root / "deployment-status.json") == last["receipt"],
                        "startup_launch_receipt_changed")
                receipt = parse(pinned(last["receipt"]))
                require(receipt.get("phase") == "exited" and receipt.get("plan") == deployment_ref,
                        "startup_launch_requires_reconciliation")
            else:
                require(not os.path.lexists(config.root / "deployment-status.json"),
                        "startup_unowned_launch_requires_review")
                # Native preflight/static reconciliation may consume the rest
                # of the bootstrap window. Fence again at the launch boundary.
                if "runtime" in plan:
                    from startup_execution import can_send
                    can_send(parse(pinned(published["config"])))
                else:
                    require(timestamp(now()) < timestamp(plan["bootstrap_deadline"]),
                            "startup_publication_deadline_expired")
            intent = dict(deployment=deployment_ref, continuation=published["config"], at=now(),
                          attempt=len(state["attempts"]) + 1)
            intent_path = root / ("launch-intent-" + str(intent["attempt"]) + ".json")
            publish_new(intent_path, intent)
            attempt = dict(intent=file_ref(intent_path), outcome="unknown")
            state["attempts"].append(attempt)
            save(dict(state="launching", next_owner="operator", missing=["monitor_ready"]))

            def observe(event, receipt):
                if event == "tick":
                    checked = readiness.check(published["config"], deployment_ref, call=call)
                    if checked["monitor_ready"]:
                        milestone("monitor_ready", checked)
                    if plan["schema_version"] == 2 and checked.get("runtime_ready"):
                        milestone("runtime_ready", checked)
                    save(checked)
                else:
                    save(dict(state="monitor_" + event, monitor_ready=False,
                              next_owner="operator", missing=["monitor_ready"]))

            code = deploy.run(deployment_ref, once=once, observer=observe)
            attempt.update(outcome="exited", returncode=code,
                           receipt=(file_ref(config.root / "deployment-status.json")
                                    if (config.root / "deployment-status.json").exists() else None))
            save(dict(state="monitor_exited" if code == 0 else "revalidation_pending" if code == 3 else "review_required",
                      **({"ok": False} if code else {}), returncode=code,
                      monitor_ready=False, autonomy_verified=False,
                      next_owner="operator", missing=["monitor_ready"]))
            return state["current"]
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            save(dict(state="review_required", monitor_ready=False, autonomy_verified=False,
                      next_owner="operator", missing=[readiness.unavailable(exc)],
                      recovery="preserve_same_pins_state_and_intents_no_reset_or_blind_retry"))
            return state["current"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--inputs", required=True)
    p.add_argument("--inputs-sha256", required=True)
    p.add_argument("--output-dir", required=True)
    for name in ("check", "status", "run"):
        p = sub.add_parser(name)
        p.add_argument("--plan", required=True)
        p.add_argument("--plan-sha256", required=True)
        if name == "run":
            p.add_argument("--execute", action="store_true")
            p.add_argument("--confirm-skill-read", action="store_true")
            p.add_argument("--once", action="store_true")
    a = parser.parse_args(argv)
    try:
        if a.command == "prepare":
            ref = prepare(dict(path=a.inputs, sha256=a.inputs_sha256), a.output_dir)
            command = [str(Path(sys.executable).resolve()), "-B", str(Path(__file__).resolve()), "run",
                       "--plan", ref["path"], "--plan-sha256", ref["sha256"], "--execute", "--confirm-skill-read"]
            result = dict(state="prepared_not_started", plan=ref, native_sender_command=shlex.join(command))
        else:
            ref = dict(path=a.plan, sha256=a.plan_sha256)
            if a.command == "run":
                load(ref)
                require(a.execute and a.confirm_skill_read, "startup_execution_not_enabled")
                result = run(ref, once=a.once)
            else:
                if a.command == "status":
                    result = status(ref)
                else:
                    bounded_io(lambda: load(ref), name="startup_check")
                    result = dict(state="validated_not_started", plan=ref)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        result = dict(ok=False, state="review_required", missing=[readiness.unavailable(exc)])
        if isinstance(exc, BlockingIOTimeout):
            result["diagnostics"] = exc.details
    print(canonical(result).decode(), flush=True)
    return 2 if result.get("ok") is False or result["state"] == "review_required" else 0


if __name__ == "__main__":
    raise SystemExit(main())
