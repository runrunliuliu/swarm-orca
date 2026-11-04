"""Durable single-writer driver state and its read-only launch projection."""

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import stat

from coordinator_handoff import validate_history, validate_operator
from coordinator_background import validate_jobs
from coordinator_input import input_bytes
from coordinator_io import (canonical, file_ref, fsync_dir, now, parse, path,
                            pinned, read_json, require, write_new)

DRIVER_CONFIG_SCHEMA = 5


class Journal:
    """One location per Run, one writer; no automatic reset or pending replay."""

    def __init__(self, root, pin):
        self.root, self.pin, self.data = root, pin, None

    @contextmanager
    def locked(self):
        if not self.root.exists():
            self.root.mkdir(mode=0o700)
            fsync_dir(self.root.parent)
        path(str(self.root), directory=True)
        info = self.root.stat()
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "private_state_directory_required")
        fd = os.open(self.root / "driver.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600, "invalid_lock_file")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = self.root / "state.json"
            if state.exists():
                self.data = read_json(state)
                require(not os.path.lexists(self.root / "state.next.json"), "unreconciled_state_write")
                self.validate()
            else:
                require(set(p.name for p in self.root.iterdir()) <= {"driver.lock"},
                        "unreconciled_driver_directory")
                self.data = {"schema_version": 3, "config_sha256": self.pin,
                             "attempts": 0, "no_progress_turns": 0, "seen_progress": [],
                             "pending": None, "outcome": None, "current": None,
                             "operator_requests": {}, "background_jobs": {}}
                self.save()
            yield self
        finally:
            os.close(fd)

    def validate(self):
        require(isinstance(self.data, dict), "invalid_driver_state")
        require(self.data.get("config_sha256") == self.pin, "driver_config_changed")
        require(set(self.data) == {"schema_version", "config_sha256", "attempts",
                "no_progress_turns", "seen_progress", "pending", "outcome", "current", "operator_requests",
                "background_jobs"}
                and type(self.data["schema_version"]) is int and self.data["schema_version"] == 3,
                "invalid_driver_state")
        for key in ("attempts", "no_progress_turns"):
            require(type(self.data[key]) is int and self.data[key] >= 0, "invalid_driver_counter")
        require(self.data["no_progress_turns"] <= self.data["attempts"], "invalid_driver_counter")
        require(isinstance(self.data["seen_progress"], list)
                and all(isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v)
                        for v in self.data["seen_progress"]), "invalid_progress_history")
        for key in ("pending", "current"):
            require(self.data[key] is None or isinstance(self.data[key], dict), "invalid_driver_state")
        require(self.data["outcome"] is None or isinstance(self.data["outcome"], str),
                "invalid_driver_state")
        history = self.data["operator_requests"]
        validate_history(history, self.root)
        validate_jobs(self.data["background_jobs"], history)
        operator = (self.data["current"] or {}).get("operator_request")
        require(operator is None or any(e["request"] == operator for e in history.values()),
                "operator_request_binding_mismatch")

    def save(self):
        temporary = self.root / "state.next.json"
        write_new(temporary, self.data)
        os.replace(temporary, self.root / "state.json")
        fsync_dir(self.root)

    def event(self, kind, **fields):
        record = {"at": now(), "event": kind, **fields}
        fd = os.open(self.root / "events.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT
                     | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd, "ab") as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o600, "invalid_event_file")
            stream.write(canonical(record) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())

    def stop(self, reason):
        self.data["outcome"] = reason
        self.save()
        self.event("stopped", reason=reason)
        return reason


def follow_launch(config, previous):
    """Read the pinned driver's exact cursor, never glob for a latest launch.

    No Journal lock/write, checker execution, native query or process launch here.
    The projection is local evidence, not proof of a running loop or later launches.
    """
    ref = config["driver_binding"]
    driver = parse(pinned(ref))
    require(type(driver.get("schema_version")) is int and driver["schema_version"] == DRIVER_CONFIG_SCHEMA,
            "unsupported_driver_schema")
    validate_operator(driver["outer_operator"])
    binding = driver["binding"]
    mapping = {"runtime": "runtime", "run": "run", "generation": "expected_generation",
               "terminal": "terminal", "incarnation": "incarnation", "workspace": "workspace"}
    require(all(binding[k] == config[v] for k, v in mapping.items()), "driver_identity_mismatch")
    base_ref = driver["previous_plan"]
    base = parse(pinned(base_ref))
    root = path(base["artifact_dirs"]["archive"], directory=True) / "coordinator-driver"
    require(root.parent.name == binding["run"] and base["phase"] == "run"
            and isinstance(binding["session"], str) and binding["session"]
            and base["resume_session"] == binding["session"], "driver_launch_binding_mismatch")
    state_ref = file_ref(root / "state.json")
    journal = Journal(root, ref["sha256"])
    journal.data = parse(pinned(state_ref))
    journal.validate()
    state = journal.data
    require(not os.path.lexists(root / "state.next.json"), "unreconciled_state_write")
    count, pending, current = state["attempts"], state["pending"], state["current"]
    require(current is not None, "driver_not_initialized")
    selected = pending if pending is not None else current
    plan_ref = selected["plan"]
    plan = parse(pinned(plan_ref))
    if count == 0:
        require(pending is None and plan_ref == base_ref, "driver_launch_binding_mismatch")
    else:
        expected = root / ("turn-%06d" % count) / "launch-plan.json"
        require(plan_ref["path"] == str(expected), "driver_launch_path_mismatch")
        require(set(plan) == set(base) and all(plan[k] == v for k, v in base.items()
                if k not in {"prompt_file", "input_contract"})
                and plan["prompt_file"] == str(expected.with_name("prompt.md"))
                and plan["command"] is None,
                "driver_launch_policy_changed")
        if pending is not None:
            action = pending["action"]
            require(pending["attempt"] == count, "driver_attempt_mismatch")
        else:
            receipt = parse(pinned(current["action_receipt"]))
            require(receipt["plan"] == plan_ref and receipt["checkpoint"] == current["checkpoint"],
                    "driver_settlement_mismatch")
            action = receipt["action"]
        require(action["binding"] == binding and type(action["attempt"]) is int
                and action["attempt"] == count and action["executor"] == "coordinator",
                "driver_attempt_mismatch")
    input_bytes(plan)
    plan_file = Path(plan_ref["path"])
    intent_file = plan_file.with_suffix(".process-intent.json")
    started = None
    if os.path.lexists(intent_file):
        intent = read_json(intent_file)
        require(intent["plan_sha256"] == plan_ref["sha256"] and intent["phase"] == "run"
                and intent["resume_session"] == binding["session"], "driver_intent_mismatch")
        started = intent["started_at"]
    cursor = {"attempt": count, "plan_sha256": plan_ref["sha256"], "started_at": started}
    old = previous.get("driver_cursor")
    if old is not None:
        require(count >= old["attempt"], "driver_attempt_rollback")
        if count == old["attempt"]:
            require(cursor["plan_sha256"] == old["plan_sha256"] and
                    (old["started_at"] is None or started == old["started_at"]), "driver_cursor_changed")
    require(file_ref(root / "state.json") == state_ref
            and not os.path.lexists(root / "state.next.json"), "driver_state_changed_during_observation")
    phase = "launch_pending" if pending is not None else "between_turns"
    operator = current.get("operator_request")
    if pending is None and operator is not None:
        phase = "operator_handoff"
    if state["outcome"] is not None:
        phase = "stopped"
    observed = {"phase": phase, "cursor": cursor, "no_progress_turns": state["no_progress_turns"],
                "operator_request": operator, "config_sha256": ref["sha256"],
                "background_jobs": state["background_jobs"],
                "loop_liveness": "not_inferred_from_files"}
    resolved = dict(config, plan_sha256=plan_ref["sha256"], launch_started_at=started,
                    resume_session=binding["session"], process_intent=str(intent_file),
                    process_receipt=str(plan_file.with_suffix(".process.json")))
    return resolved, observed
