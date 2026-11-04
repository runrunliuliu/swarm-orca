"""Provider-neutral evidence freshness and immutable file-probe reuse.

This is not a permission grant or process attestation. Native identity and the
provider's effective settings must still be observed on every preflight.
"""

import hashlib
import json
import os
from pathlib import Path
import stat


def age_limit(contract, kind):
    if contract["schema_version"] == 1:
        return contract["limits"]["evidence_max_age_seconds"]
    return contract["freshness"][kind + "_max_age_seconds"]


def validate_v2(contract, require):
    freshness = contract["freshness"]
    require(isinstance(freshness, dict) and set(freshness) == {
        "session_max_age_seconds", "file_tool_max_age_seconds"}, "invalid_freshness")
    for kind in ("session", "file_tool"):
        value = age_limit(contract, kind)
        require((kind == "file_tool" and value is None)
                or (type(value) is int and 0 < value <= 2**31 - 1), "invalid_evidence_age")
    preparation = contract["preparation"]
    require(isinstance(preparation, dict) and set(preparation) == {"attempt", "max_attempts"},
            "invalid_preparation_attempt")
    require(all(type(preparation[key]) is int for key in preparation)
            and 1 <= preparation["attempt"] <= preparation["max_attempts"] <= 32,
            "preparation_attempt_limit")
    # An adapter is an implementation capability, never inferred from a model name.
    require(contract["adapter"] == "codex-local"
            and contract["terminal"]["agent"] == "codex", "unsupported_session_adapter")
    roots = contract["probe_roots"]
    require(isinstance(roots, list) and 1 <= len(roots) <= 37
            and all(isinstance(p, str) for p in roots)
            and len(set(roots)) == len(roots), "invalid_probe_roots")


def directory_identity(path):
    path = Path(path)
    info = path.stat()
    return {"path": str(path), "device": str(info.st_dev), "inode": str(info.st_ino),
            "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}


def probe_scope(contract, directories, read_bytes):
    """Bind relevant inputs, not timestamps, evidence filenames or attempt numbers."""
    digest = lambda data: hashlib.sha256(data).hexdigest()
    value = {key: contract[key] for key in (
        "runtime_id", "runtime_version", "run_id", "workspace", "terminal", "session",
        "paths", "runtime_state", "adapter", "probe_roots")}
    value["directories"] = directories
    inputs = [contract["cli"], *contract["config_files"], *contract["policy_files"],
              str(Path(__file__).resolve()),
              *[str(Path(__file__).with_name(name).resolve()) for name in
                ("coordinator_prepare.py", "coordinator_prepare.js", "native_preflight.py", "log_io.py")]]
    value["inputs"] = [{"path": str(Path(p).resolve()), "sha256": digest(read_bytes(p))}
                       for p in inputs]
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def verify_probe(value, contract, read_bytes, require):
    """Re-read original tiny probe files; never refresh their completion timestamp."""
    proof = value.get("probe")
    require(isinstance(proof, dict) and set(proof) == {
        "directories", "files", "absent", "scope_sha256"}, "file_tool_reuse_proof_missing")
    directories, files, absent = (proof[key] for key in ("directories", "files", "absent"))
    require(isinstance(directories, list) and 1 <= len(directories) <= 37
            and isinstance(files, dict) and len(files) == len(directories)
            and isinstance(absent, list) and len(absent) == len(directories),
            "invalid_file_tool_reuse_proof")
    roots = []
    for expected in directories:
        require(isinstance(expected, dict) and isinstance(expected.get("path"), str),
                "invalid_file_tool_directory")
        path = Path(expected["path"])
        require(str(path) in contract["probe_roots"] and path.is_absolute()
                and path != Path(path.anchor)
                and not any(path == root or path.is_relative_to(root)
                            for root in map(Path, ("/proc", "/sys", "/dev")))
                and path.resolve(strict=True) == path and path.is_dir(),
                "file_tool_directory_changed")
        require(directory_identity(path) == expected, "file_tool_directory_changed")
        roots.append(str(path))
    require(len(set(roots)) == len(roots) and value.get("roots") == roots
            and roots == contract["probe_roots"]
            and contract["paths"]["archive_dir"] in roots, "file_tool_scope_changed")
    require(proof["scope_sha256"] == probe_scope(contract, directories, read_bytes),
            "file_tool_scope_changed")
    for name in [*files, *absent]:
        require(isinstance(name, str), "invalid_file_tool_probe_path")
        path = Path(name)
        require(str(path.parent) in roots and path.resolve() == path
                and not path.is_symlink() and path.name.startswith(".coordinator-probe-"),
                "file_tool_probe_path_changed")
    require({str(Path(p).parent) for p in files} == set(roots)
            and {str(Path(p).parent) for p in absent} == set(roots), "file_tool_scope_changed")
    for name, body in files.items():
        require(isinstance(body, str) and len(body) <= 1024
                and read_bytes(name) == body.encode(), "file_tool_probe_changed")
    require(not any(os.path.lexists(p) for p in absent), "file_tool_probe_changed")
    return proof
