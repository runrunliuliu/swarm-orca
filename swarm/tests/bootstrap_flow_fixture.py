"""Deterministic role/runtime adapters. No real identity, review, model or Agent."""

import copy
from collections import Counter

from bootstrap_protocol import OperatorDelivery
from coordinator_io import canonical, digest, parse, pinned


class OfflineAdapters:
    offline_fixture = True

    def __init__(self, base, control, authority):
        self.base, self.control, self.authority = base, control, authority
        self.driver = None
        self.calls = Counter()
        self.trace = []
        self.submissions, self.completed, self.pending = {}, {}, {}
        self.produced = {}  # Original role's independent result ledger, not files.
        self.session, self.safe_point = "tool_wait", True
        self.delay = set()
        self.decisions = {}
        self.identity_valid = True
        self.notify = None
        self.drop_notifications = False
        self.observation = None
        self.caller_value = None
        self.final_values = None
        self.provenance_valid = True

    def outside_admission(self):
        assert self.authority.serial.acquire(blocking=False), "adapter called inside admission"
        self.authority.serial.release()

    def subscribe(self, callback):
        self.notify = callback
        return lambda: setattr(self, "notify", None)

    def signal(self):
        if self.notify and not self.drop_notifications:
            self.notify()

    def recheck(self, control):
        assert control == self.control, "fixture_control_changed"
        if not self.identity_valid:
            raise ValueError("fixture_identity_changed")
        self.authority.active(control)

    def caller(self, control, intent):
        self.outside_admission()
        self.calls["caller"] += 1
        self.trace.append("caller")
        self.caller_value = copy.deepcopy(self.base.tui.caller)
        return self.caller_value

    def query_caller(self, control, intent):
        self.calls["query_caller"] += 1
        return self.caller_value

    def observe(self, control, intent, caller):
        self.outside_admission()
        self.calls["observe"] += 1
        self.trace.append("observe")
        self.observation = copy.deepcopy(self.base.observation)
        self.observation["caller_receipt"] = caller
        return self.observation

    def query_observation(self, control, intent):
        self.outside_admission()
        self.calls["query_observation"] += 1
        return self.observation

    def session_state(self, control):
        self.outside_admission()
        return self.session, self.safe_point

    def stage(self, request):
        value = parse(pinned(request))
        return value.get("stage", "fields")

    def submit(self, control, request):
        self.outside_admission()
        self.recheck(control)
        stage = self.stage(request)
        assert stage not in self.submissions, "duplicate fixture submission"
        assert self.driver.slot(stage + "-intent") is not None
        self.calls["submit_" + stage] += 1
        self.trace.append("submit_" + stage)
        self.submissions[stage] = request
        self.pending[stage] = "unknown" if stage in self.delay else "turn_started"
        if stage not in self.delay:
            self.complete(stage)
        return self.delivery(stage)

    def delivery(self, stage):
        result = self.completed.get(stage)
        return OperatorDelivery(self.submissions[stage], "completed" if result else self.pending[stage], result)

    def query(self, control, request):
        self.outside_admission()
        stage = self.stage(request)
        self.calls["query_" + stage] += 1
        if stage not in self.submissions:
            return OperatorDelivery(request, "unknown", None)
        assert self.submissions[stage] == request
        if stage in self.produced and stage not in self.completed:
            # Reconcile only the original role's exact result after a reply or
            # confirmation gap. Never regenerate/re-publish an unknown result.
            original_request, result, raw = self.produced[stage]
            assert original_request == request
            self.calls["query_result_" + stage] += 1
            if self.authority.query(control, result).status == "confirmed":
                assert pinned(result) == raw
                self.completed[stage] = result
        return self.delivery(stage)

    def complete(self, stage):
        self.outside_admission()
        assert stage not in self.produced, "duplicate fixture production"
        request = self.submissions[stage]
        value = parse(pinned(request))
        if stage == "fields":
            # This production happens only after the first wait starts; the
            # original base fields are a fixed template, not a future result.
            result = copy.deepcopy(parse(pinned(self.base.source["contract_fields"])))
            result.update(value["fixed_inputs"])
            result["observation"].update(caller_receipt=value["evidence_refs"][0],
                                         startup_anchor=value["evidence_refs"][1])
        else:
            result = dict(schema_version=1, kind="strict_bootstrap_review_result", request=request,
                subject_refs=value["subject_refs"], evidence_refs=value["evidence_refs"],
                operator=value["operator"], decision=self.decisions.get(stage, "approve"),
                notes="Deterministic offline fixture, not a real review", reviewed_at=self.base.clock.isoformat(),
                identity_verified=False, execution_authorized=False)
        self.calls["produce_" + stage] += 1
        self.trace.append("produce_" + stage)
        raw = canonical(result) + b"\n"
        self.produced[stage] = (request, dict(path=value["result_path"], sha256=digest(raw)), raw)
        # Every producer uses the very same authority; only fixture-local
        # provenance retained below is trusted, never the JSON actor declaration.
        self.completed[stage] = self.driver.emit(value["result_path"], result, "operator",
            [request, self.driver.slot(stage + "-intent")])
        self.signal()

    def verify_result(self, control, request, delivery, result):
        self.outside_admission()
        if not self.provenance_valid:
            raise ValueError("fixture_provenance_unverified")
        assert control == self.control and self.submissions[self.stage(request)] == request
        assert self.completed[self.stage(request)] == result == delivery.native_receipt

    def final_evidence(self, control, intent, fields):
        self.outside_admission()
        assert self.driver.slot("wait-contract") is not None
        assert self.driver.slot("readiness-evidence-ready") is None
        self.calls["final_evidence"] += 1
        self.trace.append("final_evidence_after_wait_return")
        # Actual deterministic file read performed in the Coordinator adapter,
        # not a pre-created probe or an Operator/driver-generated approval.
        role = self.driver.b["fixed_inputs"]["role_skill"]
        raw = pinned(role)
        self.final_values = [canonical(dict(kind="offline_file_tool_probe", role_skill=role,
                                             bytes_read=len(raw))) + b"\n"]
        return self.final_values

    def query_final_evidence(self, control, intent):
        self.outside_admission()
        self.calls["query_final_evidence"] += 1
        return self.final_values
