"""TEST ONLY: single-host confirmation/admission prototype, not a runtime service.

Inherited test pipes stand in for an authenticated transport. The harness owns
the fixed lock inode, role allowlist, identity/recovery attestations and faults.
There is deliberately no production entry point or automatic owner takeover.
"""

import os
from pathlib import Path
import stat
import threading

from bootstrap_protocol import Confirmation
import coordinator_io as evidence


def consume_fixture(pipe, root, target, result_pipe):
    """Third process: read-only consumer, separate from producer and authority."""
    def snapshot():
        return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in Path(root).iterdir()}
    before = snapshot()
    try:
        pipe.send(dict(op="query", target=target))
        status = pipe.recv() if pipe.poll(3) else "durability_unverified"
    except (EOFError, OSError):
        status = "durability_unverified"
    result_pipe.send(dict(status=status, unchanged=before == snapshot(), pid=os.getpid()))
    result_pipe.close()
    pipe.close()


class AuthorityFixture:
    def __init__(self, root, control, slots):
        self.root, self.control, self.slots = Path(root), control, slots
        self.serial = threading.Lock()
        self.memory = threading.Lock()
        self.confirmed = set()
        # Phase-2 harness may supply a local identity/authorization snapshot
        # check. It applies to EVERY commit, including the original builder's
        # seam, not merely calls routed through the mechanical driver.
        self.admission_check = lambda: None
        self.armed = False
        self.closed = False
        self.stopped = os.path.lexists(self.root / "STOP.json")
        # Pre-provisioned inode, never remove/recreate on owner crash.
        self.owner = evidence.directory_lock(self.root, "owner", create=False)
        self.check_owner = self.owner.__enter__()

    def close(self):
        with self.serial:
            self.armed, self.closed = False, True
            if self.owner is not None:
                owner, self.owner = self.owner, None
                owner.__exit__(None, None, None)

    def bound(self, control):
        if control != self.control:
            raise ValueError("control_generation_mismatch")
        if self.closed:
            raise ValueError("control_owner_closed")
        self.check_owner()

    def active(self, control):
        self.bound(control)
        if self.stopped or os.path.lexists(self.root / "STOP.json"):
            raise ValueError("stopped")
        if not self.armed:
            raise ValueError("not_armed")

    def arm(self, control, recheck):
        with self.serial:
            self.bound(control)
            self.armed = False
            if self.stopped or os.path.lexists(self.root / "STOP.json"):
                raise ValueError("stopped")
            # Harness supplies an independent recovery/identity check, not a
            # claim inferred from getting the lock or observing no recent output.
            recheck()
            self.armed = True

    def query(self, control, target):
        evidence.validate_ref(target)
        try:
            self.bound(control)
        except (OSError, ValueError):
            return Confirmation(control, target, "durability_unverified")
        if target["path"] not in self.slots:
            return Confirmation(control, target, "durability_unverified")
        try:
            evidence.pinned(target)
        except FileNotFoundError:
            return Confirmation(control, target, "not_committed")
        except (OSError, ValueError):
            return Confirmation(control, target, "durability_unverified")
        with self.memory:
            confirmed = (target["path"], target["sha256"]) in self.confirmed
        return Confirmation(control, target, "confirmed" if confirmed else "durability_unverified")

    def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
        with self.serial:
            self.active(control)
            if self.slots.get(target) != actor:
                raise ValueError("role_or_path_mismatch")
            for ref in prerequisites:
                if self.query(control, ref).status != "confirmed":
                    raise ValueError("prerequisite_unconfirmed")
            self.admission_check()
            recheck()  # deterministic pin/lease/STOP checks; no native/model I/O
            self.active(control)
            ref = {"path": target, "sha256": evidence.digest(raw)}
            try:
                evidence.publish_new(Path(target), raw)
            except BaseException:
                self.armed = False  # ambiguous failures require execute reconciliation
                raise
            with self.memory:
                self.confirmed.add((target, ref["sha256"]))
            return Confirmation(control, ref, "confirmed")

    def stop(self, control):
        with self.serial:
            self.bound(control)
            # STOP linearizes here. Memory closes even when persistence fails.
            self.armed, self.stopped = False, True
            target = self.root / "STOP.json"
            if os.path.lexists(target):
                # Never treat existence as durable STOP acknowledgment.
                raise ValueError("stop_requires_reconciliation")
            evidence.publish_new(target, dict(kind="fixture_stop", generation=control.generation))

    def reconcile(self, control, *, target, recheck):
        with self.serial:
            self.bound(control)
            # Close BEFORE any fallible check; failed execute reconciliation
            # must never leave a previously armed owner open.
            self.armed = False
            if self.stopped or os.path.lexists(self.root / "STOP.json"):
                raise ValueError("stopped")
            if target["path"] not in self.slots:
                raise ValueError("role_or_path_mismatch")
            # Caller must prove original writer drained, pins/authorization/live
            # identities unchanged, and explicit recovery allowed. Does not arm.
            recheck()
            evidence.pinned(target)
            fd = os.open(target["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError("not_regular")
                os.fsync(fd)
            finally:
                os.close(fd)
            evidence.fsync_dir(Path(target["path"]).parent)
            evidence.pinned(target)
            with self.memory:
                self.confirmed.add((target["path"], target["sha256"]))
            return Confirmation(control, target, "confirmed")


def serve_fixture(pipe, root, control, slots, hit, release, fault):
    """Isolated child: commands and query replies travel across a real process boundary."""
    from unittest.mock import patch
    original_sync = evidence.fsync_dir
    original_link = os.link
    fault_used = False

    def sync(directory):
        nonlocal fault_used
        if fault_used or fault == "none":
            return original_sync(directory)
        fault_used = True
        hit.set()  # publish_new already linked the complete file
        if fault == "pause_dir":
            if not release.wait(10):
                raise TimeoutError("fixture_barrier_timeout")
        elif fault == "dir_error":
            raise OSError("fixture_directory_fsync_failure")
        elif fault == "crash_after_fsync":
            original_sync(directory)
            os._exit(71)  # test-owned process only, before confirmation insertion
        return original_sync(directory)

    def link(source, target):
        if fault == "link_error":
            raise OSError("fixture_link_failure")
        return original_link(source, target)

    authority = None
    jobs = {}
    outcomes = {}

    def recheck(valid):
        if not valid:
            raise ValueError("fixture_identity_or_recovery_unverified")

    def perform(name, args):
        try:
            op = args.pop("op")
            request_control = args.pop("control", control)
            if op in {"arm", "commit_new", "reconcile"}:
                valid = args.pop("checks_ok", True)
                args["recheck"] = lambda: recheck(valid)
            result = getattr(authority, op)(request_control, **args)
            outcomes[name] = result.status if isinstance(result, Confirmation) else "ok"
        except Exception as exc:
            outcomes[name] = type(exc).__name__ + ":" + str(exc)

    try:
        authority = AuthorityFixture(root, control, slots)
        pipe.send("owner_ready_closed")
        with patch.object(evidence, "fsync_dir", side_effect=sync), patch.object(os, "link", side_effect=link):
            while True:
                message = pipe.recv()
                op = message.pop("op")
                if op == "shutdown":
                    break
                if op == "start":
                    name = message.pop("name")
                    job = threading.Thread(target=perform, args=(name, message["args"]), daemon=True)
                    jobs[name] = job
                    job.start()
                    pipe.send("started")
                elif op == "join":
                    name = message["name"]
                    jobs[name].join(5)
                    pipe.send(outcomes.get(name, "fixture_job_timeout"))
                elif op == "query":
                    pipe.send(authority.query(message.get("control", control), message["target"]).status)
                else:
                    perform("sync", dict(message, op=op))
                    pipe.send(outcomes["sync"])
    except Exception as exc:
        pipe.send(type(exc).__name__ + ":" + str(exc))
    finally:
        release.set()
        for job in jobs.values():
            job.join(5)
        if authority is not None:
            authority.close()
        pipe.close()
