"""Reviewed Pi Coordinator runtime policy: the Pi analogue of a Trae exec config.

Trae's strict startup pins a runtime config that states sandbox/approval/launch
mode and the model, and the TUI gate re-verifies the transcript's per-turn
settings against it. Pi has no sandbox/approval surface, so this record replaces
that file with exactly what Pi can attest: the provider, the model selector and
the thinking level. It is a reviewed, pinned input of the strict contract, not a
policy the agent writes for itself.

Validation is exact-shape and fail-closed; a missing or extra field is refused
rather than ignored, so a policy cannot silently claim more than Pi proves.
"""

from pathlib import Path

from coordinator_io import parse, require
from swarm_ledger import runtime_binding

SCHEMA_VERSION = 1
SCOPE = "swarm_coordinator_only"
PROVIDER = "pi"
FIELDS = {"schema_version", "scope", "provider", "model", "thinking_level"}


def text(value, code="pi_runtime_policy_invalid"):
    require(isinstance(value, str) and value.strip() and not any(ord(c) < 32 for c in value), code)
    return value


def validate(value):
    """Validate the reviewed policy; returns the settings the observer must match."""
    require(isinstance(value, dict) and set(value) == FIELDS, "pi_runtime_policy_invalid")
    require(type(value["schema_version"]) is int and value["schema_version"] == SCHEMA_VERSION,
            "pi_runtime_policy_version_unsupported")
    require(value["scope"] == SCOPE and value["provider"] == PROVIDER,
            "pi_runtime_policy_scope_invalid")
    model = value["model"]
    require(isinstance(model, dict) and set(model) == {"provider", "id"},
            "pi_runtime_policy_invalid")
    return {"model_provider": text(model["provider"], "pi_runtime_policy_model_required"),
            "model": text(model["id"], "pi_runtime_policy_model_required"),
            "thinking_level": text(value["thinking_level"],
                                   "pi_runtime_policy_thinking_level_required")}


def read(path):
    """Read one reviewed policy from a complete, same-user ordinary file."""
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, "pi_runtime_policy_path_invalid")
    with runtime_binding.ordinary_file(path) as (source, info):
        content = source.read(info.st_size)
        require(len(content) == info.st_size and content.strip(), "pi_runtime_policy_truncated")
    return validate(parse(content))


def settings(observed):
    """The settings a Pi observation can prove, compared exactly and by name."""
    return {key: observed.get(key) for key in ("model_provider", "model", "thinking_level")}
