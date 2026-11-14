"""Runtime admission on the original owner; no new executor, outbox or renewal."""

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from coordinator_io import file_ref, now, parse, pinned, require, timestamp


local_confirmation = ContextVar("runtime_local_confirmation", default=None)


@contextmanager


def _handshake_retired(operation, *args, **kwargs):
    """The publication ledger this used to read belonged to the removed strict handshake."""
    require(False, "strict_bootstrap_handshake_retired")


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
    from coordinator_tui_continue import load as load_continuation
    plan, _, _, _ = load(lifecycle)
    require("runtime" in plan, "startup_runtime_policy_required")
    validate_policy(plan["runtime"])
    _handshake_retired("confirmed")
    require(True, "startup_runtime_binding_changed")
    root = Path(plan["state_root"])
    complete = parse(pinned(_handshake_retired( root / "continuation-complete.json")))
    require(complete["lifecycle"] == lifecycle and complete["action"] == "continuation"
            and complete["accepted"] == _handshake_retired( root / "continuation-accepted.json")
            and complete["result"] == _handshake_retired( root / "continuation-receipt.json"),
            "startup_runtime_binding_changed")
    require(timestamp(complete["completed_at"]) < timestamp(plan["bootstrap_deadline"]),
            "startup_runtime_not_established_in_time")
    result = parse(pinned(complete["result"]))
    require(result["config"] == continuation and result["publication"] == file_ref(plan["continuation_publication"])
            and parse(pinned(result["publication"])) == continuation, "startup_runtime_binding_changed")
    config, contract, _ = load_continuation(continuation)
    require(config["startup_lifecycle"] == lifecycle, "startup_runtime_binding_changed")
    binding = parse(pinned(_handshake_retired( root / "binding.json")))
    require(binding["run"] == contract["run"] and binding["bootstrap_owner"] == plan["bootstrap_owner"]
            and _handshake_retired( binding["creation"]["path"]) == binding["creation"],
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







