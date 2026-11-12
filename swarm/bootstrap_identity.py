"""Linux, same-host bootstrap peers; no credentials are exported in receipts.

The separately pinned registration binds native hook attribution to a live
process tree. SO_PEERCRED, boot/start ticks and ancestry are all required; a
role name, UID or inherited terminal hint alone never authenticates a caller.
This is a cooperative same-UID boundary, not protection from malicious peers
which can read each other's memory/environment. Original native gates remain.
"""

import os
from pathlib import Path
import socket
import struct
import subprocess
import time

from coordinator_io import digest, parse, pinned, require, timestamp, now
import provider_capability

IDENTITY_LEASE_SECONDS = 30
IDENTITY_REFRESH_MARGIN_SECONDS = 5


class IdentityVerificationPending(ValueError):
    """Fresh evidence unavailable; no new admission, no assertion of death."""


class IdentitySnapshotExpired(IdentityVerificationPending):
    """Natural lease expiry, distinct from failed identity/pin verification."""


class BootstrapAdmissionClosed(ValueError):
    """Startup deadline closes startup actions, not an established runtime."""


class OperatorInputPending(ValueError):
    """Original Operator must handle exact input; not a role identity change."""


class NativeIdentityChanged(ValueError):
    """A role no longer matches its registration; `diagnostics` says which field.

    Why it carries fields: the bare code forced the caller to read this module to learn whether
    the session id, the incarnation or the pane key drifted. Values are truncated to a recognisable
    prefix - the point is "which field", never a transcript of the evidence.
    """

    def __init__(self, code, **diagnostics):
        super().__init__(code)
        self.diagnostics = diagnostics


def identity_pair(expected, observed):
    """A short, comparable pair: prefixes plus the verdict, never the whole identifier."""
    def short(value):
        text = "" if value is None else str(value)
        return text[:8] + "\u2026" if len(text) > 8 else text
    return {"expected": short(expected), "observed": short(observed),
            "equal": expected == observed}


def process(pid):
    require(type(pid) is int and pid > 1, "bootstrap_process_required")
    root = Path("/proc") / str(pid)
    try:
        fields = (root / "stat").read_text().rsplit(")", 1)[1].split()
        require(fields[0] not in {"Z", "X"}, "bootstrap_process_exited")
        return dict(pid=pid, start=fields[19],
                    boot=Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                    uid=root.stat().st_uid)
    except PermissionError:
        raise ValueError("bootstrap_proc_permission_denied") from None
    except FileNotFoundError:
        raise ValueError("bootstrap_process_not_visible") from None


def unchanged(identity):
    require(process(identity["pid"]) == identity, "bootstrap_process_changed")


def host_process():
    # Owner and procfs must use the same PID numbering; sandbox clients need not.
    require(int(Path("/proc/self/stat").read_text().split(" ", 1)[0]) == os.getpid(),
            "bootstrap_host_proc_view_mismatch")
    return process(os.getpid())


def descendant(pid, anchor):
    unchanged(anchor)
    for _ in range(128):
        if pid == anchor["pid"]:
            return
        require(pid > 1, "bootstrap_peer_wrong_process_tree")
        fields = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
        pid = int(fields[1])
    raise ValueError("bootstrap_peer_ancestry_unverifiable")


def peer(connection):
    pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(pid > 1, "bootstrap_peer_pid_unmapped")
    identity = process(pid)
    require(identity["uid"] == uid == os.getuid(), "bootstrap_peer_uid_mismatch")
    return identity


class NativeIdentity:
    """Acquire native evidence outside admission, check its short lease inside.

    registration is an independently reviewed Ref, never supplied by a peer.
    Each role declares its own provider; the provider is resolved through
    `provider_capability` and then verified against native evidence, so it is a
    property of the observed session rather than a reader constant.
    roots must be the original provider process roots, not runtime/server PID.
    A surviving root alone is insufficient: every refresh checks native terminal
    incarnation, provider session, launch commitment and transcript attribution.
    """

    def __init__(self, control, registration):
        self.control, self.registration = control, registration
        self.b = parse(pinned(control.attempt_binding))
        self.value = parse(pinned(registration))
        require(set(self.value) == {"schema_version", "attempt_binding", "profile", "log_root", "roles"}
                and type(self.value["schema_version"]) is int and self.value["schema_version"] == 2
                and self.value["attempt_binding"] == control.attempt_binding
                and set(self.value["roles"]) == {"operator", "coordinator"},
                "bootstrap_registration_invalid")
        # Reject an unverifiable declared provider before probing any process.
        for registered in self.value["roles"].values():
            require(set(registered) == {"provider", "process", "session"},
                    "bootstrap_role_registration_invalid")
        self.capabilities = {role: self.role_capability(role) for role in self.value["roles"]}
        roots = [v["process"] for v in self.value["roles"].values()]
        require(roots[0] != roots[1], "bootstrap_roles_not_independent")
        # Neither role may contain the other role's process tree.
        for left, right in ((roots[0], roots[1]), (roots[1], roots[0])):
            try:
                descendant(left["pid"], right)
            except ValueError as exc:
                require(str(exc) == "bootstrap_peer_wrong_process_tree", str(exc))
            else:
                raise ValueError("bootstrap_roles_not_independent")
        self.expires = 0
        self.snapshot = None
        self.evidence = {}
        self.mailbox = None

    def role_capability(self, role, *, observed=None):
        """Resolve this role's declared provider; never default to another one.

        The registration names the provider and is pinned/reviewed, so it is a
        property of the observed session rather than a reader constant. A name
        this build cannot verify is refused here (and again against the actual
        observation) with the missing evidence channels.
        """
        return provider_capability.require(
            self.value["roles"][role]["provider"], provider_capability.BOOTSTRAP_ROLE,
            required="bootstrap_registration_provider_required",
            unsupported="bootstrap_registration_provider_unsupported",
            unavailable="bootstrap_" + role + "_provider_evidence_unavailable",
            observed=observed)

    def refresh(self):
        self._refresh_checked(runtime=False)

    def refresh_runtime(self):
        self._refresh_checked(runtime=True)

    def _refresh_checked(self, *, runtime):
        from supervisor.config import SafetyError
        self.expires = 0
        local = self.check_invariants if runtime else self.check_local
        try:
            local()
            self._refresh(runtime=runtime)
        except subprocess.TimeoutExpired:
            # Do not hide a changed local pin/process behind a native timeout.
            local()
            raise IdentityVerificationPending("bootstrap_native_identity_timeout") from None
        except (SafetyError, subprocess.SubprocessError):
            raise ValueError("bootstrap_native_identity_unverifiable") from None

    def _refresh(self, *, runtime=False):
        from swarm_ledger import runtime_binding
        from trae_tui import Queries
        from trae_coordinator import native
        deadline = time.monotonic() + 20

        class BoundedQueries(Queries):
            def read(query, *args):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise IdentityVerificationPending("bootstrap_native_identity_timeout")
                return native(query.cli, query.runtime_id, list(args), timeout_seconds=min(5, remaining))

        observations = {}
        evidence_by_role = {}
        self.expires = 0  # A failed refresh must invalidate a previous lease.
        for role, registered in self.value["roles"].items():
            anchor = registered["process"]
            unchanged(anchor)
            require(anchor["uid"] == os.getuid(), "bootstrap_process_uid_mismatch")
            identity = self.b[role]
            capability = self.capabilities[role]
            evidence = runtime_binding.capture(BoundedQueries(self.b["fixed_inputs"]["cli"]["path"], self.b["runtime"]),
                dict(provider=capability.provider, format=capability.evidence_format,
                     host=socket.gethostname(), require_launch_commitment=True,
                     terminal_handle=identity["terminal"], worktree_id=self.b["workspace"]["id"],
                     profile=self.value["profile"], log_root=self.value["log_root"], max_hook_age_seconds=1800),
                clock=time.time, previous=self.evidence.get(role))
            observed = evidence["identity"]
            # The declared capability must also hold for what was observed.
            self.role_capability(role, observed=observed)
            observed_incarnation = observed["terminal"]["incarnationId"]
            if observed_incarnation != identity["incarnation"] or \
                    observed["session_id"] != registered["session"]:
                raise NativeIdentityChanged(
                    "bootstrap_native_identity_changed", role=role,
                    incarnation=identity_pair(identity["incarnation"], observed_incarnation),
                    session=identity_pair(registered["session"], observed["session_id"]),
                    pane=identity_pair(registered.get("terminal"), identity["terminal"]))
            if role == "operator":
                if registered["session"] != identity["session"]:
                    raise NativeIdentityChanged(
                        "bootstrap_operator_session_changed", role=role,
                        session=identity_pair(identity["session"], registered["session"]))
            else:
                t = observed["terminal"]
                if t["ptyId"] + ":" + t["incarnationId"] != identity["process_incarnation"] or \
                        t["tabId"] + ":" + t["leafId"] != identity["pane_key"]:
                    raise NativeIdentityChanged(
                        "bootstrap_coordinator_process_changed", role=role,
                        process_incarnation=identity_pair(
                            identity["process_incarnation"], t["ptyId"] + ":" + t["incarnationId"]),
                        pane_key=identity_pair(identity["pane_key"],
                                               t["tabId"] + ":" + t["leafId"]))
            # Inspect only the registered original process. Never print/store env.
            env = dict(item.split(b"=", 1) for item in
                       (Path("/proc") / str(anchor["pid"]) / "environ").read_bytes().split(b"\0") if b"=" in item)
            require(env.get(b"ORCA_TERMINAL_HANDLE") == identity["terminal"].encode()
                    and env.get(b"ORCA_PANE_KEY") == (observed["terminal"]["tabId"] + ":" + observed["terminal"]["leafId"]).encode()
                    and bool(env.get(b"ORCA_AGENT_LAUNCH_TOKEN"))
                    and digest(env[b"ORCA_AGENT_LAUNCH_TOKEN"]) == observed["launch_token_hash"],
                    "bootstrap_native_process_binding_unverifiable")
            unchanged(anchor)
            observations[role] = observed
            evidence_by_role[role] = evidence
        query = BoundedQueries(self.b["fixed_inputs"]["cli"]["path"], self.b["runtime"])
        mailbox = query.read("orchestration", "check", "--terminal", self.b["operator"]["terminal"], "--peek")
        require(not mailbox.get("runId") and type(mailbox.get("count")) is int
                and isinstance(mailbox.get("messages"), list) and mailbox["count"] == len(mailbox["messages"]),
                "bootstrap_operator_mailbox_unverifiable")
        self.mailbox = mailbox
        if self.snapshot is not None:
            require(observations == self.snapshot, "bootstrap_native_identity_changed")
        (self.check_invariants if runtime else self.check_local)()
        if not runtime and mailbox["count"]:
            raise OperatorInputPending("bootstrap_operator_competing_input")
        if time.monotonic() >= deadline:
            raise IdentityVerificationPending("bootstrap_native_identity_timeout")
        self.evidence = evidence_by_role
        self.snapshot, self.expires = observations, time.monotonic() + IDENTITY_LEASE_SECONDS
        (self.check_runtime if runtime else self.check)()

    def check(self):
        # Check permanent constraints first, and lease AFTER potentially slow I/O.
        self.check_local()
        if self.snapshot is None or time.monotonic() >= self.expires:
            raise IdentitySnapshotExpired("bootstrap_identity_snapshot_expired")
        if self.mailbox and self.mailbox["count"]:
            raise OperatorInputPending("bootstrap_operator_competing_input")

    def check_runtime(self):
        self.check_invariants()
        if self.snapshot is None or time.monotonic() >= self.expires:
            raise IdentitySnapshotExpired("bootstrap_identity_snapshot_expired")

    def check_local(self):
        self.check_startup_deadline()
        self.check_invariants()
        self.check_startup_deadline()

    def check_startup_deadline(self):
        if timestamp(now()) >= timestamp(self.b["deadline"]):
            raise BootstrapAdmissionClosed("bootstrap_deadline_exceeded")

    def check_invariants(self):
        pinned(self.registration)
        pinned(self.control.attempt_binding)
        for ref in [*self.b["fixed_inputs"].values(), *self.b["authorization_refs"]]:
            pinned(ref)
        for registered in self.value["roles"].values():
            unchanged(registered["process"])

    def verify_run(self, contract):
        from trae_coordinator import native
        try:
            result = native(self.b["fixed_inputs"]["cli"]["path"], self.b["runtime"],
                            ["orchestration", "run-show", "--id", contract["run"]["id"]], timeout_seconds=5)
        except subprocess.TimeoutExpired:
            self.check_invariants()
            raise IdentityVerificationPending("bootstrap_native_identity_timeout") from None
        run = result.get("run", {})
        require(result.get("coordinatorPolicy") == "strict-v1" and not result.get("strictRetirement")
                and run.get("id") == contract["run"]["id"]
                and type(run.get("consumer_generation")) is int
                and run.get("consumer_generation") == contract["run"]["generation"]
                and run.get("coordinator_handle") == contract["coordinator"]["terminal"],
                "startup_run_binding_changed")

    def authenticate(self, identity):
        unchanged(identity)
        matches = []
        for role, registered in self.value["roles"].items():
            try:
                descendant(identity["pid"], registered["process"])
                matches.append(role)
            except ValueError as exc:
                if str(exc) != "bootstrap_peer_wrong_process_tree":
                    raise
        require(len(matches) == 1, "bootstrap_peer_role_unverifiable")
        return matches[0]
