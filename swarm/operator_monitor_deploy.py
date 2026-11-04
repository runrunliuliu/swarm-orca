"""Prepare, run and verify the existing monitor in its own native Orca shell.

No Agent launch, identity synthesis, background daemon, stop reset or Run change.
Preparation observes the native sender. A shell/PID alone never proves activation.
"""

import argparse
import errno
import fcntl
import os
from pathlib import Path
import shlex
import stat
import sys

import operator_monitor as monitor
from coordinator_io import (canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, read_json, replace_json, require, timestamp)
from coordinator_tui_continue import load
from coordinator_tui_checkpoint import validate_checkpoint


SOURCE_ROOT = Path(__file__).resolve().parent


def sources():
    # Include transitive local Python dependencies, not just the entrypoint.
    return [file_ref(p) for p in sorted(SOURCE_ROOT.glob("*.py"))]


def private_directory(value):
    root = path(value, directory=True)
    info = root.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "private_state_directory_required")
    return root


def prepare(continuation_ref, state_root, output_dir, *, poll_seconds=3,
            verification_mode="native-runtime", call=None, reconcile=False):
    """Derive binding from a reviewed schema2 continuation, never invent receipts."""
    require(verification_mode in ("native-runtime", "host-process"), "invalid_monitor_verification_mode")
    continuation, contract, continuation_root = load(continuation_ref)
    call = monitor.bind_contract(call, contract)
    require(continuation["schema_version"] == 2, "monitor_scheduler_configuration_required")
    private_directory(str(continuation_root))
    validate_checkpoint(read_json(continuation["checkpoint_head"]), continuation, contract)
    root, output = private_directory(state_root), private_directory(output_dir)
    require(root != output, "monitor_prepare_requires_fresh_directories")
    if not reconcile:
        require(not any(root.iterdir()) and not any(output.iterdir()),
                "monitor_prepare_requires_fresh_directories")
    else:
        # Explicit lifecycle reconciliation only: no cleanup, repinning, or start.
        require({p.name for p in output.iterdir()} <= {"monitor.json", "deployment.json"},
                "monitor_prepare_unknown_partial_files")
        require((output / "deployment.json").exists() or not any(root.iterdir()),
                "monitor_prepare_partial_state_requires_review")
    binding = dict(runtime=contract["runtime"], run=contract["run"]["id"],
                   generation=contract["run"]["generation"], workspace=contract["workspace"]["id"],
                   terminal=contract["coordinator"]["terminal"], incarnation=contract["coordinator"]["incarnation"])
    data = dict(schema_version=2, enabled=True, binding=binding,
                sender=continuation["scheduler"], continuation=continuation_ref,
                operator_id="operator-monitor:" + binding["run"], state_root=str(root),
                watch_file=None, artifact_roots=[], adapters={}, poll_seconds=poll_seconds,
                rpc_timeout_seconds=20, idle_seconds=60, inbox_limit=1000)
    if "execution" in continuation:
        data.update(execution=continuation["execution"], startup_lifecycle=continuation["startup_lifecycle"])
    # Reuse the execution validator BEFORE publishing any config.
    monitor.Config.__new__(monitor.Config).validate(data)
    def revalidate():
        monitor.Config.__new__(monitor.Config).validate(data)
        monitor.sender_preflight(data["sender"], binding["runtime"],
                                 lambda args, runtime: (call or monitor.native)(args, runtime, 20))
        load(continuation_ref)
    revalidate()
    if reconcile and os.path.lexists(output / "monitor.json"):
        require(read_json(output / "monitor.json") == data, "monitor_prepare_partial_config_changed")
    else:
        publish_new(output / "monitor.json", data)
    plan = dict(schema_version=1, config=file_ref(output / "monitor.json"), sources=sources(),
                python=str(Path(sys.executable).resolve()), sender=continuation["scheduler"])
    if verification_mode == "native-runtime":
        plan.update(schema_version=2, verification_mode=verification_mode)
    revalidate()
    require(plan["sources"] == sources(), "monitor_deployment_source_changed")
    if reconcile and os.path.lexists(output / "deployment.json"):
        require(read_json(output / "deployment.json") == plan, "monitor_prepare_partial_plan_changed")
    else:
        publish_new(output / "deployment.json", plan)
    return file_ref(output / "deployment.json")


def validate(plan_ref):
    plan = parse(pinned(plan_ref))
    require(isinstance(plan, dict) and type(plan.get("schema_version")) is int
            and plan["schema_version"] in (1, 2, 3)
            and set(plan) == {"schema_version", "config", "sources", "python", "sender"}
                | ({"verification_mode"} if plan["schema_version"] >= 2 else set())
                | ({"recovery"} if plan["schema_version"] == 3 else set())
            and (plan["schema_version"] == 1 or plan["verification_mode"] == "native-runtime"),
            "invalid_monitor_deployment")
    require(plan["sources"] == sources(), "monitor_deployment_source_changed")
    require(plan["python"] == str(Path(sys.executable).resolve()), "monitor_deployment_python_changed")
    config = monitor.Config(plan["config"]["path"], plan["config"]["sha256"])
    require(config.data.get("continuation") is not None and config.data.get("sender") == plan["sender"],
            "monitor_deployment_binding_changed")
    if plan["schema_version"] == 3:
        config.recovery = deployment_recovery(plan)
        config.recovery_plan = plan_ref
    return plan, config


def deployment_recovery(plan):
    """Dispatch schema3 monitor deployments by their explicit recovery kind."""
    recovery = plan.get("recovery", {})
    if recovery.get("kind") == "monitor-source-only-upgrade":
        from operator_monitor_upgrade import deployment_recovery as source_upgrade_recovery
        return source_upgrade_recovery(plan)
    from operator_monitor_recovery import deployment_recovery as continuation_recovery
    return continuation_recovery(plan)


def process_identity(pid):
    """Linux host observation: boot + start ticks prevents trusting a recycled PID."""
    require(type(pid) is int and pid > 0, "invalid_monitor_pid")
    root = Path("/proc") / str(pid)
    fields = (root / "stat").read_text().rsplit(")", 1)[1].split()
    require(fields[0] not in ("Z", "X"), "monitor_process_exited")
    return dict(pid=pid, boot_id=Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                start_ticks=fields[19], executable=str((root / "exe").resolve(strict=True)),
                argv_sha256=digest((root / "cmdline").read_bytes()))


def process_environment(pid):
    # Read only the original process's Orca identity. Never export or print raw env.
    keys = {"ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_AGENT_SESSION_ID",
            "ORCA_STRUCTURED_SESSION", "ORCA_DISPATCH_ID", "ORCA_TASK_ID"}
    return {k.decode(): v.decode() for row in (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
            if b"=" in row for k, v in [row.split(b"=", 1)] if k.decode() in keys}


def own_sender_environment():
    """Only inherited sender binding, never copied from another process/inspector."""
    keys = {"ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_AGENT_SESSION_ID",
            "ORCA_STRUCTURED_SESSION", "ORCA_DISPATCH_ID", "ORCA_TASK_ID"}
    return {key: os.environ[key] for key in keys if key in os.environ}


def locked_monitor(config):
    """Observe the existing lock without creating state or proving process identity."""
    require(read_json(config.root / "monitor-binding.json") == config.ref, "monitor_config_changed")
    # NFS implements flock via byte-range locks: LOCK_EX needs write access.
    # Inspect only the existing inode; never create, truncate or write the lock.
    fd = os.open(config.root / "monitor.lock", os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600, "invalid_lock_file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                raise
        else:
            raise ValueError("monitor_deployment_lock_not_held")
    finally:
        os.close(fd)


def run(plan_ref, *, once=False, observer=None):
    plan, config = validate(plan_ref)
    from operator_continuity_route import require_plan
    require_plan(plan)
    # Preserve the pre-start refusal contract without entering the monitor or
    # creating status/lock files. The locked observer checks again for races.
    require(not monitor.persistently_stopped(config), "monitor_deployment_persistent_stop")
    receipt = None

    def observe(event, status):
        nonlocal receipt
        if event == "exited":
            if receipt is not None:
                receipt.update(phase="exited", observed_at=now())
                replace_json(config.root / "deployment-status.json", receipt)
                if observer:
                    observer(event, receipt)
            return
        if event == "starting":
            # Called only after the original monitor lock has been acquired.
            require(not monitor.persistently_stopped(config),
                    "monitor_deployment_persistent_stop")
            from startup_runtime import acceptance
            accepted = acceptance(config.data, plan_ref)
            initial = dict(schema_version=plan["schema_version"], plan=plan_ref,
                           started_at=now(), first_tick_at=None, phase="starting", status=None)
            if plan["schema_version"] >= 2:
                environment = own_sender_environment()
                monitor.fence(config, lambda args, runtime: monitor.native(
                    args, runtime, config.data["rpc_timeout_seconds"]), environment=environment)
                initial.update(verification_mode="native-runtime", sender_environment=environment)
            else:
                initial["process"] = process_identity(os.getpid())
            if accepted is not None:
                # Sender native I/O can consume the remaining lease/deadline or
                # race STOP. Fence current admission again before acceptance.
                require(acceptance(config.data, plan_ref) == accepted, "monitor_runtime_acceptance_changed")
                initial["acceptance"] = accepted
            config.revalidate()
            require(not monitor.persistently_stopped(config), "monitor_deployment_persistent_stop")
            publish_new(config.root / ("launch-" + digest(canonical(initial)) + ".json"), initial)
            receipt = initial
        else:
            # A rejected/pending pre-start admission has no acceptance receipt.
            # monitor.run still records its status and known exit code.
            if receipt is None:
                return
            receipt["phase"] = ("revalidation_pending" if event == "pending" else
                                "monitoring" if event == "tick" and status == "monitoring" else "stopped")
            if receipt["phase"] == "monitoring":
                receipt["first_tick_at"] = receipt["first_tick_at"] or now()
            receipt["status"] = file_ref(config.root / "status.json")
        receipt["observed_at"] = now()
        replace_json(config.root / "deployment-status.json", receipt)
        if observer:
            observer(event, receipt)

    return monitor.run(config, once=once, observer=observe)


def verify(plan_ref, *, max_age_seconds=120, call=None):
    """Read-only pinned evidence mode; never fall back, start or revive anything."""
    require(type(max_age_seconds) is int and 0 < max_age_seconds <= 300, "invalid_monitor_verification_age")
    plan, config = validate(plan_ref)
    from operator_continuity_route import require_plan
    require_plan(plan)
    require(not monitor.persistently_stopped(config),
            "monitor_deployment_persistent_stop")
    receipt = read_json(config.root / "deployment-status.json")
    from startup_runtime import acceptance
    accepted = acceptance(config.data, plan_ref)
    if accepted is not None:
        require(receipt.get("acceptance") == accepted, "monitor_runtime_acceptance_changed")
        initial = {k: receipt[k] for k in ("schema_version", "plan", "started_at", "acceptance")}
        initial.update({k: receipt[k] for k in (("verification_mode", "sender_environment")
                                              if plan["schema_version"] >= 2 else ("process",))})
        initial.update(first_tick_at=None, phase="starting", status=None)
        require(read_json(config.root / ("launch-" + digest(canonical(initial)) + ".json")) == initial,
                "monitor_runtime_acceptance_unconfirmed")
    require(receipt.get("plan") == plan_ref and receipt.get("phase") == "monitoring"
            and receipt.get("first_tick_at") is not None, "monitor_deployment_not_active")
    require(0 <= (timestamp(now()) - timestamp(receipt["observed_at"])).total_seconds() <= max_age_seconds,
            "monitor_deployment_heartbeat_stale")
    native_mode = plan["schema_version"] >= 2
    if native_mode:
        require(receipt.get("schema_version") == plan["schema_version"] and receipt.get("verification_mode") == "native-runtime"
                and isinstance(receipt.get("sender_environment"), dict), "monitor_deployment_mode_changed")
        locked_monitor(config)
        environment = receipt["sender_environment"]
    else:
        require(process_identity(receipt["process"]["pid"]) == receipt["process"], "monitor_deployment_process_changed")
        environment = process_environment(receipt["process"]["pid"])
    require(receipt["status"] == file_ref(config.root / "status.json"), "monitor_deployment_tick_in_progress")
    status = parse(pinned(receipt["status"]))
    require(status.get("state") == "monitoring", "monitor_deployment_not_active")
    from operator_readiness import scheduler_health
    health = scheduler_health(status.get("scheduler"))
    # The pinned mode selects either a startup self-observation or host observation.
    # Neither exports the binding into the inspector's environment.
    monitor.fence(config, lambda args, runtime: (call or monitor.native)(args, runtime, config.data["rpc_timeout_seconds"]),
                  environment=environment)
    if accepted is not None:
        require(acceptance(config.data, plan_ref) == accepted, "monitor_runtime_acceptance_changed")
    if native_mode:
        config.revalidate()
        require(not monitor.persistently_stopped(config),
                "monitor_deployment_persistent_stop")
        require(read_json(config.root / "deployment-status.json") == receipt
                and receipt["status"] == file_ref(config.root / "status.json"), "monitor_deployment_tick_in_progress")
        locked_monitor(config)
        return dict(state="monitor_runtime_observed", evidence_mode="runtime-state-not-process-attested",
                    process_attested=False, plan=plan_ref, sender=plan["sender"],
                    first_tick_at=receipt["first_tick_at"], observed_at=now(), scheduler=status.get("scheduler"),
                    scheduler_readiness=health,
                    business_acceptance="not_evaluated")
    require(process_identity(receipt["process"]["pid"]) == receipt["process"], "monitor_deployment_process_changed")
    return dict(state="monitor_active", plan=plan_ref, process=receipt["process"],
                first_tick_at=receipt["first_tick_at"], observed_at=now(), scheduler=status.get("scheduler"),
                scheduler_readiness=health,
                business_acceptance="not_evaluated")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--continuation", required=True)
    p.add_argument("--continuation-sha256", required=True)
    p.add_argument("--state-root", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--poll-seconds", type=int, default=3)
    p.add_argument("--verification-mode", choices=("native-runtime", "host-process"), default="native-runtime")
    for name in ("check", "run", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--plan", required=True)
        p.add_argument("--plan-sha256", required=True)
        if name == "run":
            p.add_argument("--execute", action="store_true")
            p.add_argument("--confirm-skill-read", action="store_true")
            p.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "prepare":
        ref = prepare(dict(path=args.continuation, sha256=args.continuation_sha256),
                      args.state_root, args.output_dir, poll_seconds=args.poll_seconds,
                      verification_mode=args.verification_mode)
        command = [str(Path(sys.executable).resolve()), "-B", str(SOURCE_ROOT / "operator_monitor_deploy.py"),
                   "run", "--plan", ref["path"], "--plan-sha256", ref["sha256"], "--execute", "--confirm-skill-read"]
        result = dict(state="prepared_not_started", plan=ref, native_sender_command=shlex.join(command))
    else:
        ref = dict(path=args.plan, sha256=args.plan_sha256)
        validate(ref)
        if args.command == "run":
            require(args.execute and args.confirm_skill_read, "monitor_execution_not_enabled")
            return run(ref, once=args.once)
        result = verify(ref) if args.command == "verify" else dict(state="validated_not_started", plan=ref)
    print(canonical(result).decode(), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
