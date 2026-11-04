"""Read a completed recovery chain without rewriting its historical configuration."""

from coordinator_io import parse, pinned, require


def recovery_data(plan):
    recovery = plan.get("recovery", {})
    if recovery.get("kind") == "monitor-source-only-upgrade":
        from operator_monitor_upgrade import deployment_recovery
    else:
        from operator_monitor_recovery import deployment_recovery
    return deployment_recovery(plan)


def original(plan_ref):
    from operator_sender_correct import original as initial
    plan = parse(pinned(plan_ref))
    if plan.get("schema_version") != 3:
        return initial(plan_ref)
    recovery = recovery_data(plan)
    proposal = parse(pinned(parse(pinned(recovery["permit"]))["proposal"]))
    parts = original(proposal["old_plan"])
    return (plan, *parts[1:])


def runtime_chain(plan_ref):
    """The immutable previous transition is the only authority for a successor pin."""
    plan = parse(pinned(plan_ref))
    config = parse(pinned(plan["config"]))
    if plan.get("schema_version") != 3:
        require(plan.get("schema_version") == 2, "continuity_requires_native_deployment")
        return [config["binding"]["runtime"]]
    recovery = recovery_data(plan)
    proposal = parse(pinned(parse(pinned(recovery["permit"]))["proposal"]))
    chain = runtime_chain(proposal["old_plan"])
    if "transition" not in recovery:
        return chain
    previous = parse(pinned(recovery["transition"]))
    require(previous["old_plan"] == proposal["old_plan"], "continuity_transition_chain_changed")
    return [*chain, previous["target_runtime"]]


def stop_path(plan, root):
    recovery = plan.get("recovery")
    return root / ("recovery-stop-" + recovery["permit"]["sha256"] + ".json"
                   if recovery else "monitor-stop.json")
