"""Original-role bounded pull/return adapter. No TUI injection or model review.

Every returned action is bound to one immutable intent. A second pull of an
uncompleted action is reconciliation-only, never permission to repeat work.
The caller supplies produced bytes explicitly in a subsequent authenticated
tool invocation. S0 provision/pinning remains an Operator responsibility.
"""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import threading
import time

from bootstrap_control import AuthorityClient, CommitOwner, OwnerServer, ReadOnlyPollExpired
from bootstrap_identity import IdentityVerificationPending, NativeIdentity
from observation_budget import ObservationBusy
from bootstrap_driver import BootstrapMachine
from bootstrap_transport import safe_reason
from bootstrap_protocol import ControlBinding, EVENTS
from bootstrap_actions import ACTIONS, SUBMIT_TARGETS, command, completion_slot, submission
from bootstrap_admission import CandidateReader, chain_confirmations, confirmed, control_paths
from bootstrap_events import EvidenceReader, binding, contract_fields, review, version
from coordinator_io import canonical, digest, file_ref, now, parse, pinned, require, timestamp, validate_ref
from coordinator_strict import caller_result
from coordinator_strict_request import observed_coordinator

# Only these actions are produced mechanically by the tool itself (caller receipt
# and session observation). Every other stage carries this role's own authored
# candidate or review decision, so a bounded advance must stop and let the role
# run, never author it.
MECHANICAL_PRODUCE = frozenset({"caller-intent", "observe-intent"})
ADVANCE_MAX_STEPS = 8


def advance_decision(result, *, spec_of, candidates_exist):
    """Pure: what may a bounded advance do with one pull result?

    Returns one of `complete`, `stop-reconciliation`, `stop-judgement`, `stop`.
    """
    if not isinstance(result, dict) or "action" not in result:
        # pending / request_ready / s5_ready: a stage boundary, not permission.
        return "stop"
    if result.get("state") == "reconciliation_required":
        return "stop-reconciliation"
    name = result["action"]
    if name not in ACTIONS:
        return "stop-judgement"
    spec = spec_of(name)
    if spec.mode == "produce":
        return "complete" if name in MECHANICAL_PRODUCE else "stop-judgement"
    # A submit/readiness stage is mechanical only when this role already wrote
    # every candidate; completing it then re-validates and commits those exact
    # bytes, and can never turn into authoring the candidate here.
    return "complete" if candidates_exist(name) else "stop-judgement"


def provision(control):
    """Explicit S0 setup only; never replace locks, remove STOP or re-use owner."""
    from coordinator_io import path, publish_new, fsync_dir
    root = path(str(Path(control.attempt_binding["path"]).parent), directory=True)
    require(root.stat().st_uid == os.getuid() and root.stat().st_mode & 0o777 == 0o700,
            "bootstrap_private_root_required")
    for name in ("control", "operator", "coordinator", "events"):
        target = root / name
        if not target.exists():
            target.mkdir(mode=0o700)
            fsync_dir(root)
        path(str(target), directory=True)
        require(target.stat().st_uid == os.getuid() and target.stat().st_mode & 0o777 == 0o700,
                "bootstrap_private_root_required")
    require(not os.path.lexists(root / "control" / "owner.json")
            and not os.path.lexists(root / "control" / "STOP.json"), "bootstrap_existing_owner_requires_recovery")
    for name in ("owner", "operator-tool", "coordinator-tool"):
        publish_new(root / "control" / (name + ".lock"), b"")
    return dict(control=asdict(control), provisioned=True, execution_authorized=False)


class PullAdapter:
    def __init__(self, authority, actor):
        self.authority, self.actor = authority, actor

    def subscribe(self, callback):
        return lambda: None

    def recheck(self, control):
        result = self.authority.active(control)
        require(result["actor"] == self.actor, "bootstrap_original_role_required")


class ActionReader:
    """Immutable binding and exact owner queries; no writer lock, liveness or arm.

    Recovery must remain readable after deadlines/STOP. Confirmed here means
    historical durability only, never that the action is currently executable.
    """

    intent_kind = "strict_bootstrap_tool_intent"

    def __init__(self, control, authority, actor):
        require(actor in {"operator", "coordinator"}, "bootstrap_role_invalid")
        self.control, self.authority, self.actor = control, authority, actor
        self.root = Path(control.attempt_binding["path"]).parent
        attempt = parse(pinned(control.attempt_binding))["attempt_id"]
        reader = EvidenceReader()
        _, self.b = binding(reader, self.root, control.attempt_binding["sha256"], attempt)
        require(self.b["control"]["control_id"] == control.control_id
                and self.b["control"]["generation"] == control.generation, "bootstrap_control_mismatch")
        reader.recheck()
        self.paths = dict(self.b["paths"], **control_paths(self.root))

    def action_intent(self, intent_ref):
        value = parse(pinned(intent_ref))
        version(value, self.intent_kind, {"action", "attempt_binding", "control_id", "generation", "actor",
            "operator", "prerequisites", "payload", "created_at", "deadline", "execution_authorized"})
        name = value["action"]
        require(name in ACTIONS and self.paths[name] == intent_ref["path"] and value["actor"] == self.actor
                and ACTIONS[name].actor == self.actor and value["attempt_binding"] == self.control.attempt_binding
                and value["control_id"] == self.control.control_id and value["generation"] == self.control.generation
                and value["operator"] == self.b["operator"] and value["deadline"] == self.b["deadline"]
                and value["execution_authorized"] is False, "bootstrap_action_binding_mismatch")
        confirmed(self.authority, self.control, intent_ref)
        return value

    def inspect_action(self, intent_ref):
        """Read-only recovery projection; missing evidence never grants a retry."""
        intent = self.action_intent(intent_ref)
        name = intent["action"]
        spec = ACTIONS[name]
        record = (str(self.root / "control" / ("caller-execute.json" if name == "caller-intent" else "observe-execute.json"))
                  if spec.mode == "produce" else completion_slot(self.root, name))
        refs, record_status = [], "absent"
        if os.path.lexists(record):
            ref = file_ref(record)
            record_status = self.authority.query(self.control, ref).status
            if record_status == "confirmed":
                value = parse(pinned(ref))
                require(value["intent"] == intent_ref, "bootstrap_action_binding_mismatch")
                refs = value.get("outputs", [])
        final = self.paths[spec.target]
        if not refs and os.path.lexists(final):
            refs = [file_ref(final)]
        results = [dict(ref=ref, status=self.authority.query(self.control, ref).status) for ref in refs]
        complete = (record_status == "confirmed" and bool(results) and results[-1]["ref"]["path"] == final
                    and all(r["status"] == "confirmed" for r in results))
        return dict(state="confirmed" if complete else "reconciliation_required", intent=intent_ref,
            submission_record=record, submission_record_status=record_status,
            outputs=results, retry_allowed=False, execution_authorized=False)


def _ref_of(value):
    """Return the committed ref from a produce/submit result, else None."""
    if isinstance(value, dict) and isinstance(value.get("path"), str):
        return {"path": value["path"], "sha256": value.get("sha256")}
    if isinstance(value, dict) and isinstance(value.get("result"), dict):
        ref = value["result"]
        return {"path": ref.get("path"), "sha256": ref.get("sha256")}
    return None


class RoleTool(BootstrapMachine, ActionReader):
    def __init__(self, control, authority, actor):
        require(actor in {"operator", "coordinator"}, "bootstrap_role_invalid")
        self.actor = actor
        super().__init__(control, authority, PullAdapter(authority, actor), lock_name=actor + "-tool")

    def submission(self, name):
        return submission(self.b, name)

    def operation(self, name):
        spec = ACTIONS[name]
        return dict(schema_version=1, action=name, **asdict(spec))

    def action(self, name, target, prerequisites=(), **payload):
        spec = ACTIONS[name]
        require(self.actor == spec.actor and target == self.paths[spec.target], "bootstrap_action_binding_mismatch")
        payload["operation"] = self.operation(name)
        if spec.mode != "produce":
            payload["submission"] = self.submission(name)
        intent, fresh = self.intent(name, self.actor, prerequisites, **payload)
        return dict(state="action" if fresh else "reconciliation_required", action=name,
                    intent=intent, result_path=target, payload=payload,
                    **({"submission": payload["submission"]} if spec.mode != "produce" else {}),
                    complete_argv=command(self.authority.owner_ref, self.actor, "complete", intent) if fresh else None,
                    inspect_argv=command(self.authority.owner_ref, self.actor, "inspect-action", intent),
                    execution_authorized=False)

    def validate_action(self, intent_ref):
        value = self.action_intent(intent_ref)
        spec = ACTIONS[value["action"]]
        require(value["payload"].get("operation") == self.operation(value["action"]),
                "bootstrap_action_contract_mismatch")
        require(len(self.local_check()["validated_markers"]) == spec.markers, "bootstrap_action_stage_mismatch")
        return value

    def template(self, stage, request_ref):
        request = parse(pinned(request_ref))
        if stage == "fields":
            registration = parse(pinned(self.authority.owner["registration"]))
            return dict(self.b["fixed_inputs"], adapter="trae-tui-runtime-v1", runtime=self.b["runtime"],
                workspace=self.b["workspace"], operator=self.b["operator"],
                coordinator=parse(pinned(self.slot(EVENTS[1])))["coordinator"],
                observation=dict(profile=registration["profile"], log_root=registration["log_root"],
                    roots=[str(self.root)], caller_receipt=self.slot("caller_receipt"),
                    startup_anchor=self.slot("session_observation")))
        return dict(schema_version=1, kind="strict_bootstrap_review_result", request=request_ref,
            subject_refs=request["subject_refs"], evidence_refs=request["evidence_refs"], operator=request["operator"],
            decision=None, notes=None, reviewed_at=None, identity_verified=False, execution_authorized=False)

    def produce(self, intent_ref):
        """Mechanical caller/observation only. Never fields or model approval."""
        from trae_coordinator import native
        from trae_tui import observe
        self.local_check()
        intent = parse(pinned(intent_ref))
        name = intent["action"]
        if name in SUBMIT_TARGETS and self.slot(name) == intent_ref and intent["actor"] == self.actor:
            raise ValueError("bootstrap_operator_action_requires_candidate_submit")
        require(name in {"caller-intent", "observe-intent"}
                and self.slot(name) == intent_ref and intent["actor"] == self.actor,
                "bootstrap_produce_role_mismatch")
        self.validate_action(intent_ref)
        target = "caller_receipt" if name == "caller-intent" else "session_observation"
        require(self.slot(target) is None, "bootstrap_result_already_committed")
        execution = str(self.root / "control" / ("caller-execute.json" if name == "caller-intent" else "observe-execute.json"))
        require(self.slot(execution) is None, "bootstrap_production_outcome_requires_reconciliation")
        self.emit(execution, dict(kind="strict_bootstrap_production_intent", intent=intent_ref,
                                 actor=self.actor, started_at=now(), execution_authorized=False),
                  self.actor, [intent_ref])
        if name == "caller-intent":
            require(os.environ.get("ORCA_TERMINAL_HANDLE") == self.b["coordinator"]["terminal"],
                    "bootstrap_original_coordinator_context_required")
            value = native(self.b["fixed_inputs"]["cli"]["path"], self.b["runtime"],
                           ["orchestration", "strict-caller-check"])
            caller_result(value, self.b["runtime"])
        else:
            registration = parse(pinned(self.authority.owner["registration"]))
            coordinator = self.b["coordinator"]
            value = observe(cli=self.b["fixed_inputs"]["cli"]["path"], runtime=self.b["runtime"],
                terminal=coordinator["terminal"], incarnation=coordinator["incarnation"],
                workspace=self.b["workspace"]["id"], cwd=self.b["workspace"]["path"],
                profile=registration["profile"], log_root=registration["log_root"],
                roots=[str(self.root)], caller_receipt=self.slot("caller_receipt"),
                trae_runtime_config=self.b["fixed_inputs"]["runtime_config"]["path"],
                expected_thread=registration["roles"]["coordinator"]["session"], context_max_age_seconds=1800)
        return self.emit(target, value, self.actor, [intent_ref, self.slot(execution)])

    def step(self):
        state = self.local_check()
        count = len(state["validated_markers"])
        if self.actor == "coordinator":
            if count == 0:
                if self.slot("caller_receipt"):
                    self.marker(0, runtime=self.b["runtime"], workspace=self.b["workspace"],
                        caller_receipt=self.slot("caller_receipt"),
                        coordinator={k: self.b["coordinator"][k] for k in ("terminal", "incarnation", "agent")},
                        context=dict(context_max_age_seconds=1800, requires_live_caller_check=True))
                    return None
                return self.action("caller-intent", self.paths["caller_receipt"])
            if count < 3:
                return None
            self.intent("wait-contract", "coordinator", [self.slot(EVENTS[2])], marker=self.slot(EVENTS[2]))
            if not self.slot("final_readiness"):
                return self.action("final-evidence-intent", self.paths["final_readiness"],
                    [self.slot(EVENTS[2])], fields=self.slot("contract_fields"),
                    probes=self.b["file_tool_evidence_paths"])
            if count < 4:
                return None
            self.intent("wait-readiness", "coordinator", [self.slot(EVENTS[3])], marker=self.slot(EVENTS[3]))
            return dict(state="request_ready", readiness_marker=self.slot(EVENTS[3]),
                        request_input_preview=state["request_input_preview"], execution_authorized=False)
        if count == 0:
            return None
        if count == 1:
            observation = self.slot("session_observation")
            if not observation:
                return self.action("observe-intent", self.paths["session_observation"],
                    [self.slot(EVENTS[0])], caller=self.slot("caller_receipt"))
            source = dict(runtime=self.b["runtime"], workspace=self.b["workspace"],
                caller_receipt=self.slot("caller_receipt"), session_observation=observation)
            coordinator = observed_coordinator(source, caller_result(parse(pinned(source["caller_receipt"])), self.b["runtime"]))
            self.marker(1, **source, coordinator=coordinator,
                trust_boundary="runtime-state-and-log-not-live-process-attested", requires_live_caller_check=True)
            return None
        if count == 2:
            stages = [("fields", "contract_fields"), ("contract", "contract_review")]
        elif count == 3 and self.slot("final_readiness"):
            stages = [("readiness", "readiness_review")]
        elif count == 4:
            request = self.slot("request")
            return dict(state="s5_ready", request=request, execution_authorized=False) if request else None
        else:
            return None
        for stage, result in stages:
            request = self.operator_request(stage)
            if not self.slot(result):
                return self.action(stage + "-intent", self.paths[result], [request], request=request,
                                   candidate_template=self.template(stage, request),
                                   route="return_tool_for_review")
        if count == 2:
            self.marker(2, contract_fields=self.slot("contract_fields"), review_receipt=self.slot("contract_review"),
                must_match=dict(runtime=self.b["runtime"], workspace_id=self.b["workspace"]["id"],
                                coordinator_terminal=self.b["coordinator"]["terminal"]))
        else:
            refs = [self.b["fixed_inputs"]["skill_read_evidence"],
                    *[self.slot(p) for p in self.b["file_tool_evidence_paths"]],
                    self.slot("final_readiness"), self.slot("readiness_review")]
            self.marker(3, readiness_evidence=refs,
                evidence_roles=[dict(ref=ref, role="original-role-evidence") for ref in refs],
                required_refs=dict(skill_read_evidence_present=True,
                                   file_tool_probe_evidence_present=bool(self.b["file_tool_evidence_paths"])))
        return None

    def pull(self, timeout=30):
        require(type(timeout) in (int, float) and 0 < timeout <= 60, "bootstrap_bounded_wait_required")
        end = time.monotonic() + timeout
        prior = self.authority.deadline
        if prior is not None:
            end = min(end, prior)
        self.authority.deadline = end
        reason = "waiting_stage"

        def pending():
            return dict(state="pending", reason=reason, deadline=self.b["deadline"],
                        last_verified_heartbeat=self.authority.last_heartbeat,
                        current_liveness="unverified", execution_authorized=False)

        try:
            require(not self.closed and self.owner is not None and not self.stopping, "bootstrap_driver_stopped")
            self.check_owner()
            while time.monotonic() < end:
                # Timeout can become pending ONLY in this mechanically read-only
                # scope. No intent/marker/native action can be admitted here.
                try:
                    with self.authority.polling(end):
                        heartbeat = self.authority.heartbeat(self.control, self.actor)
                        reason = "awaiting_arm" if heartbeat["state"] == "awaiting_arm" else "waiting_stage"
                        state = self.local_check() if heartbeat["state"] == "ready" else None
                        actionable = state is not None and self.actionable(state)
                except ReadOnlyPollExpired:
                    reason = "read_only_poll_expired"
                    return pending()
                except IdentityVerificationPending:
                    reason = "identity_reverification_pending"
                    return pending()
                except ObservationBusy:
                    reason = "owner_busy_not_executed"
                    return pending()
                if actionable:
                    # A fresh step rechecks identity/facts. Its mutations and
                    # unknown outcomes are deliberately outside the catch above.
                    if time.monotonic() >= end:
                        return pending()
                    result = self.step()
                    if result:
                        return result
                if time.monotonic() >= end:
                    return pending()
                time.sleep(min(0.1, max(0, end - time.monotonic())))
            return pending()
        finally:
            self.authority.deadline = prior

    def actionable(self, state):
        """Read-only scheduling hint, never admission; step revalidates everything."""
        count = len(state["validated_markers"])
        if self.actor == "coordinator":
            return count == 0 or count >= 4 or (count == 3 and not self.slot("final_readiness"))
        return count in {1, 2} or (count == 3 and bool(self.slot("final_readiness"))) or (
            count >= 4 and bool(self.slot("request")))

    def candidate_bytes(self, source_ref, submission):
        validate_ref(source_ref)
        require(source_ref["path"] != submission["final_path"], "bootstrap_candidate_is_owner_output")
        require(source_ref["path"] == submission["candidate_path"], "bootstrap_candidate_path_mismatch")
        candidate = Path(source_ref["path"])
        require(candidate.resolve(strict=True) == candidate, "bootstrap_candidate_symlink_forbidden")
        require(candidate.stat().st_nlink == 1, "bootstrap_candidate_hardlink_forbidden")
        return pinned(source_ref)

    def submission_output_empty(self, target):
        try:
            existing = self.slot(target)
        except ValueError as exc:
            if str(exc) == "bootstrap_confirmation_unavailable":
                raise ValueError("bootstrap_owner_output_unconfirmed") from None
            raise
        require(existing is None, "bootstrap_result_already_committed")

    def submit(self, intent_ref, source_ref):
        self.local_check()
        intent = self.action_intent(intent_ref)
        name = intent["action"]
        require(self.slot(name) == intent_ref and intent["actor"] == self.actor,
                "bootstrap_action_binding_mismatch")
        require(name in SUBMIT_TARGETS, "bootstrap_action_requires_specialized_tool")
        submission = self.submission(name)
        require(intent["payload"].get("submission") == submission, "bootstrap_submission_contract_mismatch")
        target = SUBMIT_TARGETS[name]
        raw = self.candidate_bytes(source_ref, submission)
        self.submission_output_empty(target)
        record = completion_slot(self.root, name)
        require(not os.path.lexists(record), "bootstrap_submission_requires_reconciliation")

        def validate():
            self.validate_candidate(intent_ref, raw)
            self.candidate_bytes(source_ref, submission)
            self.submission_output_empty(target)

        validate()
        expected = dict(path=self.paths[target], sha256=digest(raw))
        admitted = self.emit(record, dict(schema_version=1, kind="strict_bootstrap_submission",
            intent=intent_ref, inputs=[source_ref], outputs=[expected], created_at=now(),
            execution_authorized=False), self.actor, [intent_ref], check=lambda _: validate())

        def recheck(_):
            validate()

        self.emit(target, raw, self.actor, [intent_ref, admitted], check=recheck)
        self.local_check()
        return {"result": self.slot(target), "execution_authorized": False}

    def validate_candidate(self, intent_ref, raw):
        intent = self.validate_action(intent_ref)
        name = intent["action"]
        stage = name.removesuffix("-intent")
        request_key = "fields_production_request" if stage == "fields" else stage + "_review_request"
        request_ref = self.slot(request_key)
        require(request_ref is not None and intent["payload"].get("request") == request_ref
                and intent["prerequisites"] == [request_ref], "bootstrap_action_request_mismatch")
        upstream = self.slot(EVENTS[2] if stage == "readiness" else EVENTS[1])
        request = parse(pinned(request_ref))
        if stage == "fields":
            version(request, "strict_bootstrap_fields_production_request", {
                "request_id", "attempt_binding", "upstream", "operator", "created_at", "deadline",
                "execution_authorized", "fixed_inputs", "evidence_refs", "result_path"})
            require(request["request_id"] == self.b["attempt_id"] + ":fields"
                and request["attempt_binding"] == self.control.attempt_binding and request["upstream"] == upstream
                and request["operator"] == self.b["operator"] and request["fixed_inputs"] == self.b["fixed_inputs"]
                and request["evidence_refs"] == [self.slot("caller_receipt"), self.slot("session_observation")]
                and request["result_path"] == self.paths["contract_fields"] and request["deadline"] == self.b["deadline"]
                and request["execution_authorized"] is False, "bootstrap_action_request_mismatch")
            require(timestamp(parse(pinned(upstream))["created_at"]) <= timestamp(request["created_at"])
                    <= timestamp(now()), "bootstrap_action_request_time_mismatch")
            source = dict(runtime=self.b["runtime"], workspace=self.b["workspace"], cli=self.b["fixed_inputs"]["cli"],
                coordinator=parse(pinned(upstream))["coordinator"], caller_receipt=self.slot("caller_receipt"),
                session_observation=self.slot("session_observation"))
            contract_fields(self.b, source, parse(raw))
        else:
            subject = self.slot("contract_fields" if stage == "contract" else "final_readiness")
            evidence = ([self.slot("caller_receipt"), self.slot("session_observation"), self.b["fixed_inputs"]["skill_read_evidence"]]
                if stage == "contract" else [self.b["fixed_inputs"]["skill_read_evidence"],
                                            *[self.slot(p) for p in self.b["file_tool_evidence_paths"]]])
            earliest = parse(pinned(upstream if stage == "contract" else subject))["created_at"]
            reader = CandidateReader(self.paths[ACTIONS[name].target], raw)
            review(reader, self.b, self.control.attempt_binding, stage, upstream, [subject], evidence,
                   timestamp(earliest), timestamp(now()), require_approval=False)
            reader.recheck()
            chain_confirmations(self.authority, self.control, self.b, reader)

    def submit_readiness(self, intent_ref, probe_refs):
        require(self.actor == "coordinator", "bootstrap_original_role_required")
        intent = self.action_intent(intent_ref)
        require(intent["action"] == "final-evidence-intent", "bootstrap_action_binding_mismatch")
        contract = self.submission(intent["action"])
        require(intent["payload"].get("submission") == contract, "bootstrap_submission_contract_mismatch")
        require(isinstance(probe_refs, list) and len(probe_refs) == len(contract["outputs"]), "bootstrap_probe_count_mismatch")
        # Validate the entire batch before admitting ANY probe publication.
        values = [self.candidate_bytes(ref, output) for ref, output in zip(probe_refs, contract["outputs"])]
        outputs = [dict(path=output["final_path"], sha256=digest(raw)) for output, raw in zip(contract["outputs"], values)]
        record = completion_slot(self.root, intent["action"])
        self.submission_output_empty("final_readiness")
        require(not os.path.lexists(record), "bootstrap_submission_requires_reconciliation")

        def validate():
            self.validate_action(intent_ref)
            require(intent["prerequisites"] == [self.slot(EVENTS[2])]
                    and intent["payload"].get("fields") == self.slot("contract_fields")
                    and intent["payload"].get("probes") == self.b["file_tool_evidence_paths"],
                    "bootstrap_action_request_mismatch")
            for ref, output in zip(probe_refs, contract["outputs"]):
                self.candidate_bytes(ref, output)
            self.submission_output_empty("final_readiness")

        validate()
        for output in outputs:
            self.submission_output_empty(output["path"])
        refs = [self.b["fixed_inputs"]["skill_read_evidence"], *outputs]
        manifest = dict(schema_version=1, kind="strict_bootstrap_readiness",
            attempt_binding=self.control.attempt_binding, contract_fields=self.slot("contract_fields"),
            evidence=refs, created_at=now(), execution_authorized=False)
        manifest_ref = dict(path=self.paths["final_readiness"], sha256=digest(canonical(manifest) + b"\n"))
        def before_admission(_):
            validate()
            for output in outputs:
                self.submission_output_empty(output["path"])
        admitted = self.emit(record, dict(schema_version=1, kind="strict_bootstrap_submission",
            intent=intent_ref, inputs=probe_refs, outputs=[*outputs, manifest_ref], created_at=now(),
            execution_authorized=False), self.actor, [intent_ref], check=before_admission)
        for output, raw in zip(outputs, values):
            self.emit(output["path"], raw, self.actor, [intent_ref, admitted], check=lambda _: validate())
        return self.emit("final_readiness", manifest, self.actor, [intent_ref, admitted, *outputs], check=lambda _: validate())

    def advance(self, *, until_stage=None, timeout=120, poll=30):
        """Run this role's own mechanical stages in one bounded call.

        One model turn used to be spent per stage hop. This loop keeps the same
        intents, owner commits, prerequisites and pins, and stops the moment a
        step would need this role's own authored candidate or review decision.
        """
        require(type(timeout) in (int, float) and 0 < timeout <= 600,
                "bootstrap_advance_budget_invalid")
        require(type(poll) in (int, float) and 0 < poll <= 60,
                "bootstrap_advance_budget_invalid")
        require(until_stage is None or (type(until_stage) is int and 0 <= until_stage <= 4),
                "bootstrap_advance_stage_invalid")
        end, steps = time.monotonic() + timeout, []

        def candidates(name):
            try:
                contract = self.submission(name)
            except ValueError:
                return False
            return bool(contract["outputs"]) and all(
                os.path.lexists(item["candidate_path"]) for item in contract["outputs"])

        while len(steps) < ADVANCE_MAX_STEPS and time.monotonic() < end:
            stage = len(self.local_check()["validated_markers"])
            if until_stage is not None and stage >= until_stage:
                return dict(state="stage_reached", stage=stage, steps=steps,
                            execution_authorized=False)
            result = self.pull(min(poll, max(0.1, end - time.monotonic())))
            decision = advance_decision(result, spec_of=lambda name: ACTIONS[name],
                                        candidates_exist=candidates)
            if decision != "complete":
                states = {"stop-reconciliation": "reconciliation_required",
                          "stop-judgement": "needs_role_judgement",
                          "stop": result.get("state", "pending")}
                return dict(state=states[decision], stage=stage, result=result, steps=steps,
                            execution_authorized=False)
            committed = self.complete(result["intent"])
            steps.append({"action": result["action"], "intent": result["intent"]["path"],
                          "committed": _ref_of(committed)})
        return dict(state="advance_budget_spent" if time.monotonic() >= end
                    else "advance_step_limit", steps=steps, execution_authorized=False)

    def complete(self, intent_ref):
        """Dispatch a pinned action, deriving file pins locally; never generate evidence."""
        intent = self.action_intent(intent_ref)
        spec = ACTIONS[intent["action"]]
        if spec.mode == "produce":
            return self.produce(intent_ref)
        contract = self.submission(intent["action"])
        require(intent["payload"].get("submission") == contract, "bootstrap_submission_contract_mismatch")
        require(not os.path.lexists(completion_slot(self.root, intent["action"])),
                "bootstrap_submission_requires_reconciliation")
        refs = [file_ref(output["candidate_path"]) for output in contract["outputs"]]
        return self.submit(intent_ref, refs[0]) if spec.mode == "submit" else self.submit_readiness(intent_ref, refs)

def connect(owner_ref):
    value = parse(pinned(owner_ref))
    control = ControlBinding(**value["control"])
    return control, AuthorityClient(control, owner_ref)


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("provision", "serve", "arm", "stop", "query", "heartbeat", "reconcile", "pull", "produce", "submit", "readiness", "complete", "advance", "inspect-action", "build", "plan"))
    parser.add_argument("--owner")
    parser.add_argument("--owner-sha256")
    parser.add_argument("--binding")
    parser.add_argument("--binding-sha256")
    parser.add_argument("--registration")
    parser.add_argument("--registration-sha256")
    parser.add_argument("--endpoint")
    parser.add_argument("--actor", choices=("operator", "coordinator"))
    parser.add_argument("--input", help="For submit: exact submission.candidate_path returned by pull, never result_path")
    parser.add_argument("--input-sha256")
    parser.add_argument("--intent")
    parser.add_argument("--intent-sha256")
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--poll", type=float, default=30)
    parser.add_argument("--until-stage", type=int)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(args.execute == (args.mode not in {"query", "heartbeat", "plan", "inspect-action"}), "bootstrap_explicit_execute_required")
        if args.mode in {"serve", "provision"}:
            ref = dict(path=args.binding, sha256=args.binding_sha256)
            b = parse(pinned(ref))
            control = ControlBinding(ref, b["control"]["control_id"], b["control"]["generation"])
            if args.mode == "provision":
                print(json.dumps(provision(control)))
                return 0
            identity = NativeIdentity(control, dict(path=args.registration, sha256=args.registration_sha256))
            identity.refresh()
            owner = CommitOwner(control, identity)
            try:
                server = OwnerServer(owner, args.endpoint)
            except BaseException:
                # No server has taken ownership and no requests can execute.
                owner.close()
                raise
            try:
                print(json.dumps({"owner": file_ref(owner.root / "owner.json"), "armed": False}), flush=True)
                server.serve(threading.Event())
            finally:
                try:
                    server.close()
                except ValueError as exc:
                    if str(exc) == "bootstrap_owner_busy_requires_reconciliation":
                        from bootstrap_diagnostics import close_rejected
                        exc.diagnostics = close_rejected(server)
                    # NEVER bypass a rejected close via owner.close(). The CLI
                    # exits; only externally observed exit permits reconciliation.
                    raise
            return 0
        owner_ref = dict(path=args.owner, sha256=args.owner_sha256)
        control, authority = connect(owner_ref)
        ref = dict(path=args.input, sha256=args.input_sha256)
        if args.mode == "query":
            result = asdict(authority.query(control, ref))
        elif args.mode == "heartbeat":
            require(args.actor in {"operator", "coordinator"}, "bootstrap_role_invalid")
            authority.heartbeat(control, args.actor)
            result = authority.last_heartbeat
        elif args.mode in {"arm", "stop", "reconcile"}:
            result = authority.rpc(args.mode, **({"target": ref} if args.mode == "reconcile" else {}))
        elif args.mode == "plan":
            from bootstrap_s5 import role_plan
            result = role_plan(owner_ref)
        elif args.mode == "inspect-action":
            reader = ActionReader(control, authority, args.actor)
            result = reader.inspect_action(dict(path=args.intent, sha256=args.intent_sha256))
        else:
            tool = RoleTool(control, authority, args.actor)
            try:
                intent = dict(path=args.intent, sha256=args.intent_sha256)
                if args.mode == "pull":
                    result = tool.pull(args.timeout)
                elif args.mode == "produce":
                    result = tool.produce(intent)
                elif args.mode == "submit":
                    result = tool.submit(intent, ref)
                elif args.mode == "readiness":
                    result = tool.submit_readiness(intent, parse(pinned(ref)))
                elif args.mode == "complete":
                    result = tool.complete(intent)
                elif args.mode == "advance":
                    result = tool.advance(until_stage=args.until_stage,
                                          timeout=args.timeout, poll=args.poll)
                else:
                    require(args.actor == "coordinator", "bootstrap_original_role_required")
                    result = tool.build(parse(pinned(ref)), require_live=True)
            finally:
                tool.close()
        print(json.dumps(dict(ok=True, result=result), ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result = dict(ok=False, error="bootstrap_tool_failed", error_type=type(exc).__name__,
                      reason=safe_reason(exc), execution_authorized=False)
        if getattr(exc, "commit_state", None) is not None:
            result["state"] = exc.commit_state
            result["may_replay"] = getattr(exc, "may_replay", exc.commit_state == "not_admitted")
        if hasattr(exc, "diagnostics"):
            result["diagnostics"] = exc.diagnostics
        print(json.dumps(result))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli_main())
