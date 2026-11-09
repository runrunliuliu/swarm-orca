"""Shared bootstrap state machine and historical offline test composition.

Production authentication and original-role tools live in bootstrap_control,
bootstrap_identity and bootstrap_tool; this core never launches Agents.
All producer bytes go through one supplied CommitAuthority. The test harness
provides its fixed lock inodes and independently controlled role adapters.
"""

import os
from functools import wraps
from pathlib import Path
import threading
import time

from bootstrap_admission import (CandidateReader, chain_confirmations, confirmed,
                                 control_paths, inspect_chain)
from bootstrap_events import EvidenceReader, require, review
from bootstrap_protocol import EVENTS, PRODUCERS, RequestAdmission, review_route
from coordinator_io import (canonical, digest, directory_lock, file_ref, now, parse, pinned, timestamp)
from coordinator_request_prepare import source_contract
from coordinator_startup import build_session_contract
from coordinator_strict import caller_result
from coordinator_strict_request import observed_coordinator


def active_operation(method):
    """Keep the driver inode held through direct builder/producer callbacks too."""
    @wraps(method)
    def call(self, *args, **kwargs):
        with self.condition:
            require(not self.closed and not self.stopping, "bootstrap_driver_stopped")
            self.operations += 1
        try:
            return method(self, *args, **kwargs)
        finally:
            with self.condition:
                self.operations -= 1
                self.condition.notify_all()
    return call


class BootstrapMachine:
    """A single drain owner plus two bounded Coordinator waits, not a daemon.

    notify() only marks dirty. Waits and explicit ticks drain fixed paths; the
    condition/sequence closes the check-to-sleep window. Long adapter work is
    outside both the scheduling mutex and authority's short admission mutex.
    """

    def __init__(self, control, authority, adapters, *, lock_name="driver"):
        self.control, self.authority, self.adapters = control, authority, adapters
        self.root = Path(control.attempt_binding["path"]).parent
        self.b, _, _ = inspect_chain(control)
        self.paths = dict(self.b["paths"], **control_paths(self.root))
        self.condition = threading.Condition()
        self.requested, self.running, self.stopping = False, False, False
        self.closed = False
        self.operations = 0
        self.sequence = 0
        self.owner = directory_lock(self.root / "control", lock_name, create=False)
        self.check_owner = self.owner.__enter__()
        self.unsubscribe = None
        try:
            # Subscribe BEFORE the first scan; existing facts need no notification.
            self.unsubscribe = adapters.subscribe(self.notify)
            self.notify()
        except BaseException:
            self.owner.__exit__(None, None, None)
            raise

    def close(self):
        with self.condition:
            require(not self.running and self.operations == 0, "bootstrap_driver_still_running")
            self.closed = True
            self.condition.notify_all()
        if self.unsubscribe is not None:
            self.unsubscribe()
            self.unsubscribe = None
        if self.owner is not None:
            owner, self.owner = self.owner, None
            owner.__exit__(None, None, None)

    def notify(self):
        with self.condition:
            if self.closed:
                return  # A late callback cannot revive a closed drain owner.
            self.requested = True
            self.sequence += 1
            self.condition.notify_all()

    def stop(self):
        with self.condition:
            self.stopping = True
            self.condition.notify_all()
        self.authority.stop(self.control)

    def local_check(self):
        require(not self.closed and self.owner is not None and not self.stopping, "bootstrap_driver_stopped")
        self.check_owner()
        # Adapter only checks an already acquired local identity/authorization
        # snapshot here; no native or model work is permitted inside admission.
        self.adapters.recheck(self.control)
        b, state, reader = inspect_chain(self.control)
        chain_confirmations(self.authority, self.control, b, reader)
        return state

    def slot(self, name):
        target = self.paths.get(name, name)
        if not os.path.lexists(target):
            return None
        return confirmed(self.authority, self.control, file_ref(target))

    def emit(self, name, value, actor, prerequisites=(), check=None):
        target = self.paths.get(name, name)
        raw = value if isinstance(value, bytes) else canonical(value) + b"\n"

        def recheck():
            self.local_check()
            if check is not None:
                check(raw)

        reply = self.authority.commit_new(self.control, actor=actor, target=target,
            raw=raw, prerequisites=list(prerequisites), recheck=recheck)
        expected = {"path": target, "sha256": digest(raw)}
        require(reply.control == self.control and reply.target == expected and reply.status == "confirmed",
                "bootstrap_commit_confirmation_mismatch")
        confirmed(self.authority, self.control, expected)
        self.notify()  # Notifications never substitute for the confirmation query.
        return reply.target

    def intent(self, name, actor, prerequisites, **payload):
        existing = self.slot(name)
        if existing is not None:
            value = parse(pinned(existing))
            require(value["prerequisites"] == list(prerequisites) and value["payload"] == payload
                    and value["actor"] == actor and value["attempt_binding"] == self.control.attempt_binding
                    and value["control_id"] == self.control.control_id
                    and value["generation"] == self.control.generation, "bootstrap_intent_mismatch")
            return existing, False
        value = dict(schema_version=1, kind=getattr(self, "intent_kind", "strict_bootstrap_offline_intent"), action=name,
            attempt_binding=self.control.attempt_binding, control_id=self.control.control_id,
            generation=self.control.generation, actor=actor, operator=self.b["operator"],
            prerequisites=list(prerequisites), payload=payload, created_at=now(), deadline=self.b["deadline"],
            execution_authorized=False)
        return self.emit(name, value, actor, prerequisites), True

    def marker(self, index, **extra):
        event = EVENTS[index]
        prior = self.slot(EVENTS[index - 1]) if index else None
        value = dict(schema_version=1, kind="strict_bootstrap_event", event=event,
            attempt_id=self.b["attempt_id"], sequence=index + 1, attempt_binding=self.control.attempt_binding,
            created_at=now(), producer=PRODUCERS[index], execution_authorized=False, **extra)
        if prior is not None:
            value["consumes"] = dict(prior, event=EVENTS[index - 1])

        def validate(raw):
            reader = CandidateReader(self.paths[event], raw)
            b, state, reader = inspect_chain(self.control, reader=reader)
            require(state["last_validated_stage"] == event, "bootstrap_candidate_stage_mismatch")
            chain_confirmations(self.authority, self.control, b, reader)

        return self.emit(event, value, PRODUCERS[index], [prior] if prior else [], check=validate)

    @active_operation
    def publish_caller(self):
        self.local_check()
        if self.slot(EVENTS[0]):
            return
        caller = self.slot("caller_receipt")
        if caller is None:
            intent, fresh = self.intent("caller-intent", "coordinator", [])
            value = (self.adapters.caller(self.control, intent) if fresh
                     else self.adapters.query_caller(self.control, intent))
            require(value is not None, "bootstrap_caller_outcome_unknown")
            caller = self.emit("caller_receipt", value, "coordinator", [intent])
        self.marker(0, runtime=self.b["runtime"], workspace=self.b["workspace"],
            caller_receipt=caller,
            coordinator={k: self.b["coordinator"][k] for k in ("terminal", "incarnation", "agent")},
            context=dict(context_max_age_seconds=1800, requires_live_caller_check=True))

    def operator_request(self, stage):
        name = "fields_production_request" if stage == "fields" else stage + "_review_request"
        upstream = self.slot(EVENTS[2] if stage == "readiness" else EVENTS[1])
        skill = self.b["fixed_inputs"]["skill_read_evidence"]
        evidence = ([skill, *[self.slot(p) for p in self.b["file_tool_evidence_paths"]]]
                    if stage == "readiness" else [self.slot("caller_receipt"), self.slot("session_observation")])
        common = dict(schema_version=1, request_id=self.b["attempt_id"] + ":" + stage,
            attempt_binding=self.control.attempt_binding, upstream=upstream, operator=self.b["operator"],
            created_at=now(), deadline=self.b["deadline"], execution_authorized=False)
        if stage == "fields":
            value = dict(common, kind="strict_bootstrap_fields_production_request",
                fixed_inputs=self.b["fixed_inputs"], evidence_refs=evidence,
                result_path=self.paths["contract_fields"])
        else:
            if stage == "contract":
                evidence.append(skill)
            subjects = [self.slot("final_readiness" if stage == "readiness" else "contract_fields")]
            value = dict(common, kind="strict_bootstrap_review_request", stage=stage,
                subject_refs=subjects, evidence_refs=evidence, result_path=self.paths[stage + "_review"])
        existing = self.slot(name)
        if existing:
            original = parse(pinned(existing))
            value["created_at"] = original["created_at"]
            require(original == value, "bootstrap_operator_request_mismatch")
            return existing
        return self.emit(name, value, "operator", [upstream])

    def operator_step(self, stage):
        request = self.operator_request(stage)
        intent_name = stage + "-intent"
        intent = self.slot(intent_name)
        if intent is None:
            session, supported = self.adapters.session_state(self.control)
            route = review_route(delivery="new", session=session, safe_point_supported=supported)
            require(not route.startswith("blocked_"), route)
            if route in {"defer_to_safe_point", "reconcile_delivery"}:
                return False
            self.intent(intent_name, "operator", [request], request=request, route=route)
            delivery = self.adapters.submit(self.control, request)
        else:
            # Even an intent with no transport receipt might already have been
            # accepted. Query the exact original ID; never resubmit.
            delivery = self.adapters.query(self.control, request)
        require(delivery.request == request, "bootstrap_delivery_request_mismatch")
        self.local_check()
        if delivery.status != "completed":
            require(delivery.status in {"new", "submitted", "input_accepted", "turn_started", "unknown"},
                    "bootstrap_delivery_status_invalid")
            return False
        result = self.slot("contract_fields" if stage == "fields" else stage + "_review")
        require(result is not None, "bootstrap_completed_without_result")
        # Independent adapter provenance, NOT the result's self-declared actor.
        self.adapters.verify_result(self.control, request, delivery, result)
        if stage == "fields":
            fields = parse(pinned(result))
            require(all(fields.get(k) == v for k, v in self.b["fixed_inputs"].items())
                    and fields.get("operator") == self.b["operator"], "contract_fixed_inputs_mismatch")
            expected = dict(runtime=self.b["runtime"], workspace=self.b["workspace"],
                cli=self.b["fixed_inputs"]["cli"], contract_fields=result,
                coordinator=parse(pinned(self.slot(EVENTS[1])))["coordinator"],
                readiness_evidence=[self.b["fixed_inputs"]["skill_read_evidence"]])
            require(fields["observation"]["caller_receipt"] == self.slot("caller_receipt")
                    and fields["observation"]["startup_anchor"] == self.slot("session_observation"),
                    "contract_observation_mismatch")
            build_session_contract(source_contract(expected))
        else:
            value = parse(pinned(request))
            earliest = parse(pinned(value["subject_refs"][0] if stage == "readiness" else value["upstream"]))["created_at"]
            reader = EvidenceReader()
            review(reader, self.b, self.control.attempt_binding, stage, value["upstream"],
                   value["subject_refs"], value["evidence_refs"], timestamp(earliest), timestamp(now()))
            chain_confirmations(self.authority, self.control, self.b, reader)
        return True

    def advance(self):
        state = self.local_check()
        count = len(state["validated_markers"])
        if count == 0 or count == 4:
            return False
        if count == 1:
            observation = self.slot("session_observation")
            if observation is None:
                caller = self.slot("caller_receipt")
                intent, fresh = self.intent("observe-intent", "operator", [self.slot(EVENTS[0])], caller=caller)
                value = (self.adapters.observe(self.control, intent, caller) if fresh
                         else self.adapters.query_observation(self.control, intent))
                if value is None:
                    return False
                observation = self.emit("session_observation", value, "operator", [intent])
            source = dict(runtime=self.b["runtime"], workspace=self.b["workspace"],
                caller_receipt=self.slot("caller_receipt"), session_observation=observation)
            coordinator = observed_coordinator(source, caller_result(parse(pinned(source["caller_receipt"])),
                                                                       self.b["runtime"]))
            self.marker(1, **source, coordinator=coordinator,
                trust_boundary="runtime-state-and-log-not-live-process-attested", requires_live_caller_check=True)
            return True
        if count == 2:
            if not self.operator_step("fields") or not self.operator_step("contract"):
                return False
            self.marker(2, contract_fields=self.slot("contract_fields"), review_receipt=self.slot("contract_review"),
                must_match=dict(runtime=self.b["runtime"], workspace_id=self.b["workspace"]["id"],
                                coordinator_terminal=self.b["coordinator"]["terminal"]))
            return True
        if self.slot("final_readiness") is None:
            return False  # Return the first wait so the Coordinator can produce it.
        if not self.operator_step("readiness"):
            return False
        evidence = [self.b["fixed_inputs"]["skill_read_evidence"],
                    *[self.slot(p) for p in self.b["file_tool_evidence_paths"]],
                    self.slot("final_readiness"), self.slot("readiness_review")]
        self.marker(3, readiness_evidence=evidence,
            evidence_roles=[dict(ref=r, role="offline-evidence") for r in evidence],
            required_refs=dict(skill_read_evidence_present=True,
                               file_tool_probe_evidence_present=bool(self.b["file_tool_evidence_paths"])))
        return True

    def drain(self, *, until=None):
        """Bound each tick even under a continuous/reentrant notification storm.

        Adapters must themselves return boundedly; this cannot preempt a stuck
        synchronous adapter. A yielded dirty tick is scanned by the next wait
        iteration/caller, without spawning another driver or renewing deadlines.
        """
        with self.condition:
            require(not self.closed and not self.stopping, "bootstrap_driver_stopped")
            self.requested = True  # Every tick scans fixed paths, even with lost events.
            if self.running:
                return
            self.running = True
        try:
            for _ in range(16):
                if until is not None and time.monotonic() >= until:
                    break
                with self.condition:
                    self.requested = False
                progressed = self.advance()
                with self.condition:
                    if not progressed and not self.requested:
                        self.running = False
                        self.condition.notify_all()
                        return
            with self.condition:
                self.requested = True
                self.running = False
                self.condition.notify_all()
        except BaseException:
            with self.condition:
                self.running = False
                self.condition.notify_all()
            raise

    @active_operation
    def wait_for(self, stage, *, timeout=5, interval=0.05):
        require(stage in {EVENTS[2], EVENTS[3]} and 0 < interval <= 1 and 0 < timeout <= 60,
                "bootstrap_bounded_wait_required")
        end = time.monotonic() + timeout
        while True:
            with self.condition:
                sequence = self.sequence
            self.drain(until=end)
            result = self.slot(stage)
            if result is not None:
                name = "wait-contract" if stage == EVENTS[2] else "wait-readiness"
                self.intent(name, "coordinator", [result], marker=result)
                self.local_check()
                return result
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("bootstrap_wait_pending")
            with self.condition:
                if self.sequence == sequence and not self.stopping:
                    self.condition.wait(min(interval, remaining))

    @active_operation
    def final_readiness(self):
        require(self.slot("wait-contract") is not None, "bootstrap_first_wait_required")
        self.local_check()
        fields = self.slot("contract_fields")
        if self.slot("final_readiness"):
            return
        intent, fresh = self.intent("final-evidence-intent", "coordinator", [self.slot(EVENTS[2])], fields=fields)
        values = (self.adapters.final_evidence(self.control, intent, fields) if fresh
                  else self.adapters.query_final_evidence(self.control, intent))
        require(values is not None, "bootstrap_final_evidence_outcome_unknown")
        require(len(values) == len(self.b["file_tool_evidence_paths"]), "bootstrap_probe_count_mismatch")
        refs = [self.b["fixed_inputs"]["skill_read_evidence"]]
        for target, raw in zip(self.b["file_tool_evidence_paths"], values):
            existing = self.slot(target)
            if existing:
                require(pinned(existing) == raw, "bootstrap_probe_conflict")
            refs.append(existing or self.emit(target, raw, "coordinator", [intent]))
        self.emit("final_readiness", dict(schema_version=1, kind="strict_bootstrap_readiness",
            attempt_binding=self.control.attempt_binding, contract_fields=fields, evidence=refs,
            created_at=now(), execution_authorized=False), "coordinator", [self.slot(EVENTS[2]), *refs[1:]])

    @active_operation
    def build(self, source, *, require_live=False):
        import coordinator_strict_request
        self.local_check()
        require(self.slot("wait-readiness") is not None, "bootstrap_second_wait_required")
        s4 = self.slot(EVENTS[3])
        # Pre-flight the one requirement that can never be repaired later: the
        # task_source authorization must equal the binding's. commit_request
        # enforces this only at the final publish seam, AFTER request-input has
        # been committed, and that owner slot can never be rewritten.
        task_ref = source.get("task_source")
        require(isinstance(task_ref, dict) and set(task_ref) == {"path", "sha256"},
                "strict_config_request_input_invalid")
        task = parse(pinned(task_ref))
        require(task["authorization_refs"] == self.b["authorization_refs"],
                "bootstrap_authorization_refs_mismatch")
        admission = RequestAdmission(self.control, s4)
        preview = self.local_check()["request_input_preview"]
        value = dict(source, **preview)
        ref = self.slot("request-input")
        if ref:
            require(parse(pinned(ref)) == value, "bootstrap_request_input_mismatch")
        association = self.slot("request-admission")
        if association:
            require(ref is not None, "bootstrap_request_input_missing")
            value = parse(pinned(association))
            require(value["readiness_marker"] == s4 and value["attempt_binding"] == self.control.attempt_binding
                    and value["control_id"] == self.control.control_id and value["generation"] == self.control.generation,
                    "bootstrap_request_association_mismatch")
            # An unknown/missing commit is NOT permission to rerun the builder.
            return confirmed(self.authority, self.control, value["request"])
        if ref is None:
            ref = self.emit("request-input", value, "coordinator", [s4])
        result = coordinator_strict_request.build_request(ref, require_live=require_live,
            bootstrap_admission=admission, authority=self.authority)
        return result["request"]

    @active_operation
    def downstream(self, request, callback):
        """Fake S5 action; old production strict-start entries are NOT connected."""
        self.local_check()
        association = self.slot("request-admission")
        require(association is not None, "bootstrap_request_association_required")
        value = parse(pinned(association))
        require(value["request"] == request and value["readiness_marker"] == self.slot(EVENTS[3])
                and value["attempt_binding"] == self.control.attempt_binding
                and value["control_id"] == self.control.control_id and value["generation"] == self.control.generation,
                "bootstrap_downstream_binding_mismatch")
        intent, fresh = self.intent("downstream-intent", "coordinator", [association, request],
                                   request=request, readiness_marker=value["readiness_marker"])
        require(fresh, "bootstrap_downstream_query_required")
        return callback(self.control, intent)  # Already admitted/in-flight at STOP.

    @active_operation
    def run(self, source):
        self.publish_caller()
        self.wait_for(EVENTS[2])
        self.final_readiness()
        self.wait_for(EVENTS[3])
        return self.build(source)


class OfflineBootstrapDriver(BootstrapMachine):
    """Historical deterministic test composition; never a production adapter."""

    def __init__(self, control, authority, adapters):
        require(getattr(adapters, "offline_fixture", False) is True, "offline_adapter_required")
        super().__init__(control, authority, adapters)
