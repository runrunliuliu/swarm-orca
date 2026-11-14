"""Shared strict business task-source validation.

The business objective is reviewed once and then reused by preparation and
strict startup request builders. Recovery prose is separate context; it never
rewrites the objective or authority.
"""

STRICT_REQUEST_INPUT_SCHEMA_VERSION = 4
STRICT_REQUEST_SCHEMA_VERSION = 5


def strict_request_version_text(*, independently_reviewed=False, null_note=False):
    qualifier = "independently reviewed " if independently_reviewed else "reviewed "
    note = " and separate recovery_note"
    if null_note:
        note += " (null if absent)"
    return (
        f"Use input schema v{STRICT_REQUEST_INPUT_SCHEMA_VERSION} with {qualifier}"
        f"contract_fields pin and task_source pin{note}; it generates request schema "
        f"v{STRICT_REQUEST_SCHEMA_VERSION}."
    )


def require(condition, code):
    # Lazy import keeps phase-contract text free to import this module while
    # coordinator_strict is still defining its own helpers.
    from coordinator_strict import require as strict_require
    strict_require(condition, code)


def unique_refs(refs):
    """Same shape rule the strict request used to import from the delivery module."""
    from coordinator_io import require, validate_ref
    from pathlib import Path

    require(isinstance(refs, list) and refs, "strict_config_evidence_required")
    result = []
    for ref in refs:
        validate_ref(ref)
        require(Path(ref["path"]).is_absolute(), "strict_config_evidence_path_invalid")
        if ref not in result:
            result.append(ref)
    return result


def _validated_task(value, *, pin_authority):
    from coordinator_io import parse, pinned

    task = parse(pinned(value["task_source"]))
    require(isinstance(task, dict) and set(task) == {
        "schema_version", "kind", "workspace", "objective", "authorization_refs"}
        and type(task["schema_version"]) is int and task["schema_version"] == 1
        and task["kind"] == "strict_business_task", "strict_config_task_source_invalid")
    require(task["workspace"] == value["workspace"], "strict_config_task_source_scope_mismatch")
    objective = task["objective"]
    require(isinstance(objective, str) and objective.strip() and "\0" not in objective
            and len(objective.encode()) <= 16384, "strict_config_task_invalid")
    authorization_refs = unique_refs(task["authorization_refs"])
    if pin_authority:
        for ref in authorization_refs:
            pinned(ref)
    note = value["recovery_note"]
    require(note is None or (isinstance(note, str) and note.strip() and "\0" not in note
                            and len(note.encode()) <= 16384), "strict_config_recovery_note_invalid")
    return task, authorization_refs, objective


def task_source_refs(value):
    """Return the explicit business task and nested authorization pins for scope checks."""
    _, authorization_refs, _ = _validated_task(value, pin_authority=False)
    return [value["task_source"], *authorization_refs]


def task_objective(value):
    """Read an independently reviewed task, never infer authority from recovery prose."""
    _, _, objective = _validated_task(value, pin_authority=True)
    return objective


def task_source_summary(value):
    """Validate a pinned task source and return reusable non-authorizing metadata."""
    objective = task_objective(value)
    return {
        "task_source": value["task_source"],
        "workspace": value["workspace"],
        "objective": objective,
        "recovery_note": value["recovery_note"],
    }
