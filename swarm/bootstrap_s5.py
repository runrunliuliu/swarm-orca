"""Strict-start integration: explicit same-owner pins, no request schema change.

Only registered bootstrap attempts are intercepted. Historical attempts keep
their exact API. A bootstrap binding with no explicit owner never falls back.
Native gate/create calls run in the original role outside the owner's mutex.
"""

from contextvars import ContextVar
from functools import wraps
from pathlib import Path
import os
import shlex
import sys
import time

from coordinator_io import canonical, file_ref, now, parse, pinned, require

current = ContextVar("strict_bootstrap_s5", default=None)

# Non-execution replies mean the owner admitted nothing: the same intent may be
# retried in place. Anything else (including an unknown outcome) must reconcile.
NON_EXECUTION_RETRY_SECONDS = 20


def non_execution(exc):
    from observation_budget import ObservationBusy
    from bootstrap_identity import IdentityVerificationPending
    # Both mean "nothing was admitted"; the identity lease expiry is the same
    # class because it is re-acquired by the next admission attempt.
    return (isinstance(exc, (ObservationBusy, IdentityVerificationPending))
            or str(exc) == "bootstrap_identity_snapshot_expired")


def commit_confirmed(authority, control, *, actor, target, raw, prerequisites, recheck,
                     retry_seconds=NON_EXECUTION_RETRY_SECONDS):
    """Commit once, retrying only replies that prove nothing was admitted."""
    end = time.monotonic() + retry_seconds
    while True:
        try:
            recheck()
            reply = authority.commit_new(control, actor=actor, target=target, raw=raw,
                                         prerequisites=list(prerequisites), recheck=recheck)
            return confirmed(authority, control, reply.target)
        except (OSError, ValueError) as exc:
            # A busy owner or a throwaway identity lease admitted nothing. An
            # unknown outcome is NOT in that class and must reconcile instead.
            if not non_execution(exc) or time.monotonic() >= end:
                raise
            time.sleep(0.2)


def confirmed(*args):
    from bootstrap_admission import confirmed as verify
    return verify(*args)


class S5Guard:
    def __init__(self, owner_ref, request_ref, actor, action):
        from bootstrap_tool import connect
        self.control, self.authority = connect(owner_ref)
        self.owner_ref, self.request, self.actor, self.action = owner_ref, request_ref, actor, action
        self.root = Path(request_ref["path"]).parent
        self.association = file_ref(self.root / "control" / "request-admission.json")
        association = parse(pinned(self.association))
        require(association["request"] == request_ref and association["attempt_binding"] == self.control.attempt_binding
                and association["control_id"] == self.control.control_id
                and association["generation"] == self.control.generation, "bootstrap_s5_association_mismatch")
        self.ready = association["readiness_marker"]
        for ref in (self.association, self.ready, request_ref):
            confirmed(self.authority, self.control, ref)
        self.check()
        self.intent = self.publish(self.root / "control" / ("s5-" + action + ".json"),
            dict(kind="strict_bootstrap_s5_intent", action=action, actor=actor,
                 control_id=self.control.control_id, generation=self.control.generation,
                 request=request_ref, association=self.association, started_at=now(), execution_authorized=False))

    def check(self):
        require(self.authority.active(self.control)["actor"] == self.actor, "bootstrap_original_role_required")
        pinned(self.request)
        pinned(self.association)
        pinned(self.ready)

    def verify_read(self, ref):
        target = Path(ref["path"])
        if target.parent in (self.root / "strict-start", self.root / "lifecycle") or target in {
                self.root / "strict-config-ready.json", self.root / "strict-config-review.json"}:
            reply = self.authority.query(self.control, ref)
            require(reply.status == "confirmed", "bootstrap_s5_input_unconfirmed")

    def publish(self, target, value):
        raw = value if isinstance(value, bytes) else canonical(value) + b"\n"
        return commit_confirmed(self.authority, self.control, actor=self.actor, target=str(target), raw=raw,
                                prerequisites=[self.association, self.ready, self.request], recheck=self.check)

    def publication(self, target, value):
        # Staging/probe paths are local, non-ready evidence of the already
        # admitted prepare operation. All final delivery bytes go to owner.
        target = Path(target)
        if target in {self.root / "strict-start" / "create-response.json",
                       self.root / "strict-start" / "operator-gate.json"}:
            raw = value if isinstance(value, bytes) else canonical(value) + b"\n"
            result = self.authority.rpc("settle", target=str(target), raw=raw.hex())
            from coordinator_io import digest
            require(result["target"] == {"path": str(target), "sha256": digest(raw)}
                    and result["status"] == "confirmed", "bootstrap_settlement_unknown")
            return True
        if target.parent.parent == self.root and target.parent.name.startswith((
                ".strict-start-staging-", ".strict-start-storage-probe-")):
            require(self.action == "prepare", "bootstrap_staging_not_allowed")
            self.check()
            return False
        self.publish(target, value)
        return True


def checkpoint():
    guard = current.get()
    if guard is not None:
        guard.check()


def protect(action, actor, *, config=False):
    def decorator(function):
        @wraps(function)
        def call(ref, *args, bootstrap_owner=None, **kwargs):
            root = Path(ref["path"]).parent.parent if config else Path(ref["path"]).parent
            binding_present = os.path.lexists(root / "attempt-binding.json")
            require(not binding_present or bootstrap_owner is not None or current.get() is not None,
                    "bootstrap_owner_required")
            if bootstrap_owner is None:
                return function(ref, *args, **kwargs)
            require(binding_present and current.get() is None, "bootstrap_s5_nested_or_unbound")
            value = parse(pinned(ref)) if config else None
            if config and value.get("schema_version") == 4:
                value = parse(pinned(value["base_config"]))
            request_ref = value["request"] if config else ref
            guard = S5Guard(bootstrap_owner, request_ref, actor, action)
            token = current.set(guard)
            try:
                result = function(ref, *args, **kwargs)
                guard.check()
                return result
            finally:
                current.reset(token)
        return call
    return decorator


def cli_options(parser):
    parser.add_argument("--bootstrap-owner")
    parser.add_argument("--bootstrap-owner-sha256")


def cli_owner(args):
    require(bool(args.bootstrap_owner) == bool(args.bootstrap_owner_sha256), "bootstrap_owner_pin_required")
    return dict(path=args.bootstrap_owner, sha256=args.bootstrap_owner_sha256) if args.bootstrap_owner else None


def plan_commands(result, owner_ref=None):
    guard = current.get()
    owner_ref = owner_ref or (guard.owner_ref if guard else None)
    if owner_ref is None:
        return result
    suffix = ["--bootstrap-owner", owner_ref["path"], "--bootstrap-owner-sha256", owner_ref["sha256"]]
    for key in ("wait_argv", "operator_publish_argv", "operator_check_argv"):
        if key in result:
            result[key] = [*result[key], *suffix]
    if "wait_argv" in result:
        if "strict-config-wait" in result["wait_argv"] and "--execute" not in result["wait_argv"]:
            result["wait_argv"].append("--execute")
        result["wait_command"] = shlex.join(result["wait_argv"])
    result["bootstrap_owner"] = owner_ref
    return result


def role_plan(owner_ref):
    from bootstrap_tool import connect
    from bootstrap_admission import inspect_chain
    from bootstrap_actions import plan_actions, plan_stages
    control, authority = connect(owner_ref)
    b, _, _ = inspect_chain(control)
    prefix = [sys.executable, "-B", str(Path(__file__).resolve().with_name("coordinator_launch.py")),
              "strict-bootstrap", "pull", "--owner", owner_ref["path"], "--owner-sha256", owner_ref["sha256"]]
    return dict(execution_authorized=False, attempt_binding=control.attempt_binding,
        coordinator_pull=shlex.join([*prefix, "--actor", "coordinator", "--execute"]),
        operator_pull=shlex.join([*prefix, "--actor", "operator", "--execute"]),
        deadline=b["deadline"], actions=plan_actions(b), stages=[
            "Original Operator: explicitly arm the pinned S0 owner after outer audit; owner.json is registration, not readiness",
            "Coordinator: pull reports pending/awaiting_arm until the original Operator arms; never arm or end the original turn for initial waiting",
            *plan_stages(),
            "Coordinator: pull returns request_ready -> build --execute with original reviewed task input",
            "Operator: pull returns s5_ready -> strict-start-prepare, strict-config-review; then operator_startup.py prepare schema v2 with explicit execution mode, original bootstrap_owner and fixed sender/paths BEFORE strict-config-publish",
            "Coordinator: strict-config-wait -> review returned plan -> strict-start-wait",
            "Operator: observe exact ready.json -> strict-start-publish; retain same owner on all S5 commands",
            "Both roles: created is NOT startup completion; immediately use returned lifecycle pull/accept/complete commands: materials -> original Operator review -> Coordinator dispatch -> continuation; do not wait for Worker before continuation",
            "Original sender: run operator_startup foreground lifecycle executor; only current mode-specific runtime_ready permits startup responsibility handoff; retain original bootstrap owner through runtime"],
        rules=["Run these tools in the two existing native sessions; never synthesize environment identity",
               "Use fresh action.complete_argv; it dispatches the pinned action without inventing paths or approvals. "
               "candidate_template supplies fixed fields; review decision/notes/reviewed_at require the original independent reviewer",
               "For Operator submissions and Coordinator probes, pull returns the intent-pinned submission contract: "
               "candidate_path / outputs[].candidate_path are the ONLY file-tool outputs; "
               "result_path/final_path is owner-only output, never write it directly or pass it as --input",
               "submit uses the original intent pin plus candidate path/raw SHA; only owner publication and exact final-pin query confirm durability",
               "Unconfirmed owner output must be preserved, not deleted/overwritten/adopted; reconcile only the same owner's known original commit, not arbitrary files",
               "pending: repeat bounded pull before original deadline; no outer natural-language wakeup required",
               "last_verified_heartbeat is historical signed liveness/readiness, not commit confirmation or authority; missing/late replies do not prove death",
               "read_only_poll_expired: only the read-only wait expired; no action is granted, no deadline extension or automatic re-arm",
               "reconciliation_required: use inspect_argv (read-only, retry_allowed=false); never repeat production, "
               "replay a partial submission or renew timestamps; absent evidence does not grant retry",
               "Keep original model turn alive through bounded tools; idle without a registered tool call is unsupported",
               "Every strict-start execute command must retain --bootstrap-owner and --bootstrap-owner-sha256",
               "No Run/Worker launch authority is granted by this plan"])
