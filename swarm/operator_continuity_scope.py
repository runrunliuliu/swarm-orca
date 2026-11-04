"""Deterministic deployment reference projection, not a native continuity seal.

Domain evidence labels stay opaque: only their enclosing source/receipt is pinned.
No recursive path guessing, evidence expansion, filesystem walk or publication.
"""

from coordinator_io import canonical, digest, parse, pinned, require


def deployment_scope(plan_ref, parts, snapshot):
    plan, config, cref, continuation, contract, roots = parts
    require(config["watch_file"] is None and not config["adapters"] and not config["artifact_roots"],
            "continuity_source_requires_scheduler_only_scope")
    require("execution" not in continuation, "startup_lifecycle_recovery_requires_separate_review")
    refs = {}

    def add(ref):
        pinned(ref)
        require(refs.get(ref["path"], ref) == ref, "continuity_source_conflicting_file_pins")
        refs[ref["path"]] = ref
        require(len(refs) <= 256, "continuity_source_reference_limit")

    for ref in (plan_ref, plan["config"], cref, continuation["contract"], continuation["dispatch_gate"],
                continuation["acceptance"], snapshot["head"], snapshot["stop"]):
        add(ref)
    for key in ("runtime_config", "role_skill", "handoff", "skill_read_evidence"):
        add(contract[key])
    for key in ("caller_receipt", "startup_anchor"):
        add(contract["observation"][key])
    for entry in snapshot["outbox"]["actions"].values():
        add(entry["checkpoint"])
        record = parse(pinned(entry["checkpoint"]))
        for key in ("source", "receipt"):
            add(record["domain_check"][key])
        if entry["result"] is not None:
            add(entry["result"])
            for ref in parse(pinned(entry["result"]))["evidence"]:
                add(ref)
    code = [contract["cli"], *plan["sources"]]
    for ref in code:
        pinned(ref)
    # Code/executables need not be private state files; never chmod or silently omit them.
    value = dict(schema_version=1, monitor_state_root=str(roots[0]), continuation_state_root=str(roots[1]),
                 evidence_refs=[refs[key] for key in sorted(refs)], code_refs=code,
                 coverage="deployment_direct_refs_only")
    return dict(projection=value, projection_canonical_sha256=digest(canonical(value)))
