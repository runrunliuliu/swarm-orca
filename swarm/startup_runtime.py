"""Runtime admission on the original owner; no new executor, outbox or renewal."""

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from coordinator_io import canonical, digest, file_ref, now, parse, pinned, require, timestamp


local_confirmation = ContextVar("runtime_local_confirmation", default=None)


@contextmanager
def owner_queries(owner, owner_ref):
    # The serial RPC server must NEVER reconnect to its own socket.
    token = local_confirmation.set((owner, owner_ref))
    try:
        yield
    finally:
        local_confirmation.reset(token)


def validate_policy(value):
    require(isinstance(value, dict) and set(value) == {"schema_version", "deadline", "authority"}
            and type(value["schema_version"]) is int and value["schema_version"] == 1,
            "startup_runtime_policy_required")
    require(value["deadline"] is None or isinstance(value["deadline"], str), "startup_runtime_deadline_invalid")
    if value["deadline"] is not None:
        timestamp(value["deadline"])
    require(isinstance(value["authority"], list) and value["authority"], "startup_runtime_authority_required")
    for ref in value["authority"]:
        pinned(ref)
    return value


def established(lifecycle, continuation):
    """Validate original publication/confirmation, including the full gate chain."""
    from operator_startup import load
    from startup_handoff import confirmed
    from coordinator_tui_continue import load as load_continuation
    plan, _, _, _ = load(lifecycle)
    require("runtime" in plan, "startup_runtime_policy_required")
    validate_policy(plan["runtime"])
    require(confirmed(plan, lifecycle["path"]) == lifecycle, "startup_runtime_binding_changed")
    root = Path(plan["state_root"])
    complete = parse(pinned(confirmed(plan, root / "continuation-complete.json")))
    require(complete["lifecycle"] == lifecycle and complete["action"] == "continuation"
            and complete["accepted"] == confirmed(plan, root / "continuation-accepted.json")
            and complete["result"] == confirmed(plan, root / "continuation-receipt.json"),
            "startup_runtime_binding_changed")
    require(timestamp(complete["completed_at"]) < timestamp(plan["bootstrap_deadline"]),
            "startup_runtime_not_established_in_time")
    result = parse(pinned(complete["result"]))
    require(result["config"] == continuation and result["publication"] == file_ref(plan["continuation_publication"])
            and parse(pinned(result["publication"])) == continuation, "startup_runtime_binding_changed")
    config, contract, _ = load_continuation(continuation)
    require(config["startup_lifecycle"] == lifecycle, "startup_runtime_binding_changed")
    binding = parse(pinned(confirmed(plan, root / "binding.json")))
    require(binding["run"] == contract["run"] and binding["bootstrap_owner"] == plan["bootstrap_owner"]
            and confirmed(plan, binding["creation"]["path"]) == binding["creation"],
            "startup_runtime_binding_changed")
    deadline = plan["runtime"]["deadline"]
    require(deadline is None or timestamp(now()) < timestamp(deadline), "startup_runtime_deadline_expired")
    return plan, config, contract


def continuation_ref(config):
    """Resolve the fixed publication for either monitor or continuation input."""
    from operator_startup import load
    plan, _, _, _ = load(config["startup_lifecycle"])
    ref = parse(pinned(file_ref(plan["continuation_publication"])))
    if "continuation" in config:
        require(config["continuation"] == ref and config["sender"] == plan["sender"]
                and config["state_root"] == plan["monitor_state_root"]
                and config["execution"] == plan["execution"], "startup_runtime_binding_changed")
        continuation = parse(pinned(ref))
        contract = parse(pinned(continuation["contract"]))
        require(config["binding"] == dict(runtime=contract["runtime"], run=contract["run"]["id"],
                generation=contract["run"]["generation"], workspace=contract["workspace"]["id"],
                terminal=contract["coordinator"]["terminal"], incarnation=contract["coordinator"]["incarnation"]),
                "startup_runtime_binding_changed")
    else:
        require(parse(pinned(ref)) == config, "startup_runtime_binding_changed")
    return ref


def acceptance(config, deployment):
    """Exact configuration accepted under the monitor lock, prior to first tick."""
    if "startup_lifecycle" not in config:
        return None
    from operator_startup import load
    plan, _, _, _ = load(config["startup_lifecycle"])
    if "runtime" not in plan:
        return None
    from startup_execution import can_send
    can_send(config)  # Current control health, not runtime_ready: no circularity.
    _, _, contract = established(config["startup_lifecycle"], config["continuation"])
    return dict(schema_version=1, lifecycle=config["startup_lifecycle"], continuation=config["continuation"],
                deployment=deployment, sender=plan["sender"], run=contract["run"],
                runtime=plan["runtime"], execution=plan["execution"], bootstrap_owner=plan["bootstrap_owner"],
                responsibility="observe_and_authorized_schedule_only")


def input_target(plan, mailbox):
    return str(Path(plan["state_root"]) / ("runtime-input-" + digest(canonical(mailbox)) + ".json"))


def validate_input(candidate, mailbox, plan, config, contract):
    """Only pinned no-authority-change reviews; no consume, ACK or execution."""
    require(isinstance(candidate, dict) and set(candidate) == {"lifecycle", "mailbox", "handled"}
            and candidate["lifecycle"] == config["startup_lifecycle"]
            and parse(pinned(candidate["mailbox"])) == mailbox
            and isinstance(candidate["handled"], list) and len(candidate["handled"]) == mailbox["count"]
            and mailbox["count"] > 0, "startup_operator_input_binding_changed")
    ids = set()
    for message, handled_ref in zip(mailbox["messages"], candidate["handled"]):
        require(isinstance(message, dict) and isinstance(message.get("id"), str) and message["id"] and message["id"] not in ids
                and message.get("run_id") == contract["run"]["id"]
                and message.get("from_handle") == contract["coordinator"]["terminal"]
                and message.get("to_handle") == contract["operator"]["terminal"],
                "startup_operator_input_source_unverified")
        ids.add(message["id"])
        payload = message.get("payload")
        if isinstance(payload, str):
            payload = parse(payload.encode())
        require(isinstance(payload, dict) and set(payload) == {"kind", "request"}
                and payload["kind"] == "operator_runtime_review_v1", "startup_operator_input_unsupported")
        request = parse(pinned(payload["request"]))
        require(isinstance(request, dict) and set(request) == {"request_id", "run", "source", "input"}
                and isinstance(request["request_id"], str) and request["request_id"]
                and request["run"] == contract["run"] and request["source"] == message["from_handle"],
                "startup_operator_input_request_changed")
        pinned(request["input"])
        handled = parse(pinned(handled_ref))
        require(isinstance(handled, dict) and set(handled) == {"kind", "request", "message_sha256", "run", "operator", "decision", "notes", "evidence"}
                and handled["kind"] == "operator_runtime_input_handled"
                and handled["request"] == payload["request"] and handled["message_sha256"] == digest(canonical(message))
                and handled["run"] == contract["run"] and handled["operator"] == contract["operator"]
                and handled["decision"] == "no-authority-change" and isinstance(handled["notes"], str)
                and handled["notes"].strip() and isinstance(handled["evidence"], list) and handled["evidence"],
                "startup_operator_input_handling_required")
        for ref in handled["evidence"]:
            pinned(ref)
    validate_policy(plan["runtime"])


def check_inputs(owner, plan, config, contract):
    from bootstrap_identity import OperatorInputPending
    mailbox = owner.identity.mailbox
    require(isinstance(mailbox, dict), "bootstrap_operator_mailbox_unverifiable")
    if mailbox["count"] == 0:
        return
    target = Path(input_target(plan, mailbox))
    if not target.exists():
        raise OperatorInputPending("startup_operator_input_review_required")
    ref = file_ref(target)
    require(owner.query(owner.control, ref).status == "confirmed", "startup_operator_input_unconfirmed")
    receipt = parse(pinned(ref))
    require(receipt["lifecycle"] == config["startup_lifecycle"], "startup_operator_input_binding_changed")
    validate_input(parse(pinned(receipt["candidate"])), mailbox, plan, config, contract)


def operator_action(owner, owner_ref, op, args, peer):
    from bootstrap_identity import unchanged
    reviewing = op == "runtime-review-input"
    def context(*, local=False):
        unchanged(peer)
        require(owner.identity.authenticate(peer) == "operator", "bootstrap_runtime_operator_required")
        if not local:
            owner.refresh(force=True, runtime=True)
        check = owner.runtime_local if local else owner.runtime_context
        return check(args["lifecycle"], args["continuation"], owner_ref, review_input=reviewing)
    def value_for(plan, config, contract):
        if reviewing:
            candidate = parse(pinned(args["candidate"]))
            validate_input(candidate, owner.identity.mailbox, plan, config, contract)
            target = input_target(plan, owner.identity.mailbox)
            value = dict(lifecycle=args["lifecycle"], candidate=args["candidate"], reviewed_at=now())
        else:
            from startup_execution import trigger_review
            with owner_queries(owner, owner_ref):
                value = trigger_review(args["lifecycle"], args["candidate"], plan, contract)
            target = plan["execution"]["trigger"]["readiness"]
        return target, value
    target, value = value_for(*context())
    def recheck():
        checked_target, checked = value_for(*context(local=True))
        require(checked_target == target, "startup_operator_input_binding_changed")
        key = "reviewed_at" if reviewing else "checked_at"
        require({k: v for k, v in checked.items() if k != key} ==
                {k: v for k, v in value.items() if k != key}, "startup_runtime_binding_changed")
        # Candidate/evidence reads may be slow. Fence again after them, without
        # native I/O under the publication lock or retrying any publication.
        context(local=True)
    return owner.runtime_publish(target, value, recheck)


def main(argv=None):
    import argparse
    from startup_handoff import authority
    from operator_startup import load
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("review-input",))
    for name in ("lifecycle", "candidate"):
        parser.add_argument("--" + name, required=True)
        parser.add_argument("--" + name + "-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    require(args.execute, "startup_runtime_review_not_enabled")
    ref = dict(path=args.lifecycle, sha256=args.lifecycle_sha256)
    plan, _, _, _ = load(ref)
    require(plan["bootstrap_owner"] is not None, "startup_original_owner_required")
    _, owner = authority(plan)
    result = owner.rpc("runtime-review-input", lifecycle=ref,
        continuation=parse(pinned(file_ref(plan["continuation_publication"]))),
        candidate=dict(path=args.candidate, sha256=args.candidate_sha256))
    print(canonical(dict(receipt=result, execution_authorized=False, messages_acked=False)).decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
