"""Generate a fixed Coordinator file-tool batch. This Python helper never writes files."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time

from coordinator_launch import BASE, artifact_layout, canonical_directory, read_config
from evidence_policy import age_limit, directory_identity, probe_scope
from native_preflight import (
    PreflightError, _canonical_directory, _default_runner, _evidence_check, _lifecycle_check,
    _path_input, _read_bytes, _require, _runtime_check, _terminal_check,
    _workspace_check, read_json, validate_contract,
)


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def invocation(*, cwd, directories, roots, model_config, runtime_config):
    contract = str(Path(directories["evidence"]) / "native-preflight-contract.json")
    argv = [sys.executable, str(BASE / "coordinator_launch.py"), "prepare-tools",
            "--contract", contract, "--cwd", cwd, "--archive-dir", directories["archive"],
            "--model-config", str(Path(model_config).resolve()),
            "--runtime-config", str(Path(runtime_config).resolve())]
    for root in roots[1:]:
        argv.extend(["--write-dir", root])
    command = shlex.join(argv)
    # Execute only this reviewed local generator's code, never code from native responses.
    script = (
        "const generated = await tools.exec_command(" + compact({
            "cmd": command, "max_output_tokens": 16000, "yield_time_ms": 1000,
        }) + ");\n"
        "let r = generated, output = r.output || '';\n"
        "while (r.session_id) { r = await tools.write_stdin({session_id:r.session_id,"
        "chars:'',yield_time_ms:1000,max_output_tokens:16000}); output += r.output || ''; }\n"
        "if (r.exit_code !== 0) { text({ok:false,decision:'stop',error:output}); }\n"
        "else { const b = JSON.parse(output); "
        "text(await new Function('tools','plan',b.executor)(tools,b.plan)); }"
    )
    return {"schema_version": 1, "contract_path": contract, "command": command,
            "functions_exec": script}


def add_patch(files):
    return "*** Begin Patch\n" + "".join(
        "*** Add File: " + path + "\n" + "".join("+" + line + "\n" for line in body.splitlines())
        for path, body in files.items()) + "*** End Patch"


def directory_snapshot(value, extended=False):
    path, snapshot = _canonical_directory(_path_input(value))
    if extended:
        return path, directory_identity(path)
    # NFS inode IDs can exceed JavaScript's 2**53 exact-integer limit.
    return path, {"path": snapshot["path"], "device": str(snapshot["device"]),
                  "inode": str(snapshot["inode"])}


def verify_files(spec):
    """Read only: check directory identity, no symlinks, exact bytes and absent old names."""
    _require(isinstance(spec, dict) and set(spec) in (
        {"directories", "files", "absent"}, {"directories", "files", "absent", "binding"}),
             "invalid_readback_spec")
    _require(1 <= len(spec["directories"]) <= 37 and len(spec["files"]) <= 40
             and len(spec["absent"]) <= 80, "readback_limit")
    roots = []
    for expected in spec["directories"]:
        path, actual = directory_snapshot(expected["path"], extended="mode" in expected)
        _require(actual == expected, "preparation_directory_changed")
        roots.append(path)
    if "binding" in spec:
        binding = spec["binding"]
        contract = validate_contract(binding["contract"])
        _require(contract["schema_version"] == 2
                 and [str(p) for p in roots] == contract["probe_roots"]
                 and probe_scope(contract, spec["directories"], _read_bytes)
                     == binding["scope_sha256"], "file_tool_scope_changed")
    def target(value):
        path = _path_input(value)
        _require(path.parent in roots and path.resolve() == path and not path.is_symlink(),
                 "preparation_path_changed")
        return path
    hashes = {}
    for value, body in spec["files"].items():
        _require(isinstance(body, str), "invalid_readback_content")
        data = _read_bytes(target(value))
        _require(data == body.encode(), "preparation_readback_mismatch")
        hashes[value] = hashlib.sha256(data).hexdigest()
    for value in spec["absent"]:
        _require(not target(value).exists(), "preparation_output_exists")
    return {"ok": True, "sha256": hashes}


def build_preparation(contract, *, cwd, archive_dir, write_dirs=(),
                      model_config=BASE / "coordinator-model.json",
                      runtime_config=BASE / "coordinator-runtime.json",
                      runner=_default_runner, now=None, reuse_file_tool=None):
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    contract = validate_contract(contract)
    now = now or datetime.now(timezone.utc)
    directories, roots = artifact_layout(archive_dir, write_dirs)
    cwd = str(canonical_directory(cwd))
    _require(contract["paths"] == {"cwd": cwd, "archive_dir": directories["archive"]}
             and str(canonical_directory(contract["workspace"]["path"])) == cwd,
             "preparation_scope_changed")
    selection = read_config(model_config, "selection")
    execution = read_config(runtime_config, "execution")
    expected = contract["session"]
    _require(set(selection) == {"mode", "agent", "model", "effort", "max_mode"}
             and set(execution) == {"sandbox_mode", "approval_policy", "no_daemon"}
             and type(execution["no_daemon"]) is bool
             and execution["sandbox_mode"] in ("danger-full-access", "workspace-write")
             and execution["approval_policy"] in ("never", "on-request")
             and selection.get("mode") == "explicit" and selection.get("agent") == "codex"
             and selection.get("max_mode") is None
             and all(expected[k] == selection.get(k) for k in ("model", "effort"))
             and all(expected[k] == execution.get(k) for k in ("sandbox_mode", "approval_policy")),
             "preparation_settings_changed")
    v2 = contract["schema_version"] == 2
    _require(reuse_file_tool is None or v2, "reuse_requires_v2")
    if v2:
        inputs = {str(Path(p).resolve()) for p in contract["config_files"]}
        _require(all(str(Path(p).resolve()) in inputs for p in (model_config, runtime_config)),
                 "preparation_config_not_bound")
    snapshots = [directory_snapshot(p, extended=v2)[1]
                 for p in dict.fromkeys([*directories.values(), *roots])]
    _require(len(snapshots) <= 37, "preparation_directory_limit")
    paths = {p["path"] for p in snapshots}
    if v2:
        _require(contract["probe_roots"] == [p["path"] for p in snapshots],
                 "preparation_scope_changed")
    identity = {"runtime_id": contract["runtime_id"], "run_id": contract["run_id"],
                "terminal_handle": contract["terminal"]["handle"],
                "incarnation_id": contract["terminal"]["incarnation_id"],
                "session_id": expected["id"]}
    batch = hashlib.sha256(compact(identity).encode()).hexdigest()[:24]
    if v2:
        batch += "-a" + str(contract["preparation"]["attempt"])
    probes = [{"before": str(Path(p["path"]) / (".coordinator-probe-" + batch)),
               "after": str(Path(p["path"]) / (".coordinator-probe-" + batch + ".renamed"))}
              for p in snapshots]
    operations_name = ("coordinator-preparation-" + batch + ".json" if v2
                       else "coordinator-preparation-operations.json")
    outputs = dict(contract["evidence"], operations=str(
        Path(directories["evidence"]) / operations_name))
    _require(len(set(outputs.values())) == 3, "preparation_output_collision")
    for output in outputs.values():
        path = _path_input(output)
        _require(str(path.parent) in paths, "preparation_output_outside_scope")
    absent = [*outputs.values(), *(p[k] for p in probes for k in ("before", "after"))]
    reused = None
    reuse_source_files = {}
    if reuse_file_tool is not None:
        reuse_file_tool = str(_path_input(str(reuse_file_tool)))
        _require(str(Path(reuse_file_tool).parent) in paths,
                 "preparation_reuse_outside_scope")
        checked = _evidence_check("file_tool", reuse_file_tool, contract, now)
        prior_bytes = _read_bytes(reuse_file_tool)
        _require(hashlib.sha256(prior_bytes).hexdigest() == checked["sha256"],
                 "preparation_reuse_changed")
        reused = json.loads(prior_bytes)
        reuse_source_files[reuse_file_tool] = prior_bytes.decode()
        prior = reused.get("preparation", {})
        _require(isinstance(prior, dict)
                 and type(prior.get("attempt")) is int
                 and prior.get("max_attempts") == contract["preparation"]["max_attempts"]
                 and prior["attempt"] + 1 == contract["preparation"]["attempt"],
                 "preparation_reuse_attempt_changed")
        _require("session_evidence_sha256" not in reused, "unsupported_reuse_receipt")
        reused = dict(reused, reuse_source={"path": reuse_file_tool, "sha256": checked["sha256"]})
        absent = list(outputs.values())
    verify_files({"directories": snapshots, "files": {}, "absent": absent})

    # Current session evidence, not a requested-value receipt or cached observation.
    timeout = contract["limits"]["per_check_timeout_ms"] / 1000
    _runtime_check(contract, timeout, runner)
    _workspace_check(contract, timeout, runner)
    _lifecycle_check(contract, timeout, runner)  # Native caller fencing before any writes.
    deadline = time.monotonic() + timeout
    def checkpoint():
        _require(time.monotonic() < deadline, "preparation_session_timeout")
    current_session = _terminal_check(contract, timeout, runner, now, checkpoint)
    if reused is not None:
        _require(reused["session_context_sha256"] == current_session["session_context_sha256"],
                 "file_tool_session_context_changed")
    checkpoint()
    # Recheck collisions after native queries; single writer still required.
    verify_files({"directories": snapshots, "files": {}, "absent": absent})
    session = dict(identity, observed_at=now.isoformat(),
                   trust="runtime-state-not-process-attested", effective={
                       k: expected[k] for k in ("provider", "model", "effort",
                                                "sandbox_mode", "approval_policy")})
    before = "coordinator-probe:" + batch + ":created\n"
    after = "coordinator-probe:" + batch + ":renamed\n"
    files = {p["before"]: before for p in probes}
    renamed = {p["after"]: after for p in probes}
    move_patch = "*** Begin Patch\n" + "".join(
        "*** Update File: " + p["before"] + "\n*** Move to: " + p["after"]
        + "\n@@\n-" + before + "+" + after for p in probes) + "*** End Patch"
    extra = {}
    if v2:
        scope = probe_scope(contract, snapshots, _read_bytes)
        extra = {"binding": {"contract": contract, "scope_sha256": scope},
                 "session_context_sha256": current_session["session_context_sha256"],
                 "preparation": contract["preparation"], "reused_file_tool": reused,
                 "reuse_source_files": reuse_source_files,
                 "probe": {"directories": snapshots, "files": renamed,
                           "absent": list(files), "scope_sha256": scope}}
        if reused is not None:
            extra["probe"] = reused["probe"]
    bundle = {"schema_version": 1, "executor": (BASE / "coordinator_prepare.js").read_text(),
            "plan": {"identity": identity, "directories": snapshots, "outputs": outputs,
                     "session": session, "create_patch": add_patch(files), "move_patch": move_patch,
                     "created_files": files, "renamed_files": renamed, "absent": absent,
                     "verify_argv": [sys.executable, str(Path(__file__).resolve()), "verify-files"],
                     "started_at": started_at, "generation_ms": round((time.monotonic() - started) * 1000, 3),
                     "evidence_max_age_seconds": age_limit(contract, "session"), **extra}}
    return bundle


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--archive-dir", required=True)
    parser.add_argument("--write-dir", action="append", default=[], dest="write_dirs")
    parser.add_argument("--model-config", type=Path, default=BASE / "coordinator-model.json")
    parser.add_argument("--runtime-config", type=Path, default=BASE / "coordinator-runtime.json")
    parser.add_argument("--reuse-file-tool", type=Path,
                        help="Explicit v2 refresh from an exact successful prior file-tool receipt")
    args = vars(parser.parse_args(argv))
    try:
        bundle = build_preparation(read_json(args.pop("contract")), **args)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(compact({"ok": False, "decision": "stop", "code":
                       error.code if isinstance(error, PreflightError) else "preparation_invalid"}))
        return 2
    print(compact(bundle))
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["verify-files"]:
        try:
            _require(len(sys.argv) == 3 and len(sys.argv[2]) <= 512_000, "readback_limit")
            print(compact(verify_files(json.loads(sys.argv[2]))))
        except (OSError, ValueError, TypeError, KeyError) as error:
            print(compact({"ok": False, "code": str(error)}))
            raise SystemExit(2)
    else:
        raise SystemExit(cli_main())
