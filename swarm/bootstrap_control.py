"""Attempt-local production confirmation owner and authenticated Unix clients.

No daemon installation, automatic takeover, Agent launch or native mutations.
An owner generation is used once; restart fails closed. Explicit reconciliation
on the SAME living owner only re-fsyncs bytes from its own completed commit call.
"""

from dataclasses import asdict
from contextlib import contextmanager
import os
from pathlib import Path
import secrets
import socket
import threading
import time
import observation_budget as budget
import blocking_io

from bootstrap_admission import control_paths, inspect_chain
from bootstrap_identity import (host_process, peer, unchanged, IdentitySnapshotExpired,
                                IdentityVerificationPending, IDENTITY_REFRESH_MARGIN_SECONDS,
                                BootstrapAdmissionClosed, OperatorInputPending)
from bootstrap_protocol import COMMIT_OPS, COMMIT_STATES, Confirmation, ControlBinding, layout
from bootstrap_transport import Signer, safe_reason, verify
import coordinator_io as io

MAX_MESSAGE = 4 * 1024 * 1024


def stated(exc, state, may_replay=None):
    """Attach the commit outcome class to an exception without rewriting it.

    The message keeps the owner's typed code; the state and may_replay fields
    are what a caller routes on, so it never has to guess from a code alone.
    """
    exc.commit_state = state
    exc.may_replay = (state == "not_admitted") if may_replay is None else may_replay
    return exc


class ReadOnlyPollExpired(TimeoutError):
    """No mutation was admitted in this client polling scope; no health claim."""


def slots_for(binding):
    from bootstrap_actions import ACTIONS, completion_slot
    root = Path(binding["paths"]["request"]).parent
    slots = {p: "operator" for key, p in layout(root).items() if key != "skill_read_evidence"}
    for key in ("caller_receipt", "caller-ready", "final_readiness", "request"):
        slots[binding["paths"][key]] = "coordinator"
    slots.update({p: "coordinator" for p in binding["file_tool_evidence_paths"]})
    for name, target in control_paths(root).items():
        slots[target] = ACTIONS[name].actor if name in ACTIONS else "coordinator"
    for name in ("strict-config-ready.json", "strict-config-review.json"):
        slots[str(root / name)] = "operator"
    for name in ("session-contract.json", "prepared-inputs.json", "start.json", "prepared-commit.json",
                 "publication-intent.json", "operator-gate.json", "gate-ready.json"):
        slots[str(root / "strict-start" / name)] = "operator"
    for name in ("ready.json", "create-intent.json", "create-response.json", "created.json"):
        slots[str(root / "strict-start" / name)] = "coordinator"
    for role, actions in {"operator": ("prepare", "review", "deliver", "publish"),
                          "coordinator": ("config-wait", "create")}.items():
        for action in actions:
            slots[str(root / "control" / ("s5-" + action + ".json"))] = role
    slots[str(root / "control" / "caller-execute.json")] = "coordinator"
    slots[str(root / "control" / "observe-execute.json")] = "operator"
    for name, spec in ACTIONS.items():
        slots[binding["paths"][spec.target]] = spec.actor
        slots[str(root / "control" / (name + ".json"))] = spec.actor
        if spec.mode != "produce":
            slots[completion_slot(root, name)] = spec.actor
    for name in ("spec.json", "activation.json", "lifecycle.json"):
        slots[str(root / "lifecycle" / name)] = "operator"
    return slots


class CommitOwner:
    def __init__(self, control, identity):
        self.control, self.identity = control, identity
        self.b, _, _ = inspect_chain(control)
        self.root = Path(control.attempt_binding["path"]).parent / "control"
        self.slots = slots_for(self.b)
        self.serial = threading.RLock()
        self.armed = False
        self.initializing = True
        self.closed = False
        self.stopped = False
        self.confirmations, self.attempted, self.published = set(), {}, {}
        # The bytes of each recorded-but-unconfirmed attempt, in memory only.
        # `reconcile` may finish such an attempt from these bytes; nothing else
        # ever writes them, so no caller can supply an output.
        self.attempted_raw = {}
        self.process = host_process()
        self.owner = io.directory_lock(self.root, "owner", create=False)
        self.check_inode = self.owner.__enter__()

    def bound(self, control):
        io.require(control == self.control and not self.closed, "bootstrap_owner_or_generation_changed")
        unchanged(self.process)
        self.check_inode()

    def active(self, control):
        self.bound(control)
        io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
        io.require(self.armed, "bootstrap_owner_closed")
        try:
            self.identity.check()
        except (IdentityVerificationPending, BootstrapAdmissionClosed, OperatorInputPending):
            raise
        except BaseException:
            self.invalidate()
            raise

    def invalidate(self):
        # Only the pristine, never-armed generation may report awaiting_arm.
        self.initializing, self.armed = False, False

    def heartbeat(self, control):
        self.bound(control)
        io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
        try:
            self.identity.check()
        except (IdentityVerificationPending, BootstrapAdmissionClosed, OperatorInputPending):
            raise
        except BaseException:
            self.invalidate()
            raise
        io.require(self.armed or self.initializing, "bootstrap_owner_closed")
        return "ready" if self.armed else "awaiting_arm"

    def refresh(self, *, force=False, runtime=False):
        check = self.identity.check_runtime if runtime else self.identity.check
        refresh = self.identity.refresh_runtime if runtime else self.identity.refresh
        try:
            with self.serial:
                self.bound(self.control)
                io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
            if not force and time.monotonic() + IDENTITY_REFRESH_MARGIN_SECONDS < getattr(self.identity, "expires", 0):
                try:
                    check()
                    return
                except IdentitySnapshotExpired:
                    pass  # Slow local checks consumed the lease; reacquire once.
            refresh()
        except (IdentityVerificationPending, BootstrapAdmissionClosed, OperatorInputPending):
            # Keep the prior arm state, but the expired lease blocks admission.
            # Successful refresh never changes arm state or clears STOP.
            raise
        except BaseException:
            with self.serial:
                self.invalidate()
            raise

    def runtime_context(self, lifecycle, continuation, owner_ref, *, review_input=False):
        from startup_runtime import established, owner_queries
        with owner_queries(self, owner_ref):
            plan, config, contract = established(lifecycle, continuation)
        io.require(plan["bootstrap_owner"] == owner_ref, "startup_original_owner_required")
        self.refresh(runtime=True)
        # Native reads can be slow; never hold the serial admission lock here.
        try:
            self.identity.verify_run(contract)
        except IdentityVerificationPending:
            raise
        except BaseException:
            with self.serial:
                self.invalidate()
            raise
        return self.runtime_local(lifecycle, continuation, owner_ref, review_input=review_input)

    def runtime_local(self, lifecycle, continuation, owner_ref, *, review_input=False):
        """Final static/lease fence after native reads, also used at publication."""
        from startup_runtime import established, owner_queries, check_inputs
        with self.serial:
            self.bound(self.control)
            io.require(self.armed and not self.stopped and not os.path.lexists(self.root / "STOP.json"),
                       "bootstrap_owner_closed_or_stopped")
            with owner_queries(self, owner_ref):
                plan, config, contract = established(lifecycle, continuation)
            io.require(plan["bootstrap_owner"] == owner_ref, "startup_original_owner_required")
            try:
                self.identity.check_runtime()
            except IdentityVerificationPending:
                raise
            except BaseException:
                self.invalidate()
                raise
            if not review_input:
                check_inputs(self, plan, config, contract)
            # Mailbox/pin reads may consume the lease or expose a hard identity
            # failure. Pending preserves the arm; hard failures never do.
            try:
                self.identity.check_runtime()
            except IdentityVerificationPending:
                raise
            except BaseException:
                self.invalidate()
                raise
            io.require(self.armed and not self.stopped and not os.path.lexists(self.root / "STOP.json")
                       and not os.path.lexists(Path(plan["state_root"]) / "STOP"), "bootstrap_owner_closed_or_stopped")
            deadline = plan["runtime"]["deadline"]
            io.require(deadline is None or io.timestamp(io.now()) < io.timestamp(deadline),
                       "startup_runtime_deadline_expired")
        return plan, config, contract

    def runtime_publish(self, target, value, recheck):
        """Only called by named Operator operations, never a caller-selected path."""
        with self.serial:
            try:
                io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
            except ValueError as exc:
                stated(exc, "needs_reconcile")
                raise
            try:
                recheck()
            except BaseException as exc:
                stated(exc, "not_admitted")
                raise
            raw = io.canonical(value) + b"\n"
            ref = self.record_attempt(target, raw)
            try:
                io.publish_new(Path(target), raw)
            except BaseException as exc:
                self.invalidate()
                stated(exc, "unknown")
                raise
            self.published[target] = ref
            self.confirmations.add((target, ref["sha256"]))
            return ref

    def arm(self, control):
        # Native reads are explicitly outside serial admission.
        with self.serial:
            self.invalidate()
        self.refresh(force=True)
        with self.serial:
            self.bound(control)
            self.armed = False
            io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
            self.identity.check()
            io.require(all(self.query(control, ref).status == "confirmed"
                           for ref in self.attempted.values()), "bootstrap_unreconciled_commits")
            self.armed = True

    def role_for(self, target):
        if target in self.slots:
            return self.slots[target]
        spec_path = self.root.parent / "lifecycle" / "spec.json"
        if os.path.lexists(spec_path):
            ref = io.file_ref(spec_path)
            if self.query(self.control, ref).status == "confirmed":
                from startup_handoff import slots, refresh_slot
                spec = io.parse(io.pinned(ref))
                role = "operator" if refresh_slot(spec, target) else slots(spec).get(target)
                if role is not None:
                    return role
        # Only the actual admitted request determines snapshot count. No prefix
        # allowlist, caller-chosen roots or arbitrary strict-start file names.
        request = self.b["paths"]["request"]
        if os.path.lexists(request):
            ref = io.file_ref(request)
            if self.query(self.control, ref).status == "confirmed":
                value = io.parse(io.pinned(ref))
                names = {str(Path(value["directory"]) / f"readiness-{i:03d}.snapshot")
                         for i in range(len(value["readiness_evidence"]))}
                if target in names:
                    return "operator"
        return None

    def state_of(self, target):
        """Owner-lifetime outcome class for one exact ref; never a replay grant.

        Only this generation can admit a write, so its serial records are the
        authority. A new generation is never armed onto a predecessor's files,
        and an existing file this owner never wrote is `unknown`, not absent.
        """
        attempt = self.attempted.get(target["path"])
        if attempt is None:
            return "not_admitted" if not os.path.lexists(target["path"]) else "unknown"
        if attempt != target:
            return "unknown"
        if (target["path"], target["sha256"]) in self.confirmations:
            return "committed"
        if self.published.get(target["path"]) == target:
            return "unknown"
        # Attempted, unpublished, and this owner no longer holds the bytes it
        # recorded: no reconcile can complete it, so never report a class that
        # promises one. (Within one owner lifetime every attempt keeps its bytes.)
        return ("needs_reconcile" if self.attempted_raw.get(target["path"]) is not None
                else "unknown")

    def query(self, control, target):
        io.validate_ref(target)
        try:
            self.bound(control)
        except (OSError, ValueError):
            return Confirmation(control, target, "durability_unverified")
        try:
            io.pinned(target)
        except FileNotFoundError:
            status = "not_committed"
        except (OSError, ValueError):
            # The file no longer matches the exact ref, so this owner can no
            # longer claim its own publication either.
            return Confirmation(control, target, "durability_unverified", state="unknown")
        else:
            status = "confirmed" if (target["path"], target["sha256"]) in self.confirmations else "durability_unverified"
        return Confirmation(control, target, status, state=self.state_of(target))

    def record_attempt(self, target, raw):
        """The one place an attempt is recorded: ref for query/state, bytes for reconcile.

        Both halves must be written together. A ref without its bytes is the
        attempt20 shape: the outcome class promises a reconcile that no entry can
        complete (`bootstrap_attempted_output_unavailable`).
        """
        ref = dict(path=target, sha256=io.digest(raw))
        self.attempted[target] = ref
        self.attempted_raw[target] = raw
        return ref

    def commit_batch(self, control, *, actor, entries, prerequisites, recheck):
        """Admit and publish one unit of targets in a single serial section.

        `commit_new` admits one target per call, so a refusal between a submission
        record and its outputs left a durable record with no output and no recovery
        (attempts 19 and 24). Everything here happens under one admission: all
        targets are checked, recorded, written and confirmed before the serial
        section ends, so no other role's poll can split the unit. This is not a
        filesystem transaction: a write that fails midway is still published as an
        unknown outcome.
        """
        with self.serial:
            io.require(isinstance(entries, list) and entries, "bootstrap_rpc_invalid")
            refs = [dict(path=path, sha256=io.digest(raw)) for path, raw in entries]
            io.require(len({ref["path"] for ref in refs}) == len(refs), "bootstrap_rpc_invalid")
            for ref in refs:
                io.require(ref["path"] not in self.attempted, "bootstrap_commit_requires_reconciliation")
            for (path, raw), ref in zip(entries, refs):
                self.admit_target(control, actor, path, raw)
            for ref in prerequisites:
                io.require(self.query(control, ref).status == "confirmed", "bootstrap_prerequisite_unconfirmed")
            recheck()
            # Adapter and identity are re-read once for the whole unit.
            self.active(control)
            for (path, raw), ref in zip(entries, refs):
                self.record_attempt(path, raw)
            # Durability order is the caller's: the unit's bookkeeping record is
            # written last, so a crash can only leave outputs without their record
            # (recoverable by inspection), never a record announcing outputs that do
            # not exist (the attempt19/24 fence).
            for (path, raw), ref in zip(entries, refs):
                try:
                    io.publish_new(Path(path), raw)
                except BaseException as exc:
                    self.invalidate()
                    stated(exc, "unknown")
                    raise
                self.published[path] = ref
                self.confirmations.add((path, ref["sha256"]))
            return [Confirmation(control, ref, "confirmed", state="committed") for ref in refs]

    def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
        for attempt in range(2):
            with self.serial:
                try:
                    # A recorded intent dominates every later rejection, including
                    # this owner's own post-failure disarm: it must never look like
                    # a fresh, retryable non-execution.
                    io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
                except ValueError as exc:
                    stated(exc, "needs_reconcile")
                    raise
                try:
                    self.admit(control, actor=actor, target=target, raw=raw,
                               prerequisites=prerequisites, recheck=recheck)
                except IdentitySnapshotExpired as exc:
                    # Only pre-admission natural expiry reaches here; no native I/O
                    # under serial, and no retry after attempted/publish (even on error).
                    if attempt:
                        stated(exc, "not_admitted")
                        raise
                except BaseException as exc:
                    # Every raise before `attempted[target]` proves no byte of this
                    # intent was written, so the caller may retry in place.
                    stated(exc, "not_admitted")
                    raise
                else:
                    ref = self.record_attempt(target, raw)
                    try:
                        io.publish_new(Path(target), raw)
                    except BaseException as exc:
                        self.invalidate()
                        stated(exc, "unknown")
                        raise
                    self.published[target] = ref
                    self.confirmations.add((target, ref["sha256"]))
                    return Confirmation(control, ref, "confirmed", state="committed")
            self.refresh(force=True)

    def admit_target(self, control, actor, target, raw):
        """Per-target gates every commit path must pass, including a batch.

        Extracted so `commit_new`, `settle` and `commit_batch` cannot drift: the
        lifecycle `spec.json` checks are not a special case a batch may skip.
        """
        self.active(control)
        io.require(self.role_for(target) == actor, "bootstrap_role_or_path_mismatch")
        if target == str(self.root.parent / "lifecycle" / "spec.json"):
            from operator_startup import validate_spec
            spec = validate_spec(io.parse(raw), io.file_ref(self.root.parent / "strict-start" / "start.json"))
            io.require("runtime" in spec, "startup_runtime_policy_required")
            io.require(spec["bootstrap_owner"] == io.file_ref(self.root / "owner.json"),
                       "startup_original_owner_required")

    def admit(self, control, *, actor, target, raw, prerequisites, recheck):
        """Everything that must hold before the owner records an intent."""
        self.admit_target(control, actor, target, raw)
        for ref in prerequisites:
            io.require(self.query(control, ref).status == "confirmed", "bootstrap_prerequisite_unconfirmed")
        recheck()  # Read-only; never repeat publication or a producer.
        self.active(control)

    def stop(self, control):
        with self.serial:
            self.bound(control)
            self.stopped, self.armed = True, False
            self.initializing = False
            io.publish_new(self.root / "STOP.json", dict(kind="strict_bootstrap_stop",
                control=asdict(control), owner=self.process, stopped_at=io.now(), execution_authorized=False))

    def reconcile(self, control, *, target=None, path=None, recheck):
        """Complete or re-barrier ONE commit this owner recorded itself.

        `target` keeps its meaning: the exact ref of bytes already on disk. `path`
        addresses the owner's own recorded attempt instead, which is the only way
        to name it after the caller lost the reply (the recorded ref is in memory
        and its bytes may include a clock reading the caller cannot reproduce).
        When nothing was written yet, the owner publishes the bytes it recorded
        itself; their digest must still be the recorded ref, so this can never
        adopt caller bytes or a second intent.
        """
        with self.serial:
            self.bound(control)
            self.invalidate()
            io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
            self.identity.check()
            io.require(isinstance(path, str) != (target is not None), "bootstrap_rpc_invalid")
            if target is None:
                target = self.attempted.get(path)
                io.require(target is not None, "bootstrap_original_commit_unknown")
            # This serial call proves the owner's original publisher is drained;
            # there is no adoption of arbitrary files or replay of native actions.
            io.require(self.attempted.get(target["path"]) == target, "bootstrap_original_commit_unknown")
            recheck()
            if not os.path.lexists(target["path"]):
                raw = self.attempted_raw.get(target["path"])
                io.require(raw is not None and io.digest(raw) == target["sha256"],
                           "bootstrap_attempted_output_unavailable")
                io.publish_new(Path(target["path"]), raw)
                io.require(io.file_ref(Path(target["path"])) == target, "bootstrap_publish_mismatch")
                self.published[target["path"]] = target
                self.confirmations.add((target["path"], target["sha256"]))
                return Confirmation(control, target, "confirmed")
            io.pinned(target)
            fd = os.open(target["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            io.fsync_dir(Path(target["path"]).parent)
            io.pinned(target)
            self.confirmations.add((target["path"], target["sha256"]))
            return Confirmation(control, target, "confirmed")

    def settle(self, control, *, actor, target, raw):
        """Evidence only for already admitted native actions, even after STOP.

        Never publishes gate-ready/created, opens a new intent, or re-arms. A
        missing owner cannot be replaced to claim this settlement succeeded.
        """
        with self.serial:
            self.bound(control)
            root = self.root.parent / "strict-start"
            required = {str(root / "create-response.json"): ("coordinator", "create-intent.json"),
                        str(root / "operator-gate.json"): ("operator", "publication-intent.json")}
            try:
                io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
            except ValueError as exc:
                stated(exc, "needs_reconcile")
                raise
            try:
                io.require(target in required and required[target][0] == actor, "bootstrap_settlement_path_invalid")
                intent = io.file_ref(root / required[target][1])
                io.require(self.query(control, intent).status == "confirmed", "bootstrap_native_intent_unconfirmed")
            except ValueError as exc:
                stated(exc, "not_admitted")
                raise
            ref = self.record_attempt(target, raw)
            try:
                io.publish_new(Path(target), raw)
            except BaseException as exc:
                self.invalidate()
                stated(exc, "unknown")
                raise
            self.published[target] = ref
            self.confirmations.add((target, ref["sha256"]))
            return Confirmation(control, ref, "confirmed", state="committed")

    def close(self):
        with self.serial:
            self.closed, self.armed = True, False
            self.initializing = False
            if self.owner is not None:
                owner, self.owner = self.owner, None
                owner.__exit__(None, None, None)


def transport_timeout(connection, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("bootstrap_rpc_transport_timeout")
    connection.settimeout(remaining)


def receive(connection, *, deadline=None):
    data = bytearray()
    while len(data) <= MAX_MESSAGE:
        if deadline is not None:
            transport_timeout(connection, deadline)
        part = connection.recv(min(65536, MAX_MESSAGE + 1 - len(data)))
        if not part:
            break
        data.extend(part)
    io.require(len(data) <= MAX_MESSAGE, "bootstrap_message_too_large")
    value = io.parse(bytes(data))
    io.require(isinstance(value, dict), "bootstrap_message_invalid")
    return value


def send(connection, value):
    raw = io.canonical(value)
    io.require(len(raw) <= MAX_MESSAGE, "bootstrap_message_too_large")
    connection.sendall(raw)
    connection.shutdown(socket.SHUT_WR)


class OwnerServer:
    """Bounded ingress, one protocol executor, separate non-authoritative diagnostics.

    A busy executor rejects new protocol requests before execution. It does not
    release owner.lock, cancel the running request, or run reconcile concurrently.
    """

    def __init__(self, owner, endpoint):
        self.owner = owner
        self.ingress = threading.BoundedSemaphore(8)
        self.execution = threading.Lock()
        self.closing = threading.Event()
        self.diagnostic_operation = None
        self.signer = Signer()
        endpoint = Path(endpoint)
        parent = io.path(str(endpoint.parent), directory=True)
        io.require(parent.stat().st_uid == os.getuid() and parent.stat().st_mode & 0o777 == 0o700,
                   "bootstrap_endpoint_private_directory_required")
        io.require(not os.path.lexists(endpoint) and len(os.fsencode(endpoint)) < 104,
                   "bootstrap_endpoint_unavailable")
        self.socket = socket.socket(socket.AF_UNIX)
        try:
            self.socket.bind(str(endpoint))
            os.chmod(endpoint, 0o600)
            self.socket.listen(8)
            self.socket.settimeout(0.25)
            # Never overwrite this registration; owner death cannot silently
            # reuse its generation even if its flock is now available.
            io.publish_new(owner.root / "owner.json", dict(schema_version=2, control=asdict(owner.control),
                process=owner.process, endpoint=str(endpoint), registration=owner.identity.registration,
                public_key=self.signer.public))
            self.owner_ref = io.file_ref(owner.root / "owner.json")
        except BaseException:
            self.socket.close()
            raise

    def dispatch(self, connection, message):
        owner = self.owner
        io.require(set(message) == {"control", "op", "args", "nonce"}
                   and isinstance(message["nonce"], str) and len(message["nonce"]) == 64
                   and all(c in "0123456789abcdef" for c in message["nonce"]), "bootstrap_rpc_invalid")
        control = ControlBinding(**message["control"])
        owner.bound(control)
        op, args = message["op"], message["args"]
        identity = peer(connection)
        if op == "query":
            io.require(set(args) == {"target"}, "bootstrap_rpc_invalid")
            return asdict(owner.query(control, **args))
        if op == "observe":
            # Same-UID read-only observer, like query; it gains no review role,
            # arm/commit/send capability. The signed reply proves current control
            # health, which a historical confirmation alone cannot establish.
            io.require(not args, "bootstrap_rpc_invalid")
            owner.refresh()
            unchanged(identity)
            return {"state": owner.heartbeat(control)}
        if op == "runtime-observe":
            io.require(set(args) == {"lifecycle", "continuation"}, "bootstrap_rpc_invalid")
            owner.runtime_context(**args, owner_ref=self.owner_ref)
            unchanged(identity)
            return {"state": "ready", **args}
        actor = owner.identity.authenticate(identity)
        if op == "stop":
            io.require(not args, "bootstrap_rpc_invalid")
            owner.stop(control)
            return {"stopped": True}
        if op == "commit-batch":
            io.require(set(args) == {"actor", "entries", "prerequisites"}
                       and args["actor"] == actor, "bootstrap_rpc_role_mismatch")
            io.require(isinstance(args["entries"], list)
                       and all(set(item) == {"target", "raw"} for item in args["entries"]),
                       "bootstrap_rpc_invalid")
            entries = [(item["target"], bytes.fromhex(item["raw"])) for item in args["entries"]]
            confirmations = owner.commit_batch(control, actor=actor, entries=entries,
                                               prerequisites=args["prerequisites"],
                                               recheck=lambda: unchanged(identity))
            return {"confirmations": [asdict(item) for item in confirmations]}
        if op == "settle":
            io.require(set(args) == {"target", "raw"}, "bootstrap_rpc_invalid")
            return asdict(owner.settle(control, actor=actor, target=args["target"], raw=bytes.fromhex(args["raw"])))
        if op in {"runtime-review-input", "runtime-attest-trigger"}:
            io.require(actor == "operator" and set(args) == {"lifecycle", "continuation", "candidate"},
                       "bootstrap_runtime_operator_required")
            from startup_runtime import operator_action
            return operator_action(owner, self.owner_ref, op, args, identity)
        try:
            owner.refresh()
            unchanged(identity)
            owner.identity.authenticate(identity)
        except (OSError, ValueError) as exc:
            # Nothing was dispatched for a commit op yet: stopped or stale
            # identity here is provable non-execution, not an unknown outcome.
            if op in COMMIT_OPS:
                stated(exc, "not_admitted")
            raise
        if op == "heartbeat":
            io.require(not args, "bootstrap_rpc_invalid")
        if op == "check":
            io.require(not args, "bootstrap_rpc_invalid")
        if op in {"heartbeat", "check"}:
            for attempt in range(2):
                try:
                    if op == "heartbeat":
                        return {"actor": actor, "state": owner.heartbeat(control)}
                    owner.active(control)
                    return {"actor": actor}
                except IdentitySnapshotExpired:
                    if attempt:
                        raise
                    owner.refresh(force=True)
                    unchanged(identity)
                    owner.identity.authenticate(identity)
        if op in {"arm", "reconcile"}:
            io.require(actor == "operator", "bootstrap_recovery_operator_required")
            if op == "arm":
                io.require(not args, "bootstrap_rpc_invalid")
                owner.arm(control)
                return {"armed": True}
            io.require(set(args) in ({"target"}, {"path"}), "bootstrap_rpc_invalid")
            return asdict(owner.reconcile(control, **args, recheck=lambda: unchanged(identity)))
        io.require(op == "commit" and set(args) == {"actor", "target", "raw", "prerequisites"}
                   and args["actor"] == actor, "bootstrap_rpc_role_mismatch")
        raw = bytes.fromhex(args.pop("raw"))
        return asdict(owner.commit_new(control, raw=raw, **args, recheck=lambda: unchanged(identity)))

    def _connection(self, connection):
        try:
            self._handle(connection)
        finally:
            connection.close()
            self.ingress.release()

    def _handle(self, connection):
        from bootstrap_diagnostics import same_uid
        connection.settimeout(10)
        try:
            message = receive(connection, deadline=time.monotonic() + 10)
            if message == {"op": "diagnose"}:
                same_uid(connection)
                busy = self.execution.locked()
                operation = self.diagnostic_operation if busy else None
                # No NAS, /proc, identity refresh, signing tempfiles or serial lock.
                send(connection, dict(diagnostic_only=True, durable=False, execution_authorized=False,
                    control=asdict(self.owner.control), process=self.owner.process,
                    state="busy" if busy else "idle",
                    operation=operation.snapshot() if operation else None))
                return
            request_hash = io.digest(io.canonical(message))
            acquired = self.execution.acquire(blocking=False)
            try:
                if not acquired:
                    # Nothing was dispatched. For a commit that is provable
                    # non-execution, not an unknown outcome.
                    busy = ValueError("bootstrap_owner_busy_not_executed")
                    if message.get("op") in COMMIT_OPS:
                        stated(busy, "not_admitted")
                    raise busy
                io.require(not self.closing.is_set(), "bootstrap_owner_closed")
                operation = blocking_io.Operation("owner_request", mutation=True)
                self.diagnostic_operation = operation
                with blocking_io.tracking(operation), blocking_io.stage("owner_dispatch"):
                    io.pinned(self.owner_ref)
                    result = self.dispatch(connection, message)
                reply = dict(ok=True, result=result)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                reply = dict(ok=False, error="bootstrap_rpc_rejected:" + safe_reason(exc),
                             error_type=type(exc).__name__)
                state = getattr(exc, "commit_state", None)
                if state is not None:
                    reply["state"] = state
                    reply["may_replay"] = getattr(exc, "may_replay", state == "not_admitted")
            finally:
                if acquired:
                    self.diagnostic_operation = None
                    self.execution.release()
            send(connection, self.signer.sign(dict(request_sha256=request_hash,
                                                  owner=self.owner_ref, reply=reply)))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # Unsigned diagnostics never become identity/durability evidence.
            try:
                send(connection, dict(ok=False, error=safe_reason(exc), error_type=type(exc).__name__))
            except OSError:
                pass

    def serve(self, finished):
        while not finished.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                if self.closing.is_set():
                    return
                raise
            if not self.ingress.acquire(blocking=False):
                connection.close()  # Capacity is not evidence of non-execution at a client.
                continue
            try:
                threading.Thread(target=self._connection, args=(connection,), daemon=True).start()
            except BaseException:
                connection.close()
                self.ingress.release()
                raise

    def close(self):
        # Never release lifetime ownership while work is still outside serial
        # (e.g. an identity refresh); the executor covers the entire request.
        # On rejection retain the endpoint too, so diagnostics and eventual
        # same-owner reconciliation remain possible after the request drains.
        io.require(self.execution.acquire(blocking=False), "bootstrap_owner_busy_requires_reconciliation")
        try:
            self.closing.set()
            self.socket.close()
            self.owner.close()
        finally:
            self.execution.release()
        # Retain endpoint and owner.json as crash/ownership evidence. No unlink.


class AuthorityClient:
    def __init__(self, control, owner_ref):
        self.deadline = None
        self.read_only_poll = False
        self.last_heartbeat = None
        self.control, self.owner_ref = control, owner_ref
        self.owner = io.parse(io.pinned(owner_ref))
        io.require(set(self.owner) == {"schema_version", "control", "process", "endpoint", "registration", "public_key"}
                   and self.owner["schema_version"] == 2 and self.owner["control"] == asdict(control),
                   "bootstrap_owner_registration_mismatch")
        self.public_key = self.owner["public_key"]

    @contextmanager
    def polling(self, deadline):
        prior = self.deadline, self.read_only_poll
        self.deadline = deadline if prior[0] is None else min(deadline, prior[0])
        self.read_only_poll = True
        try:
            yield
        finally:
            self.deadline, self.read_only_poll = prior

    def rpc(self, op, **args):
        if budget.active():
            io.require(op in {"heartbeat", "check", "query", "observe", "runtime-observe"},
                       "observation_budget_mutation_forbidden")
            with budget.stage("owner_rpc"), self.polling(time.monotonic() + budget.timeout(30)):
                return self._bounded_rpc(op, **args)
        return self._bounded_rpc(op, **args)

    def _bounded_rpc(self, op, **args):
        io.require(not self.read_only_poll or op in {"heartbeat", "check", "query", "observe", "runtime-observe"},
                   "bootstrap_poll_mutation_forbidden")
        prior = self.deadline
        # A socket inactivity timeout alone restarts for each receive fragment.
        # Share one transport budget across connect/send/all reply fragments.
        deadline = time.monotonic() + 30
        self.deadline = deadline if prior is None else min(prior, deadline)
        try:
            return self._rpc(op, **args)
        except TimeoutError as exc:
            if self.read_only_poll:
                raise ReadOnlyPollExpired("bootstrap_read_only_poll_expired") from exc
            # The owner may still publish. Never retry a mutation on timeout:
            # a lost reply is an unknown outcome, not a provable non-execution.
            error = ValueError("bootstrap_tool_timeout_requires_reconciliation")
            if op in COMMIT_OPS:
                stated(error, "unknown")
            raise error from exc
        finally:
            self.deadline = prior

    def check_deadline(self):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            if self.read_only_poll:
                raise ReadOnlyPollExpired("bootstrap_read_only_poll_expired")
            raise ValueError("bootstrap_tool_timeout_requires_reconciliation")

    @blocking_io.observed("owner_rpc")
    def _rpc(self, op, **args):
        self.check_deadline()
        io.pinned(self.owner_ref)
        # Never compare a sandbox PID with the host /proc view. Server still
        # checks its own boot/start and authenticates the caller's host peer PID.
        request = dict(control=asdict(self.control), op=op, args=args, nonce=secrets.token_hex(32))
        deadline = self.deadline if self.deadline is not None else time.monotonic() + 30
        with socket.socket(socket.AF_UNIX) as connection:
            self.check_deadline()
            transport_timeout(connection, deadline)
            connection.connect(self.owner["endpoint"])
            self.check_deadline()
            transport_timeout(connection, deadline)
            send(connection, request)
            envelope = receive(connection, deadline=deadline)
        reply = verify(envelope, self.public_key, request, self.owner_ref)
        io.pinned(self.owner_ref)
        # Only exact, authenticated revalidation conditions in a read-only
        # scope are pending. Mutation replies and all other denials stay errors.
        if (self.read_only_poll and reply.get("ok") is False and
                (reply.get("error_type"), reply.get("error")) in {
                    ("IdentityVerificationPending", "bootstrap_rpc_rejected:bootstrap_native_identity_timeout"),
                    ("IdentitySnapshotExpired", "bootstrap_rpc_rejected:bootstrap_identity_snapshot_expired")}):
            raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
        if (op in {"heartbeat", "check", "query", "observe", "runtime-observe"} and reply.get("ok") is False and
                reply.get("error_type") == "ValueError" and
                reply.get("error") == "bootstrap_rpc_rejected:bootstrap_owner_busy_not_executed"):
            raise budget.ObservationBusy()
        if (self.read_only_poll and reply.get("ok") is False and
                reply.get("error_type") == "OperatorInputPending" and
                reply.get("error") == "bootstrap_rpc_rejected:startup_operator_input_review_required"):
            raise OperatorInputPending("startup_operator_input_review_required")
        if reply.get("ok") is not True:
            code, state = reply.get("error", "bootstrap_rpc_unknown"), reply.get("state")
            if op in COMMIT_OPS and state in COMMIT_STATES:
                # The owner's explicit state decides the class. Only a provable
                # non-execution keeps the owner's own code for routing; an
                # unknown outcome must not look like one more retryable busy.
                if state != "not_admitted":
                    code = ("bootstrap_commit_requires_reconciliation" if state == "needs_reconcile"
                            else "bootstrap_commit_unknown_requires_reconciliation")
                error = ValueError(code)
                stated(error, state, reply.get("may_replay"))
                raise error
            raise ValueError(code)
        self.check_deadline()
        return reply["result"]

    def heartbeat(self, control, actor):
        io.require(control == self.control, "bootstrap_control_mismatch")
        start = time.monotonic()
        result = self.rpc("heartbeat")
        io.require(set(result) == {"actor", "state"} and result["actor"] == actor
                   and result["state"] in {"awaiting_arm", "ready"}, "bootstrap_heartbeat_invalid")
        self.last_heartbeat = dict(owner=self.owner_ref, state=result["state"], actor=actor,
            received_at=io.now(), round_trip_seconds=time.monotonic() - start,
            evidence="signed_request_bound_reply", execution_authorized=False)
        return result

    def query(self, control, target):
        io.require(control == self.control, "bootstrap_control_mismatch")
        try:
            result = self.rpc("query", target=target)
            io.require(result["control"] == asdict(control) and result["target"] == target,
                       "bootstrap_confirmation_mismatch")
            state = result.get("state")
            io.require(state is None or state in COMMIT_STATES, "bootstrap_confirmation_mismatch")
            return Confirmation(control, target, result["status"], state=state)
        except (ReadOnlyPollExpired, IdentityVerificationPending, budget.ObservationTimeout, budget.ObservationBusy):
            raise
        except (OSError, ValueError):
            return Confirmation(control, target, "durability_unverified")

    def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
        io.require(control == self.control, "bootstrap_control_mismatch")
        recheck()
        result = self.rpc("commit", actor=actor, target=target, raw=raw.hex(), prerequisites=prerequisites)
        ref = dict(path=target, sha256=io.digest(raw))
        io.require(result == asdict(Confirmation(control, ref, "confirmed", state="committed")),
                   "bootstrap_confirmation_mismatch")
        return Confirmation(control, ref, "confirmed", state="committed")

    def commit_batch(self, control, *, actor, entries, prerequisites, recheck):
        """One owner round trip admits the whole unit; `recheck` runs locally first."""
        io.require(control == self.control, "bootstrap_control_mismatch")
        recheck()
        result = self.rpc("commit-batch", actor=actor, prerequisites=list(prerequisites),
                          entries=[{"target": path, "raw": raw.hex()} for path, raw in entries])
        refs = [dict(path=path, sha256=io.digest(raw)) for path, raw in entries]
        confirmations = result.get("confirmations") if isinstance(result, dict) else None
        io.require(isinstance(confirmations, list) and len(confirmations) == len(refs)
                   and [item.get("target") for item in confirmations] == refs
                   and all(item.get("status") == "confirmed" and item.get("state") == "committed"
                           for item in confirmations),
                   "bootstrap_confirmation_mismatch")
        return refs

    def stop(self, control):
        io.require(control == self.control, "bootstrap_control_mismatch")
        return self.rpc("stop")

    def active(self, control):
        io.require(control == self.control, "bootstrap_control_mismatch")
        return self.rpc("check")

    def observe(self, control):
        io.require(control == self.control, "bootstrap_control_mismatch")
        with self.polling(time.monotonic() + 30):
            result = self.rpc("observe")
        io.require(set(result) == {"state"} and result["state"] in {"ready", "awaiting_arm"},
                   "bootstrap_observation_invalid")
        return result

    def runtime_observe(self, control, lifecycle, continuation):
        io.require(control == self.control, "bootstrap_control_mismatch")
        with self.polling(time.monotonic() + 30):
            result = self.rpc("runtime-observe", lifecycle=lifecycle, continuation=continuation)
        io.require(result == dict(state="ready", lifecycle=lifecycle, continuation=continuation),
                   "bootstrap_runtime_observation_invalid")
        return result
