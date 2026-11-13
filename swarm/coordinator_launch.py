"""Plan Coordinator launches; goal-loop --execute explicitly enters the existing driver."""

import argparse
import json
from pathlib import Path
import shlex
import sys

from coordinator_loop import phase_contract

BASE = Path(__file__).resolve().parent


def build_loop_plan(config_file, config_sha256):
    """Review the existing driver's entry, not another single-turn launch command.

    The seed must come from the real Coordinator's completed handoff turn. Never
    infer it from a report, manufacture authority pins or launch a second owner.
    """
    from coordinator_driver import Config, check_checkpoint, effective, finished
    config = Config(config_file, config_sha256)
    _, receipt, _ = finished(config.data["previous_plan"], config.data["binding"]["session"])
    effective(config, receipt)
    record, _ = check_checkpoint(config, config.data["initial_checkpoint"], receipt)
    argv = [sys.executable, "-B", str(BASE / "coordinator_driver.py"),
            "--config", config.filename, "--config-sha256", config.sha256, "--execute"]
    return {"scope": "swarm_coordinator_only", "mode": "goal_loop",
            "enabled": config.data["enabled"], "binding": config.data["binding"],
            "initial_decision": record["decision"], "cwd": str(config.cwd),
            "argv": argv, "command": shlex.join(argv),
            "business_accepted": False,
            "execution_requirement": "verified original native PTY; driver rechecks live fences"}


def loop_main(argv):
    parser = argparse.ArgumentParser(description="Validate/enter the existing same-session goal loop")
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    if args.execute:
        # One supported executor, including its lock, authority, lifecycle and STOP gates.
        from coordinator_driver import main as driver_main
        return driver_main(["--config", args.config, "--config-sha256", args.config_sha256, "--execute"])
    try:
        plan = build_loop_plan(args.config, args.config_sha256)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"Coordinator loop entry rejected: {error}\n")
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 0


def canonical_directory(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"directory must be absolute: {value}")
    path = path.resolve(strict=True)
    if not path.is_dir() or path == Path(path.anchor):
        raise ValueError(f"expected an existing task directory, not a filesystem root: {value}")
    return path


def read_config(path, section):
    config = json.loads(Path(path).read_text())
    if (not isinstance(config, dict) or type(config.get("schema_version")) is not int
            or config["schema_version"] != 1
            or config.get("scope") != "swarm_coordinator_only"
            or not isinstance(config.get(section), dict)):
        raise ValueError(f"invalid Coordinator {section} config: {path}")
    return config[section]


def artifact_layout(archive_dir, write_dirs=()):
    """One canonical layout for launch arguments and the real file-tool batch."""
    archive = canonical_directory(archive_dir)
    roots = list(dict.fromkeys([archive, *(canonical_directory(p) for p in write_dirs)]))
    directories = {"archive": str(archive)}
    for name in ("evidence", "receipts", "workers", "ledger"):
        target = (archive / name).resolve()
        if not target.is_relative_to(archive):
            raise ValueError(f"archive subdirectory escapes archive root: {name}")
        if target.exists() and not target.is_dir():
            raise ValueError(f"archive subdirectory is not a directory: {name}")
        directories[name] = str(target)
    return directories, [str(p) for p in roots]


def build_plan(*, codex=None, trae=None, pi=None, cwd, archive_dir=None, write_dirs=(),
               model_config=BASE / "coordinator-model.json",
               runtime_config=BASE / "coordinator-runtime.json",
               trae_runtime_config=None, pi_policy=None, prompt_file=None, bootstrap_dir=None,
               resume_session=None, replacement_run=None, strict_coordinator=False,
               registered_bootstrap=False, reviewed_inputs=None, helper_root=None):
    if pi is not None:
        # Pi pins its own reviewed policy (provider, model selector, thinking level); it has
        # no effort/Max surface and no exec shape, so selection is derived from the policy
        # instead of a Trae-shaped model_config, and nothing is mapped across providers.
        from pi_coordinator import build_pi_plan, observed_version, read_pi_runtime, selection_for
        if codex is not None or trae is not None or trae_runtime_config is not None:
            raise ValueError("Pi selection requires --pi only; no Codex or Trae fallback")
        if archive_dir is not None or resume_session is not None or replacement_run is not None:
            raise ValueError("Pi Coordinator requires a fresh bootstrap directory; no Run resume")
        policy, _ = read_pi_runtime(pi_policy)
        plan = build_pi_plan(pi=pi, cwd=cwd, bootstrap_dir=bootstrap_dir,
                             write_dirs=list(write_dirs), selection=selection_for(policy),
                             runtime_config=pi_policy, prompt_file=prompt_file,
                             cli_version=observed_version(pi))
        if not strict_coordinator:
            raise ValueError("Pi Coordinator requires --strict-coordinator; there is no exec shape")
        from coordinator_strict import strict_plan
        return strict_plan(plan, registered_bootstrap=registered_bootstrap,
                           reviewed_inputs=reviewed_inputs, helper_root=helper_root)
    selection = read_config(model_config, "selection")
    if set(selection) != {"mode", "agent", "model", "effort", "max_mode"}:
        raise ValueError("invalid Coordinator selection fields")
    if selection.get("mode") == "explicit" and selection.get("agent") == "trae":
        from trae_coordinator import build_trae_plan
        if codex is not None:
            raise ValueError("Trae selection requires --trae; no Codex fallback")
        plan = build_trae_plan(
            trae=trae, cwd=cwd, archive_dir=archive_dir, write_dirs=write_dirs,
            selection=selection, runtime_config=trae_runtime_config,
            prompt_file=prompt_file, bootstrap_dir=bootstrap_dir, resume_session=resume_session,
            replacement_run=replacement_run)
        if strict_coordinator:
            from coordinator_strict import strict_plan
            return strict_plan(plan, registered_bootstrap=registered_bootstrap,
                               reviewed_inputs=reviewed_inputs, helper_root=helper_root)
        if plan["execution"]["launch_mode"] == "tui":
            raise ValueError("TUI requires --strict-coordinator native launch")
        return plan
    if strict_coordinator:
        raise ValueError("strict native planning currently requires Trae")
    if any(v is not None for v in (trae, trae_runtime_config, prompt_file,
                                   bootstrap_dir, resume_session, replacement_run)):
        raise ValueError("Trae-only options cannot be used for Codex")
    if archive_dir is None:
        raise ValueError("Codex requires an explicit archive directory")
    execution = read_config(runtime_config, "execution")
    if selection.get("mode") != "explicit" or selection.get("agent") != "codex":
        raise ValueError("this helper requires explicit Codex Coordinator selection")
    if selection.get("max_mode") is not None:
        raise ValueError("independent Max override is not supported by this helper")
    model, effort = selection.get("model"), selection.get("effort")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("explicit Coordinator model is required")
    if effort is not None and (not isinstance(effort, str) or not effort.strip()):
        raise ValueError("effort must be null or a non-empty string")
    sandbox = execution.get("sandbox_mode")
    approval = execution.get("approval_policy")
    if (set(execution) != {"sandbox_mode", "approval_policy", "no_daemon"}
            or sandbox not in ("danger-full-access", "workspace-write")
            or approval not in ("never", "on-request")
            or type(execution.get("no_daemon")) is not bool):
        raise ValueError("unsupported Coordinator execution config; no automatic fallback")
    # Keep the chosen executable path: resolving a launcher symlink can change its behavior.
    if codex is None or not Path(codex).is_absolute() or not Path(codex).is_file():
        raise ValueError("codex must name the verified executable by absolute path")

    worktree = canonical_directory(cwd)
    directories, roots = artifact_layout(archive_dir, write_dirs)

    argv = [str(codex), "--cd", str(worktree), "--model", model]
    if effort is not None:
        argv += ["-c", "model_reasoning_effort=" + json.dumps(effort)]
    argv += ["--sandbox", sandbox, "--ask-for-approval", approval]
    if execution["no_daemon"]:
        argv += ["--no-daemon"]
    if sandbox == "workspace-write":
        for root in roots:
            argv += ["--add-dir", str(root)]

    from coordinator_prepare import invocation
    preparation = invocation(cwd=str(worktree), directories=directories, roots=roots,
                             model_config=model_config, runtime_config=runtime_config)
    return {
        "scope": "swarm_coordinator_only",
        "phase": "run",
        "selection": selection,
        "execution": execution,
        "requested_paths": {"cwd": str(cwd), "archive_dir": str(archive_dir)},
        "cwd": str(worktree),
        "artifact_dirs": directories,
        "task_write_roots": [str(p) for p in roots],
        "argv": argv,
        "command": "exec " + shlex.join(argv),
        "preparation": preparation,
        "prompt_fragment": (
            "Coordinator session only; do not change Worker/global permissions.\n"
            "Use these canonical paths in all file tools, including apply_patch and exec_command. "
            "Aliases in requested_paths are lookup metadata, not tool targets.\n"
            "Artifact directories: " + json.dumps(directories, ensure_ascii=False) + "\n"
            "Task write roots: " + json.dumps([str(p) for p in roots], ensure_ascii=False) + "\n"
            "The cwd is not additional task write authorization. Full Access removes the "
            "Codex filesystem sandbox, not task scope, OS permissions or platform policy.\n"
            "Before dispatch, verify effective session settings and a scoped write/read/rename "
            "probe using the file tools needed by this task. On permission denial, preserve "
            "the original error and stop; do not retry through another path or tool.\n"
            "After required rules are read and the approved native-preflight contract is bound "
            "to this actual session, use preparation.functions_exec for the fixed real-tool "
            "batch; do not regenerate probe code or paste its expanded payload into context. "
            "All listed directories must already exist. A prepared receipt is not preflight "
            "success: run fresh native-preflight before any authorized dispatch.\n"
            "Fixed preparation invocation (functions.exec, trusted local template only):\n"
            "```javascript\n" + preparation["functions_exec"] + "\n```\n"
            "This fragment is not a task or launch authorization; the approved objective, "
            "baseline, max_workers, budget, deadline and lifecycle rules are still required.\n"
            + phase_contract("run")
        ),
    }


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] in (["start-grant-mint"], ["start-grant-hand"], ["start-grant-state"]):
        # Three sibling verbs, not one `start-grant <action>`: each has its own argument set and its
        # own answer, and `state` is read-only while the other two write.
        from start_grant import cli_main as start_grant_main
        return start_grant_main([argv[0].removeprefix("start-grant-"), *argv[1:]])
    if argv[:1] == ["worker-plan"]:
        from coordinator_worker_plan import cli_main
        return cli_main(argv[1:])
    if argv[:1] == ["first-dispatch-prepare"]:
        from coordinator_first_dispatch import prepare_main
        return prepare_main(argv[1:])
    if argv[:1] == ["first-dispatch"]:
        from coordinator_first_dispatch import cli_main
        return cli_main(argv[1:])
    if argv[:1] == ["goal-loop"]:
        return loop_main(argv[1:])
    if argv[:1] == ["startup-gate"]:
        from coordinator_startup import cli_main
        return cli_main(argv[1:])
    if argv[:1] == ["startup-contract"]:
        from coordinator_startup import contract_main
        return contract_main(argv[1:])
    if argv[:1] in (["strict-native-plan"], ["strict-session-check"]):
        from coordinator_strict import cli_main
        return cli_main(argv)
    if argv[:1] == ["native-preflight"]:
        from native_preflight import cli_main
        return cli_main(argv[1:])
    if argv[:1] == ["prepare-tools"]:
        from coordinator_prepare import cli_main
        return cli_main(argv[1:])
    parser = argparse.ArgumentParser(description=__doc__)
    binaries = parser.add_mutually_exclusive_group(required=True)
    binaries.add_argument("--codex")
    binaries.add_argument("--trae")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--archive-dir")
    parser.add_argument("--bootstrap-dir")
    parser.add_argument("--trae-runtime-config", type=Path)
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--resume-session")
    parser.add_argument("--replacement-run")
    parser.add_argument("--strict-coordinator", action="store_true",
                        help="native continuous Trae process; no capture or shell resume")
    parser.add_argument("--registered-bootstrap", action="store_true",
                        help="this attempt has (or will have) attempt-binding/control owner "
                             "slots; forbids the historical direct caller write")
    parser.add_argument("--reviewed-inputs",
                        help="Operator `prepare` manifest (prepared.json) pinned as {path} + --reviewed-inputs-sha256")
    parser.add_argument("--reviewed-inputs-sha256")
    parser.add_argument("--single-turn", action="store_true",
                        help="explicit Trae run-phase handoff/one-shot turn, NOT cross-turn goal execution")
    parser.add_argument("--write-dir", action="append", default=[], dest="write_dirs")
    parser.add_argument("--model-config", type=Path, default=BASE / "coordinator-model.json")
    parser.add_argument("--runtime-config", type=Path, default=BASE / "coordinator-runtime.json")
    parser.epilog = (
        "Run `coordinator_launch.py native-preflight --contract CONTRACT` for the "
        "read-only native-adaptive pre-dispatch check. "
        "For a new supervised Trae Run, use `coordinator_launch.py startup-contract --help` "
        "to build the fixed v2 contract, then `coordinator_launch.py startup-gate --help` "
        "for the Operator's independent-session and first-dispatch identity gates."
    )
    args = parser.parse_args(argv)
    if args.resume_session and not args.single_turn:
        parser.error("run-phase goal execution uses goal-loop --config/--config-sha256; "
                     "use --single-turn only for an explicit handoff or one-shot turn")
    if args.single_turn and not args.trae:
        parser.error("--single-turn is for the Trae exec adapter only")
    if args.single_turn and args.strict_coordinator:
        parser.error("--single-turn conflicts with the continuous strict Coordinator process")
    del args.single_turn
    if args.reviewed_inputs_sha256 and not args.reviewed_inputs:
        parser.error("--reviewed-inputs-sha256 requires --reviewed-inputs")
    if args.reviewed_inputs and not args.reviewed_inputs_sha256:
        parser.error("--reviewed-inputs requires --reviewed-inputs-sha256")
    prepare_input = (dict(path=args.reviewed_inputs, sha256=args.reviewed_inputs_sha256)
                     if args.reviewed_inputs else None)
    del args.reviewed_inputs, args.reviewed_inputs_sha256
    args.reviewed_inputs = prepare_input
    try:
        plan = build_plan(**vars(args))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(2, f"coordinator launch plan rejected: {error}\n")
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
