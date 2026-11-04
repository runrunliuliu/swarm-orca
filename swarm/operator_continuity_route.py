"""Explicit live routing under a Server-verified planned-restart transition.

The original contract, caller receipt, gate and checkpoint remain historical
evidence. This scope changes transport routing, never their stored runtime pins.
An older or unsupported Server refuses the maintenance request; there is no fallback.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from tempfile import TemporaryDirectory

from coordinator_io import canonical, digest, parse, pinned, publish_new, require


_active = ContextVar("operator_continuity_route", default=None)
_deployment = ContextVar("operator_continuity_deployment", default=None)


def maintenance_call(cli_ref, runtime_id, request, *, call=None):
    from trae_coordinator import native
    pinned(cli_ref)
    with TemporaryDirectory(prefix="orca-planned-request-") as folder:
        target = Path(folder).resolve() / "request.json"
        publish_new(target, request)
        return (call or native)(cli_ref["path"], runtime_id,
                               ["orchestration", "planned-restart", "--request-file", str(target)])


def server_boundary(transition, phase, evidence):
    old = parse(pinned(transition["old_plan"]))
    config = parse(pinned(old["config"]))
    continuation = parse(pinned(config["continuation"]))
    contract = parse(pinned(continuation["contract"]))
    return maintenance_call(contract["cli"], transition["target_runtime"], dict(phase="boundary",
                            transition=transition, operation=phase, evidence=evidence))


def validate(ref):
    value = parse(pinned(ref))
    require(set(value) == {"schema_version", "kind", "old_plan", "source_runtime", "target_runtime",
                           "server_id", "seal", "binding", "snapshot"}
            and value["schema_version"] == 1 and value["kind"] == "planned-restart-monitor-transition",
            "cross_runtime_invalid_transition")
    require(all(isinstance(value[k], str) and value[k] for k in
                ("source_runtime", "target_runtime", "server_id"))
            and value["source_runtime"] != value["target_runtime"], "cross_runtime_invalid_identity")
    old = parse(pinned(value["old_plan"]))
    config = parse(pinned(old["config"]))
    from operator_continuity_deployment import runtime_chain
    require(value["binding"] == config["binding"]
            and value["source_runtime"] == runtime_chain(value["old_plan"])[-1], "cross_runtime_binding_changed")
    pinned(value["seal"])
    return value


@contextmanager
def scope(ref, phase, evidence=None):
    if ref is None:
        yield
        return
    value = validate(ref)
    current = _active.get()
    require(current is None or current == value, "cross_runtime_conflicting_transition")
    expected = dict(transition_canonical_sha256=digest(canonical(value)), phase=phase)
    require(server_boundary(value, phase, evidence) == expected, "cross_runtime_server_boundary_unconfirmed")
    token = _active.set(value)
    deployment = _deployment.set((evidence or {}).get("plan"))
    try:
        yield
        pinned(ref)
    finally:
        _deployment.reset(deployment)
        _active.reset(token)


def runtime(historical):
    value = _active.get()
    if value is None:
        return historical
    from operator_continuity_deployment import runtime_chain
    require(historical in (*runtime_chain(value["old_plan"]), value["target_runtime"]),
            "cross_runtime_outside_transition")
    return value["target_runtime"]


def require_active(value):
    require(_active.get() == value, "cross_runtime_explicit_entry_required")


def require_permit(ref):
    if ref is not None:
        receipt = parse(pinned(ref))
        if receipt.get("kind") == "planned-restart-unclaimed-continuation-recovery":
            require_active(validate(parse(pinned(receipt["proposal"]))["transition"]))


def require_plan(plan):
    ref = plan.get("recovery", {}).get("transition")
    if ref is not None:
        require_active(validate(ref))


def require_monitor(config):
    ref = getattr(config, "recovery_plan", None)
    if ref is not None:
        require_plan(parse(pinned(ref)))


def anchor_matches(before, anchor):
    if before == anchor:
        return True
    value = _active.get()
    from operator_continuity_deployment import runtime_chain
    return (value is not None and isinstance(anchor, dict)
            and anchor.get("runtime", {}).get("runtimeId") in runtime_chain(value["old_plan"])
            and before.get("runtime", {}).get("runtimeId") == value["target_runtime"]
            and {k: v for k, v in before.items() if k != "runtime"}
            == {k: v for k, v in anchor.items() if k != "runtime"})


def routed(call):
    return lambda args, historical, timeout=20: call(args, runtime(historical), timeout)


def coordinator_call(call):
    return lambda cli, historical, args: call(cli, runtime(historical), args)


def continuation_plan():
    return _deployment.get()
