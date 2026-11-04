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

from bootstrap_admission import control_paths, inspect_chain
from bootstrap_identity import (host_process, peer, unchanged, IdentitySnapshotExpired,
                                IdentityVerificationPending, IDENTITY_REFRESH_MARGIN_SECONDS,
                                BootstrapAdmissionClosed, OperatorInputPending)
from bootstrap_protocol import Confirmation, ControlBinding, layout
from bootstrap_transport import Signer, safe_reason, verify
import coordinator_io as io

MAX_MESSAGE = 4 * 1024 * 1024


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
        self.confirmations, self.attempted = set(), {}
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
            recheck()
            io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
            raw = io.canonical(value) + b"\n"
            ref = dict(path=target, sha256=io.digest(raw))
            self.attempted[target] = ref
            try:
                io.publish_new(Path(target), raw)
            except BaseException:
                self.invalidate()
                raise
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
            status = "durability_unverified"
        else:
            status = "confirmed" if (target["path"], target["sha256"]) in self.confirmations else "durability_unverified"
        return Confirmation(control, target, status)

    def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
        for attempt in range(2):
            with self.serial:
                try:
                    self.active(control)
                    io.require(self.role_for(target) == actor, "bootstrap_role_or_path_mismatch")
                    if target == str(self.root.parent / "lifecycle" / "spec.json"):
                        from operator_startup import validate_spec
                        spec = validate_spec(io.parse(raw), io.file_ref(self.root.parent / "strict-start" / "start.json"))
                        io.require("runtime" in spec, "startup_runtime_policy_required")
                        io.require(spec["bootstrap_owner"] == io.file_ref(self.root / "owner.json"),
                                   "startup_original_owner_required")
                    for ref in prerequisites:
                        io.require(self.query(control, ref).status == "confirmed", "bootstrap_prerequisite_unconfirmed")
                    recheck()  # Read-only; never repeat publication or a producer.
                    self.active(control)
                except IdentitySnapshotExpired:
                    if attempt:
                        raise
                else:
                    ref = dict(path=target, sha256=io.digest(raw))
                    io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
                    self.attempted[target] = ref
                    try:
                        io.publish_new(Path(target), raw)
                    except BaseException:
                        self.invalidate()
                        raise
                    self.confirmations.add((target, ref["sha256"]))
                    return Confirmation(control, ref, "confirmed")
            # Only pre-admission natural expiry reaches here; no native I/O
            # under serial, and no retry after attempted/publish (even on error).
            self.refresh(force=True)

    def stop(self, control):
        with self.serial:
            self.bound(control)
            self.stopped, self.armed = True, False
            self.initializing = False
            io.publish_new(self.root / "STOP.json", dict(kind="strict_bootstrap_stop",
                control=asdict(control), owner=self.process, stopped_at=io.now(), execution_authorized=False))

    def reconcile(self, control, *, target, recheck):
        with self.serial:
            self.bound(control)
            self.invalidate()
            io.require(not self.stopped and not os.path.lexists(self.root / "STOP.json"), "bootstrap_stopped")
            self.identity.check()
            # This serial call proves the owner's original publisher is drained;
            # there is no adoption of arbitrary files or replay of native actions.
            io.require(self.attempted.get(target["path"]) == target, "bootstrap_original_commit_unknown")
            recheck()
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
            io.require(target in required and required[target][0] == actor, "bootstrap_settlement_path_invalid")
            intent = io.file_ref(root / required[target][1])
            io.require(self.query(control, intent).status == "confirmed", "bootstrap_native_intent_unconfirmed")
            ref = dict(path=target, sha256=io.digest(raw))
            io.require(target not in self.attempted, "bootstrap_commit_requires_reconciliation")
            self.attempted[target] = ref
            try:
                io.publish_new(Path(target), raw)
            except BaseException:
                self.invalidate()
                raise
            self.confirmations.add((target, ref["sha256"]))
            return Confirmation(control, ref, "confirmed")

    def close(self):
        with self.serial:
            self.closed, self.armed = True, False
            self.initializing = False
            if self.owner is not None:
                owner, self.owner = self.owner, None
                owner.__exit__(None, None, None)


def receive(connection):
    data = bytearray()
    while len(data) <= MAX_MESSAGE:
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
    """One bounded RPC at a time; no lock held during native identity refresh."""

    def __init__(self, owner, endpoint):
        self.owner = owner
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
        if op == "settle":
            io.require(set(args) == {"target", "raw"}, "bootstrap_rpc_invalid")
            return asdict(owner.settle(control, actor=actor, target=args["target"], raw=bytes.fromhex(args["raw"])))
        if op in {"runtime-review-input", "runtime-attest-trigger"}:
            io.require(actor == "operator" and set(args) == {"lifecycle", "continuation", "candidate"},
                       "bootstrap_runtime_operator_required")
            from startup_runtime import operator_action
            return operator_action(owner, self.owner_ref, op, args, identity)
        owner.refresh()
        unchanged(identity)
        owner.identity.authenticate(identity)
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
            io.require(set(args) == {"target"}, "bootstrap_rpc_invalid")
            return asdict(owner.reconcile(control, **args, recheck=lambda: unchanged(identity)))
        io.require(op == "commit" and set(args) == {"actor", "target", "raw", "prerequisites"}
                   and args["actor"] == actor, "bootstrap_rpc_role_mismatch")
        raw = bytes.fromhex(args.pop("raw"))
        return asdict(owner.commit_new(control, raw=raw, **args, recheck=lambda: unchanged(identity)))

    def serve(self, finished):
        while not finished.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(10)
                try:
                    message = receive(connection)
                    request_hash = io.digest(io.canonical(message))
                    try:
                        io.pinned(self.owner_ref)
                        result = self.dispatch(connection, message)
                        reply = dict(ok=True, result=result)
                    except (OSError, ValueError, KeyError, TypeError) as exc:
                        reply = dict(ok=False, error="bootstrap_rpc_rejected:" + safe_reason(exc),
                                     error_type=type(exc).__name__)
                    send(connection, self.signer.sign(dict(request_sha256=request_hash,
                                                          owner=self.owner_ref, reply=reply)))
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    # Unsigned diagnostics never become identity/durability evidence.
                    try:
                        send(connection, dict(ok=False, error=safe_reason(exc),
                                              error_type=type(exc).__name__))
                    except OSError:
                        pass

    def close(self):
        self.socket.close()
        self.owner.close()
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
        io.require(not self.read_only_poll or op in {"heartbeat", "check", "query", "observe", "runtime-observe"},
                   "bootstrap_poll_mutation_forbidden")
        try:
            return self._rpc(op, **args)
        except TimeoutError as exc:
            if self.read_only_poll:
                raise ReadOnlyPollExpired("bootstrap_read_only_poll_expired") from exc
            raise

    def check_deadline(self):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            if self.read_only_poll:
                raise ReadOnlyPollExpired("bootstrap_read_only_poll_expired")
            raise ValueError("bootstrap_tool_timeout_requires_reconciliation")

    def _rpc(self, op, **args):
        self.check_deadline()
        io.pinned(self.owner_ref)
        # Never compare a sandbox PID with the host /proc view. Server still
        # checks its own boot/start and authenticates the caller's host peer PID.
        request = dict(control=asdict(self.control), op=op, args=args, nonce=secrets.token_hex(32))
        with socket.socket(socket.AF_UNIX) as connection:
            remaining = 30 if self.deadline is None else min(30, self.deadline - time.monotonic())
            self.check_deadline()
            connection.settimeout(remaining)
            connection.connect(self.owner["endpoint"])
            send(connection, request)
            envelope = receive(connection)
        reply = verify(envelope, self.public_key, request, self.owner_ref)
        io.pinned(self.owner_ref)
        # Only exact, authenticated revalidation conditions in a read-only
        # scope are pending. Mutation replies and all other denials stay errors.
        if (self.read_only_poll and reply.get("ok") is False and
                (reply.get("error_type"), reply.get("error")) in {
                    ("IdentityVerificationPending", "bootstrap_rpc_rejected:bootstrap_native_identity_timeout"),
                    ("IdentitySnapshotExpired", "bootstrap_rpc_rejected:bootstrap_identity_snapshot_expired")}):
            raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
        if (self.read_only_poll and reply.get("ok") is False and
                reply.get("error_type") == "OperatorInputPending" and
                reply.get("error") == "bootstrap_rpc_rejected:startup_operator_input_review_required"):
            raise OperatorInputPending("startup_operator_input_review_required")
        io.require(reply.get("ok") is True, reply.get("error", "bootstrap_rpc_unknown"))
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
            return Confirmation(control, target, result["status"])
        except (ReadOnlyPollExpired, IdentityVerificationPending):
            raise
        except (OSError, ValueError):
            return Confirmation(control, target, "durability_unverified")

    def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
        io.require(control == self.control, "bootstrap_control_mismatch")
        recheck()
        result = self.rpc("commit", actor=actor, target=target, raw=raw.hex(), prerequisites=prerequisites)
        ref = dict(path=target, sha256=io.digest(raw))
        io.require(result == asdict(Confirmation(control, ref, "confirmed")), "bootstrap_confirmation_mismatch")
        return Confirmation(control, ref, "confirmed")

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
