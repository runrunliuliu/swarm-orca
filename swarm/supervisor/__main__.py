"""Run from the installed source root: python3 -m supervisor --config FILE COMMAND."""

import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import time

from .config import SafetyError, digest, load, require
from .engine import Engine
from .orca import Orca
from .store import Store, lock, private_directory
from .watchdog import Watchdog, status


def read_json(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def emit(value):
    print(json.dumps(value, ensure_ascii=False, sort_keys=True), flush=True)


def atomic_json(path, value):
    """Owner-private generated artifact; never follows or overwrites arbitrary paths."""
    fd, temporary = tempfile.mkstemp(prefix=".manifest-", suffix=".new", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(value, target, ensure_ascii=False, indent=2)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, path)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", required=True)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("validate").add_argument("--live", action="store_true")
    sub.add_parser("status")
    sub.add_parser("supervise").add_argument("--once", action="store_true")
    sub.add_parser("coordinator-init")
    sub.add_parser("coordinator-step").add_argument("--decisions")
    sub.add_parser("coordinator-checkpoint")
    sub.add_parser("coordinator-inbox")
    for name in ("pause", "resume", "request-round"):
        sub.add_parser(name).add_argument("--reason", required=True)
    sub.add_parser("cost-import").add_argument("--file", required=True)
    sub.add_parser("export")
    return p


def main(argv=None):
    os.umask(0o077)
    args = parser().parse_args(argv)
    live = args.command.startswith("coordinator-") or args.command == "supervise" or getattr(args, "live", False)
    config = load(args.config, live=live)
    if args.command == "validate":
        emit({"valid": True, "live_authorized": live, "config_hash": digest(config)})
        return 0
    store = Store(config["state_dir"])
    try:
        if args.command == "supervise":
            native = Orca(config)
            watchdog = Watchdog(config, store, native, Path(args.config).resolve())
            stopping = False

            def stop(_signal, _frame):
                nonlocal stopping
                stopping = True

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            with lock(store.root, "supervisor.lock"):
                last = None
                while not stopping:
                    outcome = watchdog.locked_tick()
                    if outcome != last:
                        emit({"supervisor": outcome})
                        last = outcome
                    if args.once:
                        break
                    time.sleep(config["limits"]["poll_seconds"])
            return 0
        with lock(store.root, "state.lock"):
            store.enroll(config)
            command, goal = args.command, config["goal_id"]
            if command == "status":
                emit(status(config, store))
            elif command == "pause":
                store.pause("operator:" + args.reason, goal=goal)
                emit({"paused": True, "existing_workers": "not cancelled"})
            elif command == "resume":
                require(not store.pending(goal) and not store.get("service:pause"), "system safety pause cannot be cleared by resume")
                require(str(store.get(goal + ":pause", "")).startswith("operator:"), "only an explicit operator pause can be resumed")
                store.put(goal + ":pause", None)
                store.put(goal + ":operator_request", store.get(goal + ":operator_request", 0) + 1)
                store.put(goal + ":operator_request_reason", args.reason)
                store.event("operator_resumed", goal=goal, reason=args.reason)
                emit({"resumed": True, "budgets_reset": False})
            elif command == "request-round":
                require(not store.pending(goal), "unresolved operation; no new round")
                store.admission(config)
                require(store.get(goal + ":round", {}).get("phase") == "waiting", "Coordinator is not at a waiting checkpoint")
                store.put(goal + ":operator_request", store.get(goal + ":operator_request", 0) + 1)
                store.put(goal + ":operator_request_reason", args.reason)
                store.event("operator_round_requested", goal=goal, reason=args.reason)
                emit({"requested": True, "note": "Supervisor will check identity and reserve budget before waking"})
            elif command == "cost-import":
                data = read_json(args.file)
                for row in data:
                    store.cost(row["key"], row["actual_micro_usd"], row["source"], row.get("details", {}))
                emit(status(config, store))
            elif command == "export":
                # Private whitelist export; caller text still requires human redaction before sharing.
                root = private_directory(config["artifact_dir"])
                target = private_directory(root / goal)
                manifest = {"schema_version": 1, "goal_id": goal, "config_hash": digest(config),
                            "task_contracts": config["tasks"], "acceptance": store.get(goal + ":evidence", {}),
                            "status": status(config, store), "costs": store.charge_rows(goal)}
                atomic_json(target / "manifest.json", manifest)
                emit({"manifest": str(target / "manifest.json"), "public": False})
            else:
                engine = Engine(config, store, Orca(config, coordinator=True))
                if command == "coordinator-init":
                    emit(engine.initialize())
                elif command == "coordinator-step":
                    emit(engine.step(read_json(args.decisions) if args.decisions else None))
                elif command == "coordinator-checkpoint":
                    emit(engine.checkpoint())
                elif command == "coordinator-inbox":
                    run = engine.verify()
                    # Only the Agent explicitly asks to see this untrusted private content.
                    emit({"untrusted_saved_delivery": engine.get("delivery"),
                          "untrusted_human_messages": engine.get("human_messages", {}),
                          "untrusted_native_messages": engine.n.read("orchestration", "check", "--run", run, "--peek"),
                          "untrusted_native_tasks": engine.n.tasks(run)})
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SafetyError as error:
        # Safety errors only contain our fixed text or native error codes, not stderr.
        emit({"ok": False, "error": str(error)})
        sys.exit(78)
    except (KeyError, TypeError, ValueError, OSError, sqlite3.Error):
        emit({"ok": False, "error": "invalid configuration/input or local I/O; inspect private state"})
        sys.exit(78)
