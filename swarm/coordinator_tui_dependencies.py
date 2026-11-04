"""Native wait references carried by RSI's existing, domain-pinned prerequisites.

No schema extension or inference from prose. Historical dependencies objects are
read explicitly for compatibility, never added to or removed from a domain source.
"""

from coordinator_tui_errors import require


PREFIXES = {"orca-dispatch:": "dispatches", "orca-job:": "jobs"}


def wait_spec(action):
    refs = action.get("prerequisites", [])
    require(isinstance(refs, list) and all(isinstance(v, str) and v for v in refs)
            and len(refs) == len(set(refs)), "tui_wait_dependencies_required")
    spec = {"dispatches": [], "jobs": []}
    for ref in refs:
        for prefix, kind in PREFIXES.items():
            if ref.startswith(prefix):
                value = ref[len(prefix):]
                require(value and not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value),
                        "tui_wait_dependency_reference_invalid")
                spec[kind].append(value)
    legacy = action.get("dependencies")
    if "dependencies" in action:
        require(isinstance(legacy, dict) and set(legacy) == set(spec)
                and all(isinstance(v, list) and all(isinstance(k, str) and k for k in v)
                        and len(v) == len(set(v)) for v in legacy.values())
                and any(legacy.values()), "tui_wait_dependencies_required")
        require(not any(spec.values()), "tui_wait_dependency_encodings_mixed")
        return legacy
    require(any(spec.values()), "tui_wait_dependencies_required")
    return spec
