"""Run one reviewed Trae plan; keep bulky JSON off the native identity stream.

Raw stdout/stderr stay in exclusive private files. Only original thread.started
bytes reach the PTY. This does not attest identity or replace the strict observer.
"""

from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from coordinator_input import input_bytes


MAX_IDENTITY = 4096
MAX_FORWARD = 32 * 1024
RAW_USAGE_FIELDS = (
    "input_tokens", "output_tokens", "cached_input_tokens",
    "cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens",
)


def exclusive(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def write_json(stream, data):
    stream.write(json.dumps(data, sort_keys=True).encode() + b"\n")
    stream.flush()
    os.fsync(stream.fileno())


def atomic_status(path, data):
    temporary = path.with_name("." + path.name + ".tmp." + str(os.getpid()))
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        write_json(stream, data)
    os.replace(temporary, path)


class CaptureStatus:
    def __init__(self, *, phase, plan_sha256, stdin_sha256):
        self.data = {
            "schema_version": 1,
            "phase": phase,
            "plan_sha256": plan_sha256,
            "stdin_sha256": stdin_sha256,
            "process_state": "reserved",
            "event_counts": {},
            "thread_ids": [],
            "turn_completed": False,
            "turn_failed": False,
            "stream_errors": [],
            "raw_usage_known_counts": {},
            "business_complete": False,
            "raw_text_included": False,
        }

    def update(self, **kwargs):
        self.data.update(kwargs)

    def event(self, value):
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        if not isinstance(kind, str):
            return
        counts = self.data["event_counts"]
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "thread.started":
            thread_id = value.get("thread_id")
            if isinstance(thread_id, str) and thread_id not in self.data["thread_ids"]:
                self.data["thread_ids"].append(thread_id)
        elif kind == "turn.completed":
            self.data["turn_completed"] = True
        elif kind in {"turn.failed", "error"}:
            self.data["turn_failed"] = True
        elif kind == "token_usage_record":
            usage = value.get("payload", {}).get("usage", {})
            if isinstance(usage, dict):
                totals = self.data["raw_usage_known_counts"]
                for field in RAW_USAGE_FIELDS:
                    amount = usage.get(field)
                    if type(amount) is int:
                        totals[field] = totals.get(field, 0) + amount

    def error(self, reason):
        if reason not in self.data["stream_errors"]:
            self.data["stream_errors"].append(reason)

    def finish(self):
        if self.data["stream_errors"]:
            status = "stream_invalid"
        elif self.data["turn_failed"]:
            status = "turn_failed"
        elif self.data["turn_completed"]:
            status = "turn_completed"
        else:
            status = "process_exited_without_turn_completion"
        self.data["completion_status"] = status
        return self.data


def relay(source, raw, output, status=None, status_path=None):
    """Buffer one record and bound PTY traffic; never reserialize identity events."""
    forwarded = 0
    errors = set()

    def reject(reason):
        if reason not in errors:
            errors.add(reason)
            if status is not None:
                status.error(reason)
                if status_path is not None:
                    atomic_status(status_path, status.data)
            output.write(json.dumps({"type": "operator.stream_error", "reason": reason}).encode() + b"\n")
            output.flush()
    partial = bytearray()
    while chunk := source.read1(65536):
        raw.write(chunk)
        fragments = chunk.split(b"\n")
        for index, fragment in enumerate(fragments):
            complete = index < len(fragments) - 1
            partial.extend(fragment)
            if complete:
                partial.extend(b"\n")
            if not complete:
                continue
            record = bytes(partial)
            partial.clear()
            try:
                event = json.loads(record)
            except (ValueError, UnicodeError):
                reject("invalid_json_record")
                continue
            if status is not None:
                status.event(event)
                if status_path is not None:
                    atomic_status(status_path, status.data)
            if isinstance(event, dict) and event.get("type") == "thread.started":
                if len(record) > MAX_IDENTITY or forwarded + len(record) > MAX_FORWARD:
                    reject("identity_output_limit")
                else:
                    output.write(record)
                    output.flush()
                    forwarded += len(record)
    if partial:
        reject("incomplete_record")
    raw.flush()
    os.fsync(raw.fileno())
    return sorted(errors)


def run(plan_path, output):
    plan_path = Path(plan_path).resolve(strict=True)
    plan_bytes = plan_path.read_bytes()
    plan = json.loads(plan_bytes)
    if plan.get("strict_coordinator") or plan.get("phase") == "strict-bootstrap":
        raise ValueError("strict_requires_native_launch_not_capture")
    if plan.get("adapter") != "trae-exec-stream-v1":
        raise ValueError("only the reviewed Trae exec adapter is supported")
    # Older reviewed plans predate the field, so absence keeps its historical exec meaning.
    if plan.get("launch_transport", "exec") != "exec":
        raise ValueError("only an exec plan may be replayed through the capture adapter")
    stdin = input_bytes(plan)
    plan_sha256 = hashlib.sha256(plan_bytes).hexdigest()
    stdin_sha256 = hashlib.sha256(stdin).hexdigest()
    status_path = plan_path.with_suffix(".status.json")
    status = CaptureStatus(phase=plan["phase"], plan_sha256=plan_sha256,
                           stdin_sha256=stdin_sha256)
    data = {"started_at": datetime.now(timezone.utc).isoformat(),
            "plan_sha256": plan_sha256,
            "stdin_sha256": stdin_sha256,
            "phase": plan["phase"], "resume_session": plan["resume_session"]}
    # Reserve all evidence before spawning. A partial failure is not retry permission.
    with exclusive(plan_path.with_suffix(".process-intent.json")) as intent:
        write_json(intent, data)
    atomic_status(status_path, status.data)
    with exclusive(plan_path.with_suffix(".stdout.jsonl")) as raw, \
            exclusive(plan_path.with_suffix(".stderr.log")) as err, \
            exclusive(plan_path.with_suffix(".process.json")) as receipt, \
            os.fdopen(os.open(plan_path.with_suffix(".stdin.md"),
                      os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), "w+b") as prompt:
        prompt.write(stdin)
        prompt.flush()
        os.fsync(prompt.fileno())
        prompt.seek(0)
        child = subprocess.Popen(plan["argv"], stdin=prompt, stdout=subprocess.PIPE,
                                 stderr=err, cwd=plan["cwd"])
        data["child_pid"] = child.pid
        status.update(process_state="running", child_pid=child.pid,
                      started_at=data["started_at"])
        atomic_status(status_path, status.data)
        try:
            errors = relay(child.stdout, raw, output, status, status_path)
            code = child.wait()
        except BaseException as exc:
            # A capture failure is not a child-exit observation or permission to retry.
            data.update(capture_error=type(exc).__name__, exit_code=None,
                        observed_by="capture-failed-child-exit-unknown")
            write_json(receipt, data)
            status.update(process_state="exit_unknown", capture_error=type(exc).__name__)
            atomic_status(status_path, status.finish())
            raise
        finally:
            child.stdout.close()
        err.flush()
        os.fsync(err.fileno())
        data.update(ended_at=datetime.now(timezone.utc).isoformat(), exit_code=code,
                    stream_errors=errors,
                    observed_by="direct-parent-wait-not-signed-attestation")
        write_json(receipt, data)
        status.update(process_state="exited", ended_at=data["ended_at"], exit_code=code,
                      stream_errors=errors,
                      observed_by="direct-parent-wait-not-signed-attestation")
        atomic_status(status_path, status.finish())
    output.write(json.dumps({"type": "operator.child_exited", **data}).encode() + b"\n")
    output.flush()
    return code if code else (65 if errors else 0)


def status(plan_path, output):
    plan = Path(plan_path).resolve(strict=True)
    status_file = plan.with_suffix(".status.json")
    if status_file.exists():
        output.write(status_file.read_bytes())
        return 0
    output.write(json.dumps({"schema_version": 1, "process_state": "not_started",
                             "business_complete": False,
                             "raw_text_included": False},
                            sort_keys=True).encode() + b"\n")
    return 1


def main(argv=None, output=None):
    argv = sys.argv[1:] if argv is None else argv
    output = sys.stdout.buffer if output is None else output
    if any(arg in {"-h", "--help"} for arg in argv):
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("args", nargs="*")
        output.write(parser.format_help().encode())
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("args", nargs="*")
    args = parser.parse_args(argv)
    if args.args[:1] == ["status"] and len(args.args) == 2:
        return status(args.args[1], output)
    if args.args[:1] == ["run"] and len(args.args) == 2:
        return run(args.args[1], output)
    if len(args.args) == 1:
        return run(args.args[0], output)
    if args.args:
        parser.error("expected PLAN, run PLAN, or status PLAN")
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
