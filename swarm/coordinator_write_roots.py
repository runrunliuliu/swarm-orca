"""Observe workspace-write roots without confusing configuration with a tool probe."""

from pathlib import Path


def _canonical_root(value):
    if not isinstance(value, (str, Path)):
        raise ValueError("invalid session write root")
    root = Path(value)
    if not root.is_absolute() or root.resolve(strict=True) != root or not root.is_dir():
        raise ValueError("session write root must be an existing canonical directory")
    return str(root)


def observe_write_roots(cwd, sandbox, required):
    """The verified cwd is implicit; extra roots must still be explicitly present."""
    if not isinstance(sandbox, dict) or sandbox.get("type") != "workspace-write":
        raise ValueError("workspace-write policy required")
    explicit = sandbox.get("writable_roots")
    if not isinstance(explicit, list) or not isinstance(required, (list, tuple)):
        raise ValueError("invalid session write roots")
    implicit = _canonical_root(cwd)
    explicit = [_canonical_root(root) for root in explicit]
    required = [_canonical_root(root) for root in required]
    if not set(required).issubset({implicit, *explicit}):
        raise ValueError("actual session write roots missing")
    return {"implicit_cwd": implicit, "explicit_roots": explicit,
            "required_roots": required, "file_tool_probe_verified": False}
