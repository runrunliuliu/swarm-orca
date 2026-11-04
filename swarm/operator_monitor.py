"""Persistent strict-Run observation and optional same-TUI scheduling.

Reuse the Operator's pinned query adapters and the read-only inventory collector.
No execute/probe, Worker dispatch, Coordinator inbox consumption or shell resume.
"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import signal
import stat
import subprocess
import threading
import uuid

import coordinator_operator as operator
import progress_watch as watch
import startup_cli
from terminal_idle_wait import MIN_RPC_TIMEOUT_SECONDS, decode_idle_wait, idle_wait_target
from operator_sender import preflight as sender_preflight
from coordinator_io import (bound_lock, correction_fence, canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, read_json, replace_json, require, timestamp)


class Config:
    def __init__(self, filename, sha256):
        self.ref = {"path": str(path(filename)), "sha256": sha256}
        self.validate(parse(pinned(self.ref)))
        correction_fence(self.root, self.ref)

    def validate(self, c):
        """Shared by immutable config preparation and execution; no native I/O."""
        self.data = c
        self.startup_contract = None
        keys = {"schema_version", "enabled", "binding",
                "operator_id", "state_root", "watch_file", "artifact_roots", "adapters",
                "poll_seconds", "rpc_timeout_seconds", "idle_seconds", "inbox_limit"}
        require(isinstance(c, dict) and type(c.get("schema_version")) is int
                and c["schema_version"] in (1, 2)
                and set(c) == keys | ({"sender", "continuation"} if c["schema_version"] == 2 else set())
                | (set(c) & {"execution", "startup_lifecycle"})
                and type(c["enabled"]) is bool, "invalid_monitor_config")
        require(("execution" in c) == ("startup_lifecycle" in c), "startup_execution_mode_required")
        if "execution" in c:
            from startup_execution import policy
            policy(c)
            require(c["schema_version"] == 2 and c["continuation"] is not None,
                    "startup_monitor_continuation_required")
        b = c["binding"]
        require(isinstance(b, dict) and set(b) == {"runtime", "run", "workspace", "terminal",
                "incarnation", "generation"} and type(b["generation"]) is int and b["generation"] > 0
                and all(isinstance(b[k], str) and b[k].strip() for k in b if k != "generation"),
                "invalid_monitor_binding")
        # An audit label, not a borrowed native Coordinator/Worker identity.
        require(isinstance(c["operator_id"], str) and c["operator_id"].startswith("operator-monitor:")
                and len(c["operator_id"]) > len("operator-monitor:"), "invalid_monitor_actor")
        for key in ("poll_seconds", "rpc_timeout_seconds", "idle_seconds", "inbox_limit"):
            require(type(c[key]) is int and c[key] > 0, "invalid_monitor_limits")
        require(c["poll_seconds"] <= 60 and c["rpc_timeout_seconds"] <= 60
                and c["inbox_limit"] <= 10000, "invalid_monitor_limits")
        self.root = path(c["state_root"], directory=True)
        require(isinstance(c["artifact_roots"], list), "invalid_artifact_roots")
        self.roots = [path(r, directory=True) for r in c["artifact_roots"]]
        require(all(not self.root.is_relative_to(r) and not r.is_relative_to(self.root)
                    for r in self.roots), "monitor_state_is_not_artifact")
        if c["watch_file"] is not None:
            path(c["watch_file"])
        require(isinstance(c["adapters"], dict), "invalid_monitor_adapters")
        for ref in c["adapters"].values():
            pinned(ref)
        if c["schema_version"] == 2:
            s = c["sender"]
            require(isinstance(s, dict) and set(s) == {"terminal", "incarnation", "workspace"}
                    and all(isinstance(v, str) and v.strip() for v in s.values())
                    and s["terminal"] != b["terminal"], "invalid_monitor_sender")
            if c["continuation"] is not None:
                require(c["rpc_timeout_seconds"] >= MIN_RPC_TIMEOUT_SECONDS,
                        "monitor_tui_wait_timeout_too_short")
                from coordinator_tui_continue import load
                continuation, contract, root = load(c["continuation"])
                require(c.get("execution") == continuation.get("execution")
                        and ("execution" not in continuation or c.get("startup_lifecycle") == continuation.get("startup_lifecycle")),
                        "startup_monitor_mode_changed")
                require(continuation.get("scheduler") == s
                        and b == dict(runtime=contract["runtime"], run=contract["run"]["id"],
                            generation=contract["run"]["generation"], workspace=contract["workspace"]["id"],
                            terminal=contract["coordinator"]["terminal"], incarnation=contract["coordinator"]["incarnation"]),
                        "monitor_continuation_binding_mismatch")
                self.startup_contract = contract
                require(root != self.root and not root.is_relative_to(self.root)
                        and not self.root.is_relative_to(root), "monitor_state_is_not_continuation")

    def revalidate(self):
        Config(self.ref["path"], self.ref["sha256"])


def bind_contract(call, contract):
    return startup_cli.bind(call or native, contract)


def bind_config(call, config):
    return bind_contract(call, config.startup_contract)


def native(args, runtime, timeout=12):
    """Only the monitor's extra verbs; existing inventory queries stay allowlisted."""
    from operator_continuity_route import runtime as transport_runtime
    runtime = transport_runtime(runtime)
    # The foreground monitor owns SIGINT/SIGTERM and drains the current tick.
    # Isolate I/O so a terminal-group signal cannot truncate a query/send receipt.
    if tuple(args[:2]) not in {("orchestration", "send"), ("orchestration", "inbox"),
                              ("orchestration", "request-show"), ("terminal", "show"), ("terminal", "wait")}:
        return watch.query(args, runtime, timeout, start_new_session=True)
    cli = watch.resolve_cli(runtime)
    reply = subprocess.run([cli, *args, "--json"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, start_new_session=True)
    target = idle_wait_target(args)
    if target is not None:
        return decode_idle_wait(reply.stdout, reply.returncode, runtime, target)
    return watch.decode_response(reply.stdout, reply.returncode, runtime)


def invoke(ref, request, *, cwd, timeout):
    """Reuse pinned adapter execution with the monitor's finish-current-tick policy."""
    return operator.invoke(ref, request, cwd=cwd, timeout=timeout, start_new_session=True)


def fence(config, call, *, environment=None):
    call = bind_config(call, config)
    b = config.data["binding"]
    shown = call(["orchestration", "run-show", "--id", b["run"]], b["runtime"])
    run = shown.get("run", {})
    require(shown.get("coordinatorPolicy") == "strict-v1" and not shown.get("strictRetirement")
            and run.get("id") == b["run"] and run.get("coordinator_handle") == b["terminal"]
            and type(run.get("consumer_generation")) is int
            and run["consumer_generation"] == b["generation"], "monitor_coordinator_changed")
    terminal = call(["terminal", "show", "--terminal", b["terminal"]], b["runtime"]).get("terminal", {})
    require(all(terminal.get(k) == b[v] for k, v in
                (("handle", "terminal"), ("incarnationId", "incarnation"), ("worktreeId", "workspace")))
            and terminal.get("connected") is True and terminal.get("orphaned") is False,
            "monitor_coordinator_unverifiable")
    sender_fence(config, call, environment=environment)


def sender_fence(config, call, *, environment=None):
    """A dedicated native Operator shell, never an audit label or borrowed agent."""
    call = bind_config(call, config)
    require(config.data["schema_version"] == 2, "monitor_native_sender_configuration_required")
    s = config.data["sender"]
    environment = os.environ if environment is None else environment
    require(environment.get("ORCA_TERMINAL_HANDLE") == s["terminal"]
            and not any(environment.get(k) for k in ("ORCA_AGENT_SESSION_ID", "ORCA_STRUCTURED_SESSION",
                "ORCA_DISPATCH_ID", "ORCA_TASK_ID")), "monitor_requires_own_operator_terminal")
    t = sender_preflight(s, config.data["binding"]["runtime"], call)
    require(environment.get("ORCA_PANE_KEY") == t["tabId"] + ":" + t["leafId"],
            "monitor_operator_terminal_unverifiable")


def external(config, state, invoke):
    """A mutable watch list grants observation only; never submission authority."""
    c, b = config.data, config.data["binding"]
    manifest = ({"schema_version": 1, "binding": b, "jobs": {}, "artifacts": []}
                if c["watch_file"] is None else read_json(c["watch_file"]))
    require(set(manifest) == {"schema_version", "binding", "jobs", "artifacts"}
            and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1
            and manifest["binding"] == b and isinstance(manifest["jobs"], dict)
            and isinstance(manifest["artifacts"], list), "invalid_monitor_watch_list")
    for key, spec in manifest["jobs"].items():
        require(key not in state["jobs"] or state["jobs"][key] == spec, "monitor_job_changed")
        state["jobs"][key] = spec
    # Validate historical entries too, before invoking any adapter after a restart.
    requests = {}
    for key, spec in state["jobs"].items():
        require(isinstance(spec, dict) and set(spec) == {"adapter", "request"}
                and spec["adapter"] in c["adapters"], "invalid_monitor_job")
        payload = parse(pinned(spec["request"]))
        require(isinstance(payload, dict) and payload.get("method") == "query"
                and payload.get("operation_key") == key
                and len(key) == 64 and all(ch in "0123456789abcdef" for ch in key)
                and isinstance(payload.get("job"), str) and payload["job"]
                and all(payload.get("binding", {}).get(k) == v for k, v in b.items()),
                "monitor_query_binding_mismatch")
        requests[key] = payload
    # Removed entries remain observed. An omission is not a Job cancellation or release.
    artifacts = set(state["artifacts"]) | set(manifest["artifacts"])
    for filename in artifacts:
        target = Path(filename)
        require(target.is_absolute() and target.resolve() == target
                and any(target.is_relative_to(r) for r in config.roots), "monitor_artifact_outside_scope")
    state["artifacts"] = sorted(artifacts)
    replace_json(config.root / "state.json", state)
    jobs = {}
    for key, spec in sorted(state["jobs"].items()):
        payload = requests[key]
        try:
            reply = invoke(c["adapters"][spec["adapter"]], payload, cwd=str(config.root),
                           timeout=c["rpc_timeout_seconds"])
        except subprocess.TimeoutExpired:
            reply = dict(operation_key=key, job=payload["job"], status="unknown",
                         evidence={"reason": "operator_query_timeout"})
        operator.validate_reply(reply, key, payload["job"])
        require(reply["status"] != "not_executed", "monitor_known_job_not_executed")
        jobs[key] = reply
    files = {}
    for filename in state["artifacts"]:
        try:
            info = Path(filename).lstat()
            require(stat.S_ISREG(info.st_mode), "monitor_artifact_not_regular")
            files[filename] = {"exists": True, "size": info.st_size, "mtime_ns": info.st_mtime_ns}
        except FileNotFoundError:
            files[filename] = {"exists": False}
    return {"jobs": jobs, "artifacts": files}


def receipt(config, event, reply):
    message = reply.get("message", {})
    require(reply.get("mutation", {}).get("requestId") == event["request_id"]
            and isinstance(message.get("id"), str) and message["id"]
            and message.get("run_id") == config.data["binding"]["run"]
            and message.get("to_handle") == "run:" + config.data["binding"]["run"]
            and message.get("from_handle") == config.data["sender"]["terminal"], "monitor_send_receipt_mismatch")
    return {"message_id": message["id"], "enqueued_at": now(), "native_read": None,
            "business_processed": "unknown"}


def deliver(config, state, call):
    b, root = config.data["binding"], config.root
    for entry in state["outbox"]:
        if entry["delivery"] is not None:
            continue
        event = parse(pinned(entry["event"]))
        fence(config, call)
        if entry["attempted"]:
            # Never replay a send after uncertainty: even an absent receipt may have been pruned.
            result = call(["orchestration", "request-show", "--request", event["request_id"]], b["runtime"])
            require(result.get("requestId") == event["request_id"]
                    and result.get("state") == "completed" and result.get("method") == "orchestration.send",
                    "monitor_send_requires_reconciliation")
            reply = result.get("receipt", {})
        else:
            from startup_execution import require_send
            require_send(config.data)
            entry["attempted"] = True
            replace_json(root / "state.json", state)
            require_send(config.data)
            reply = call(["orchestration", "send",
                          "--to", "run:" + b["run"], "--run", b["run"], "--type", "status",
                          "--subject", "Operator observation " + event["request_id"],
                          "--body", "Facts only; Coordinator decides next steps. Evidence: " +
                          canonical(entry["event"]).decode(),
                          "--payload", canonical({"operator_event": entry["event"],
                                                   "binding": b}).decode(),
                          "--retry-request", event["request_id"]], b["runtime"])
        entry["delivery"] = receipt(config, event, reply)
        replace_json(root / "state.json", state)


def failure_latch(config):
    recovery = getattr(config, "recovery", None)
    return config.root / ("recovery-stop-" + recovery["permit"]["sha256"] + ".json"
                          if recovery else "monitor-stop.json")


def persistently_stopped(config):
    """Only a committed deployment can recognize one historical STOP as reconciled."""
    if "startup_lifecycle" in config.data:
        lifecycle = parse(pinned(config.data["startup_lifecycle"]))
        if (os.path.lexists(Path(lifecycle["state_root"]) / "STOP") or
                (lifecycle.get("bootstrap_owner") is not None and
                 os.path.lexists(Path(lifecycle["bootstrap_owner"]["path"]).parent / "STOP.json"))):
            return True
    if os.path.lexists(config.root / "STOP") or os.path.lexists(failure_latch(config)):
        return True
    if not getattr(config, "recovery", None):
        return os.path.lexists(config.root / "monitor-stop.json")
    plan = parse(pinned(config.recovery_plan))
    if plan.get("recovery", {}).get("kind") == "monitor-source-only-upgrade":
        from operator_monitor_upgrade import deployment_recovery
    else:
        from operator_monitor_recovery import deployment_recovery
    require(plan["config"] == config.ref and deployment_recovery(plan) == config.recovery,
            "recovery_invalid_deployment")
    continuation = parse(pinned(config.data["continuation"]))
    if any(os.path.lexists(Path(continuation["state_root"]) / name) for name in ("STOP", "monitor-stop.json")):
        return True
    # The old STOP must still exist with exactly the reviewed bytes.
    require(file_ref(config.recovery["stop"]["path"]) == config.recovery["stop"],
            "recovery_stop_changed")
    return False


def tick(config, *, call=native, invoke=invoke):
    """Caller holds the bound lock. One inventory, all watched Jobs, one fact event."""
    from operator_continuity_route import require_monitor
    require_monitor(config)
    config.revalidate()
    call = bind_config(call, config)
    c, root = config.data, config.root
    require(c["enabled"], "monitor_disabled")
    if persistently_stopped(config):
        replace_json(root / "status.json", {"observed_at": now(), "state": "stopped",
                                           "reason": "persistent_stop"})
        return "monitor_stopped"
    call_native = lambda args, runtime: call(args, runtime, c["rpc_timeout_seconds"])
    target = root / "state.json"
    if not os.path.lexists(target):
        publish_new(target, {"config": config.ref, "sequence": 0, "fingerprint": None,
                             "last_progress_at": now(), "idle": False, "jobs": {}, "artifacts": [], "outbox": []})
    state = read_json(target)
    require(state.get("config") == config.ref, "monitor_state_binding_changed")
    fence(config, call_native)
    snapshot = watch.collect(c["binding"], call_native)
    require(snapshot["coordinator_policy"] == "strict-v1"
            and snapshot["run"] == {"id": c["binding"]["run"],
                "consumer_generation": c["binding"]["generation"],
                "coordinator_handle": c["binding"]["terminal"]}, "monitor_coordinator_changed")
    # Other workspace terminals are not progress in this Run.
    snapshot.pop("terminals")
    snapshot.update(external(config, state, invoke))
    fingerprint = digest(canonical(snapshot))
    changed = fingerprint != state["fingerprint"]
    if changed:
        state["last_progress_at"] = now()
    idle = (timestamp(now()) - timestamp(state["last_progress_at"])).total_seconds() >= c["idle_seconds"]
    scheduling = c.get("continuation") is not None
    from startup_execution import can_send, unknown_sends
    sending = can_send(c)
    if not sending:
        continuation = parse(pinned(c["continuation"]))
        require(not unknown_sends(continuation, root), "startup_isolation_send_unknown")
    if (changed or idle != state["idle"]) and not scheduling:
        state["sequence"] += 1
        event = {"schema_version": 1, "binding": c["binding"], "observed_at": now(),
                 "request_id": str(uuid.uuid4()), "sequence": state["sequence"],
                 "idle_timeout": idle, "facts": snapshot, "business_acceptance": "not_evaluated"}
        # Content-addressed files make a crash before state publication harmless.
        event_path = root / ("event-" + digest(canonical(event)) + ".json")
        publish_new(event_path, event)
        state["outbox"].append({"event": file_ref(event_path), "attempted": False, "delivery": None})
        state.update(fingerprint=fingerprint, idle=idle)
        replace_json(target, state)
    if sending:
        deliver(config, state, call_native)
    if scheduling:
        # Scheduler mode has ONE wake producer. Inventory facts remain local; no
        # generic idle/change reminders race the continuation outbox.
        from coordinator_tui_scheduler import schedule
        result = schedule(config, snapshot, call_native)
        state.update(fingerprint=fingerprint, idle=idle)
        replace_json(target, state)
        replace_json(root / "status.json", {"observed_at": now(), "state": "monitoring",
                                           "scheduler": result, "business_processed": "unknown"})
        return "monitoring"
    inbox = call_native(["orchestration", "inbox", "--terminal", "run:" + c["binding"]["run"],
                         "--limit", str(c["inbox_limit"])], c["binding"]["runtime"])
    messages = watch.object_rows(inbox.get("messages"))
    require(inbox.get("count") == len(messages), "monitor_inbox_invalid")
    rows = {m.get("id"): m for m in messages if m.get("run_id") == c["binding"]["run"]
            and m.get("to_handle") == "run:" + c["binding"]["run"]}
    for entry in state["outbox"]:
        delivery = entry["delivery"]
        row = rows.get(delivery["message_id"], {})
        # Read-only history is a delivery observation, never business acceptance.
        if delivery["native_read"] is not True:
            read = row.get("read")
            delivery["native_read"] = bool(read) if type(read) is int and read in (0, 1) else None
    replace_json(target, state)
    replace_json(root / "status.json", {"observed_at": now(), "state": "monitoring", "idle_timeout": idle,
                 "events": state["sequence"], "jobs": len(state["jobs"]),
                 "unconfirmed_reads": sum(e["delivery"]["native_read"] is not True for e in state["outbox"]),
                 "business_processed": "unknown"})
    return "monitoring"


def run(config, *, once=False, observer=None):
    """The single foreground loop; optional local deployment receipts under its lock."""
    from operator_continuity_route import require_monitor
    from bootstrap_identity import IdentityVerificationPending, OperatorInputPending
    require_monitor(config)
    require(config.data["enabled"], "monitor_execution_not_enabled")
    require(config.data["schema_version"] == 2, "monitor_native_sender_configuration_required")
    stopped = threading.Event()
    previous = {s: signal.signal(s, lambda *_: stopped.set()) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        with bound_lock(config.root, config.ref, "monitor"), observation_scope(observer), startup_cli.scope(config.startup_contract):
            started, pending_count = False, 0
            while not stopped.is_set():
                try:
                    if not started:
                        if observer:
                            observer("starting", None)
                        started = True
                    status = tick(config)
                except (IdentityVerificationPending, OperatorInputPending) as exc:
                    # Only typed read-only denials reach here. Never retry an
                    # unknown mutation or erase STOP while revalidating identity.
                    from startup_execution import unknown_sends
                    unknown = (config.data.get("continuation") is not None and
                               unknown_sends(parse(pinned(config.data["continuation"])), config.root))
                    if persistently_stopped(config) or unknown:
                        replace_json(config.root / "status.json", dict(observed_at=now(), state="stopped",
                                     reason="persistent_stop_or_unknown_send_requires_reconciliation"))
                        return 2
                    pending_count += 1
                    replace_json(config.root / "status.json", dict(observed_at=now(), state="revalidation_pending",
                        reason=str(exc), next_owner="operator" if isinstance(exc, OperatorInputPending) else "owner",
                        attempts=pending_count, limit=3, sending_allowed=False))
                    if observer and started:
                        observer("pending", None)
                    # Three existing poll intervals at most, not a runtime TTL.
                    # Exhaustion is a known read-only exit, not a durable STOP.
                    if once or pending_count >= 3:
                        return 3
                    stopped.wait(config.data["poll_seconds"])
                    continue
                except Exception as exc:
                    latch = failure_latch(config)
                    if not os.path.lexists(latch):
                        # Only fixed protocol error codes; never adapter stderr or raw native bodies.
                        code = str(exc)
                        safe = len(code) <= 80 and all(ch in "abcdefghijklmnopqrstuvwxyz_" for ch in code)
                        publish_new(latch, {"at": now(), "reason": code if safe else type(exc).__name__})
                    replace_json(config.root / "status.json", {"observed_at": now(), "state": "stopped",
                                 "reason": "inspect_monitor_stop_and_outbox"})
                    print("monitor_stopped_inspect_private_state", flush=True)
                    if observer:
                        observer("stopped", None)
                    return 2
                pending_count = 0
                if observer:
                    observer("tick", status)
                print(status, flush=True)
                if status == "monitor_stopped":
                    return 2
                if once:
                    return 0
                stopped.wait(config.data["poll_seconds"])
        return 0
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


@contextmanager
def observation_scope(observer):
    try:
        yield
    finally:
        if observer:
            observer("exited", None)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-skill-read", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    config = Config(args.config, args.config_sha256)
    if not args.execute:
        print("monitor_inputs_validated_no_execution")
        return 0
    require(args.confirm_skill_read, "monitor_execution_not_enabled")
    return run(config, once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
