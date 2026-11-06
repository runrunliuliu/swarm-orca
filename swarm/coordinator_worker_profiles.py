"""Resolve model-only Worker selection from reviewed, pinned local policy.

This is Swarm policy, not the Coordinator profile or a native capability probe.
The trusted Operator may select a policy file via SWARM_WORKER_PROFILES.
Requests still cannot select paths, override settings or request fallbacks.
"""

import os
from pathlib import Path

from coordinator_io import FilePinChanged, digest, parse, pinned, read_bytes, require


PROFILES = Path(__file__).resolve().with_name("worker-model-profiles.json")


def source():
    """Return the policy path the caller must pin; an override never falls back."""
    return os.environ.get("SWARM_WORKER_PROFILES", str(PROFILES))


def reviewed(source_path, sha256):
    """Read the active policy without conflating a wrong pin source with a change."""
    try:
        return pinned({"path": source_path, "sha256": sha256})
    except OSError:
        # Missing, unreadable or non-canonical override: an explicit, path-free refusal.
        require(False, "worker_profiles_unreadable")
    except FilePinChanged:
        require(not pins_bundled_fixture(source_path, sha256),
                "worker_profiles_pin_source_mismatch")
        raise


def pins_bundled_fixture(source_path, sha256):
    """Only a pin taken from the bundled file while an override is active can do this."""
    if source_path == str(PROFILES):
        return False
    try:
        return sha256 == digest(read_bytes(PROFILES))
    except OSError:
        return False


def resolve(model, sha256):
    # Preserve the supplied path for pinned()'s canonical/non-symlink checks.
    # An explicit invalid override must never fall back to the bundled fixture.
    active = source()
    require(bool(active), "empty_worker_profiles_path")
    ref = {"path": active, "sha256": sha256}
    config = parse(reviewed(active, sha256))
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
        require(profile["agent"] in ("trae", "pi")
                and (profile["blocked_reason"] is None
                     or isinstance(profile["blocked_reason"], str) and profile["blocked_reason"].strip()),
                "invalid_worker_profile_settings")
        if profile["agent"] == "trae":
            require(profile["effort"] in (None, "high", "xhigh")
                    and profile["backend_variant"] in ("max", "standard"),
                    "invalid_worker_profile_settings")
        else:
            # A Pi profile is one provider-qualified --model selector. Trae effort and Max
            # are not Pi thinking levels, so carrying either here is rejected, not converted.
            require(profile["effort"] is None and profile["backend_variant"] is None,
                    "invalid_pi_profile_settings")
    require(model in config["profiles"], "worker_model_not_in_fixed_profiles")
    profile = config["profiles"][model]
    require(profile["blocked_reason"] is None,
            "worker_profile_blocked:" + model + ":" + str(profile["blocked_reason"]))
    if profile["agent"] == "trae":
        # Keep Standard scoped to the verified GPT-5.4 adapter.
        require((model == "gpt-5.4" and profile["backend_variant"] == "standard")
                or (model != "gpt-5.4" and profile["backend_variant"] == "max"),
                "worker_backend_adapter_unverified")
    settings = {"agent": profile["agent"], "model": model}
    for key in ("effort", "backend_variant"):
        if profile[key] is not None:
            settings[key] = profile[key]
    return settings, {"config": ref, "model": model, **profile}
