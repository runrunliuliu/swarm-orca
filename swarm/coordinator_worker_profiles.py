"""Resolve model-only Worker selection from reviewed, pinned local policy.

This is Swarm policy, not the Coordinator profile or a native capability probe.
The trusted Operator may select a policy file via SWARM_WORKER_PROFILES.
Requests still cannot select paths, override settings or request fallbacks.
"""

import os
from pathlib import Path

from coordinator_io import parse, pinned, require


PROFILES = Path(__file__).resolve().with_name("worker-model-profiles.json")


def resolve(model, sha256):
    # Preserve the supplied path for pinned()'s canonical/non-symlink checks.
    # An explicit invalid override must never fall back to the bundled fixture.
    source = os.environ.get("SWARM_WORKER_PROFILES", str(PROFILES))
    require(bool(source), "empty_worker_profiles_path")
    ref = {"path": source, "sha256": sha256}
    config = parse(pinned(ref))
    require(isinstance(config, dict) and set(config) == {"schema_version", "scope", "profiles"}
            and type(config["schema_version"]) is int and config["schema_version"] == 1
            and config["scope"] == "swarm_worker_only"
            and isinstance(config["profiles"], dict) and config["profiles"],
            "invalid_worker_profiles")
    for name, profile in config["profiles"].items():
        require(isinstance(name, str) and name.strip() and "\0" not in name
                and isinstance(profile, dict)
                and set(profile) == {"agent", "effort", "backend_variant", "blocked_reason"},
                "invalid_worker_profile")
        require(profile["agent"] == "trae"
                and profile["effort"] in (None, "high", "xhigh")
                and profile["backend_variant"] in ("max", "standard")
                and (profile["blocked_reason"] is None
                     or isinstance(profile["blocked_reason"], str) and profile["blocked_reason"].strip()),
                "invalid_worker_profile_settings")
    require(model in config["profiles"], "worker_model_not_in_fixed_profiles")
    profile = config["profiles"][model]
    require(profile["blocked_reason"] is None,
            "worker_profile_blocked:" + model + ":" + str(profile["blocked_reason"]))
    # Keep Standard scoped to the verified GPT-5.4 adapter.
    require((model == "gpt-5.4" and profile["backend_variant"] == "standard")
            or (model != "gpt-5.4" and profile["backend_variant"] == "max"),
            "worker_backend_adapter_unverified")
    settings = {"agent": profile["agent"], "model": model,
                "backend_variant": profile["backend_variant"]}
    if profile["effort"] is not None:
        settings["effort"] = profile["effort"]
    return settings, {"config": ref, "model": model, **profile}
