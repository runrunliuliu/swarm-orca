"""Opt-in Operator executor. One driver, pinned adapters, no research decisions.

Adapters are reviewed Python programs speaking JSON over stdin/stdout. Only execute
may mutate the provider; probe/query must be read-only. This is a trusted-program
contract, not a sandbox or a built-in training-platform integration.
"""

import argparse
from datetime import timedelta
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import coordinator_driver as driver
import coordinator_handoff as handoff
import coordinator_background as background
from coordinator_io import (bound_lock, canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, read_json, replace_json, require, timestamp)


class Config:
    def __init__(self, filename, sha256):
        self.ref = {"path": str(path(filename)), "sha256": sha256}
        c = self.data = parse(pinned(self.ref))
        require(isinstance(c, dict) and set(c) == {"schema_version", "enabled", "driver_binding",
                "adapters", "routes", "evidence_root", "budget", "poll_seconds",
                "rpc_timeout_seconds", "max_unknown_polls"}, "invalid_operator_config")
        require(type(c["schema_version"]) is int and c["schema_version"] == 2
                and type(c["enabled"]) is bool, "invalid_operator_config")
        pinned(c["driver_binding"])
        self.driver = driver.Config(c["driver_binding"]["path"], c["driver_binding"]["sha256"])
        self.actor = self.driver.data["outer_operator"]["id"]
        for key in ("poll_seconds", "rpc_timeout_seconds", "max_unknown_polls"):
            require(type(c[key]) is int and c[key] > 0, "invalid_operator_limits")
        require(c["poll_seconds"] <= 60 and c["rpc_timeout_seconds"] <= 60, "invalid_operator_limits")
        require(isinstance(c["adapters"], dict) and c["adapters"], "operator_adapters_required")
        for ref in c["adapters"].values():
            pinned(ref)
        authority = driver.authority_inputs(self.driver)
        catalog = authority["context"]["paths"]
        catalog = {r["id"]: r for r in catalog}
        require(isinstance(c["routes"], dict) and c["routes"], "operator_routes_required")
        for key, route in c["routes"].items():
            require(key in catalog and isinstance(route, dict) and set(route) ==
                    {"operation", "adapter", "kinds", "completion"}
                    and route["completion"] in {"terminal", "background"}
                    and route["operation"] == catalog[key]["operation"]
                    and route["adapter"] in c["adapters"] and driver.strings(route["kinds"]),
                    "operator_route_not_reviewed")
        self.evidence = path(c["evidence_root"], directory=True)
        require(any(self.evidence.is_relative_to(r) for r in self.driver.progress_roots)
                and not any(self.evidence == r or self.evidence.is_relative_to(r)
                            for r in self.driver.excluded_evidence), "operator_evidence_outside_scope")
        budget = c["budget"]
        require(isinstance(budget, dict) and set(budget) ==
                {"run_started_at", "deadline_at", "max_tokens", "max_cost_micro_usd"}, "invalid_operator_budget")
        started = timestamp(budget["run_started_at"])
        # A restart must not start a fresh time budget. The actual Run start still
        # needs independent review; this check rejects even the latest possible reset.
        initial = parse(pinned(self.driver.data["initial_checkpoint"]))
        require(started <= timestamp(initial["observed_at"]), "operator_run_start_after_checkpoint")
        if budget["deadline_at"] is not None:
            require(started < timestamp(budget["deadline_at"]), "invalid_operator_budget")
        for key in ("max_tokens", "max_cost_micro_usd"):
            require(budget[key] is None or type(budget[key]) is int and budget[key] > 0,
                    "invalid_operator_budget")
        fields = authority["handoff"]["fields"]
        tokens = fields.get("limits.tokens", {})
        if tokens.get("mode") == "bounded":
            require(budget["max_tokens"] is not None and budget["max_tokens"] <= tokens["value"],
                    "operator_budget_exceeds_authority")
        duration = fields.get("limits.time_seconds", {})
        if duration.get("mode") == "bounded":
            require(budget["deadline_at"] is not None and timestamp(budget["deadline_at"])
                    <= started + timedelta(seconds=duration["value"]), "operator_budget_exceeds_authority")

    def revalidate(self):
        Config(self.ref["path"], self.ref["sha256"])


def invoke(ref, request, *, cwd, timeout, start_new_session=False):
    # Execute precisely the pinned bytes, not a changed file or unpinned .pyc.
    source = pinned(ref).decode("utf-8")
    program = "exec(compile(" + repr(source) + ", '<pinned-operator-adapter>', 'exec'))"
    reply = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", program],
                           input=canonical(request), stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, cwd=cwd, timeout=timeout,
                           start_new_session=start_new_session)
    require(reply.returncode == 0, "operator_adapter_call_failed")
    return parse(reply.stdout)


def locked(config):
    """All automated actions for this driver share one lock and immutable binding."""
    return bound_lock(config.driver.root, config.ref, "operator")


def current(config, *, active=True):
    d = config.driver
    ref = file_ref(d.root / "state.json")
    journal = driver.Journal(d.root, d.sha256)
    journal.data = parse(pinned(ref))
    journal.validate()
    require(not os.path.lexists(d.root / "state.next.json"), "unreconciled_state_write")
    state = journal.data
    if active:
        require(state["outcome"] is None and state["pending"] is None
                and not os.path.lexists(d.root / "STOP"), "operator_driver_not_active")
    request = (state["current"] or {}).get("operator_request")
    return ref, state, request


def admission(config, observation, *, outstanding=(), path_ids=()):
    """Complete, fresh run-wide use plus reservations; unknown is never zero."""
    require(isinstance(observation, dict) and set(observation) ==
            {"scope", "observed_at", "complete", "used", "reserved", "estimate", "active_training_trials",
             "training_slots"} and observation["scope"] == config.driver.data["binding"]["run"]
            and observation["complete"] is True, "operator_usage_incomplete")
    age = (timestamp(now()) - timestamp(observation["observed_at"])).total_seconds()
    require(0 <= age <= 60, "operator_usage_stale")
    for key in ("used", "reserved", "estimate"):
        values = observation[key]
        require(isinstance(values, dict) and set(values) == {"tokens", "cost_micro_usd"}
                and all(type(n) is int and n >= 0 for n in values.values()), "operator_usage_unknown")
    for key in ("active_training_trials", "training_slots"):
        require(type(observation[key]) is int and observation[key] >= 0, "operator_occupancy_unknown")
    require(observation["training_slots"] <= 1, "operator_invalid_training_reservation")
    if any(set(path_ids).intersection(job["path_ids"]) for job in outstanding):
        return "operator_background_path_occupied"
    if any(job["reservation"] is None for job in outstanding):
        return "operator_background_reservation_unknown"
    local_slots = sum(job["reservation"]["training_slots"] for job in outstanding)
    if max(local_slots, observation["active_training_trials"]) + observation["training_slots"] > config.driver.data["limits"]["max_training_trials"]:
        return "training_capacity_exhausted"
    for metric in ("tokens", "cost_micro_usd"):
        cap = config.data["budget"]["max_" + metric]
        reserved = max(observation["reserved"][metric], sum(j["reservation"][metric] for j in outstanding))
        if cap is not None and observation["used"][metric] + reserved + observation["estimate"][metric] > cap:
            return "operator_" + metric + "_budget_exhausted"
    return None


def validate_reply(reply, key, job):
    require(isinstance(reply, dict) and set(reply) == {"operation_key", "status", "job", "evidence"}
            and reply["operation_key"] == key and reply["status"] in
            {"queued", "running", "succeeded", "failed", "not_executed", "unknown"},
            "operator_adapter_reply_invalid")
    observed = reply["job"]
    require(observed is None or isinstance(observed, str) and observed.strip(), "operator_job_invalid")
    require(job is None or observed == job, "operator_job_changed")
    require(reply["status"] not in {"queued", "running"} or observed is not None, "operator_job_required")
    require(isinstance(reply["evidence"], dict) and reply["evidence"], "operator_provider_evidence_required")


def route_for(config, request):
    incoming = parse(pinned(request["action"]["incoming_checkpoint"]))["next_action"]
    path_ids = driver.strings(incoming["path_ids"])
    require(path_ids and all(p in config.data["routes"] for p in path_ids), "operator_action_not_routed")
    routes = [config.data["routes"][p] for p in path_ids]
    require(len({(r["adapter"], r["completion"]) for r in routes}) == 1
            and all(incoming["kind"] in r["kinds"] for r in routes), "operator_action_not_routed")
    authority = driver.authority_inputs(config.driver)
    catalog = {r["id"]: r for r in authority["context"]["paths"]}
    require(all(authority["handoff"]["fields"].get("permissions." + permission) == "granted"
                for p in path_ids for permission in catalog[p]["permissions"]),
            "operator_operation_not_authorized")
    return incoming, routes[0]


def executor_state(config, refs):
    request = handoff.load_request(config.driver, refs["request"])
    saved = read_json(Path(refs["request"]["path"]).with_name("executor.json"))
    key = digest(canonical({"driver": config.driver.sha256, "action": request["action"]["action_sha256"]}))
    require(set(saved) == {"config", "request", "acceptance", "phase", "operation_key", "job",
                         "unknown_polls", "sequence", "report", "outcome", "reservation"}
            and saved["config"] == config.ref and saved["request"] == refs["request"]
            and saved["operation_key"] == key and saved["phase"] in
            {"claiming", "ready", "executing", "waiting", "returning", "done", "stopped", "background_stopped"},
            "operator_state_changed")
    require(all(type(saved[k]) is int and saved[k] >= 0 for k in ("sequence", "unknown_polls"))
            and (saved["job"] is None or isinstance(saved["job"], str) and saved["job"]),
            "operator_state_changed")
    reservation = saved["reservation"]
    require(reservation is None or isinstance(reservation, dict) and set(reservation) ==
            {"tokens", "cost_micro_usd", "training_slots"} and all(type(v) is int and v >= 0
                for v in reservation.values()) and reservation["training_slots"] <= 1,
            "operator_reservation_changed")
    return saved


def background_jobs(config, journal):
    for key, refs, report in background.submitted(config.driver, journal["operator_requests"]):
        job = journal["background_jobs"].get(key, background.entry(refs))
        yield refs, report, job, background.observe(config.driver, job)


def reservations(config, journal):
    result = []
    for refs, _, _, view in background_jobs(config, journal):
        if view["status"] in background.TERMINAL and not view["unreviewed"]:
            continue
        target = Path(refs["request"]["path"]).with_name("executor.json")
        saved = executor_state(config, refs) if os.path.lexists(target) else None
        result.append(dict(view, reservation=saved["reservation"] if saved else None))
    return result


def poll_background(config, journal, call):
    """Query every owned historical submission once; never execute or mutate driver state.

    Safe during a pending model turn: only immutable submission/config/authority pins
    and the live native fence are used, not the model's changing session log.
    """
    polled = False
    d = config.driver
    for refs, report, job, view in background_jobs(config, journal):
        target = Path(refs["request"]["path"]).with_name("executor.json")
        if not os.path.lexists(target):
            continue  # A manual submission is not adoption by this executor.
        saved = executor_state(config, refs)
        require(saved["acceptance"] == refs["acceptance"] and saved["job"] == view["job"]
                and saved["report"] == parse(pinned(refs["result"]))["report"], "operator_submission_changed")
        if view["status"] in background.TERMINAL or saved["phase"] == "background_stopped":
            continue
        require(saved["phase"] in {"returning", "done"}, "operator_background_phase_invalid")
        request = handoff.load_request(d, refs["request"])
        incoming, route = route_for(config, request)
        require(route["completion"] == "background", "operator_background_route_changed")
        config.revalidate()
        driver.observe_binding(d)
        _, latest, _ = current(config, active=False)
        require(latest["outcome"] is None and not os.path.lexists(d.root / "STOP"), "operator_driver_not_active")
        require(latest["operator_requests"].get(request["action"]["action_sha256"], {}).get("request")
                == refs["request"], "operator_request_changed")
        saved["sequence"] += 1
        replace_json(target, saved)  # Reserve an immutable evidence name before query.
        deadline = config.data["budget"]["deadline_at"]
        expired = deadline is not None and timestamp(now()) >= timestamp(deadline)
        exhausted = saved["unknown_polls"] >= config.data["max_unknown_polls"]
        payload = {"schema_version": 1, "operation_key": view["operation_key"], "binding": d.data["binding"],
                   "action": incoming, "authority": d.data["authority"], "budget": config.data["budget"],
                   "job": view["job"], "method": "query"}
        try:
            if expired or exhausted:
                reply = dict(operation_key=view["operation_key"], job=view["job"], status="unknown",
                             evidence={"reason": "operator_deadline_exhausted" if expired else
                                       "background_reconciliation_exhausted"})
            else:
                reply = call(config.data["adapters"][route["adapter"]], payload, cwd=str(d.cwd),
                             timeout=config.data["rpc_timeout_seconds"])
            validate_reply(reply, view["operation_key"], view["job"])
            require(reply["status"] != "not_executed", "operator_submitted_job_not_executed")
        except subprocess.TimeoutExpired:
            reply = dict(operation_key=view["operation_key"], job=view["job"], status="unknown",
                         evidence={"reason": "operator_query_timeout"})
        proof = config.evidence / ("operator-" + view["operation_key"] + "-%06d.json" % saved["sequence"])
        publish_new(proof, {"method": "query", "reply": reply})
        saved["unknown_polls"] = saved["unknown_polls"] + 1 if reply["status"] == "unknown" else 0
        # Persist the retry counter before head publication. A crash can consume a
        # retry, never grant another execute or reset the bound.
        saved["phase"] = "done"
        replace_json(target, saved)
        background.publish(d, job, reply["status"], [file_ref(proof)])
        if expired or saved["unknown_polls"] >= config.data["max_unknown_polls"]:
            saved.update(phase="background_stopped", outcome="background_reconciliation_exhausted")
            replace_json(target, saved)
        polled = True
    return polled


def tick(config, *, call=invoke):
    """One bounded observation/action; caller owns operator.lock, never driver.lock."""
    config.revalidate()
    d = config.driver
    require(config.data["enabled"] and d.data["enabled"], "operator_disabled")
    if os.path.lexists(d.root / "operator-stop.json"):
        return "operator_stopped"
    _, journal, request_ref = current(config, active=False)
    if journal["outcome"] is not None or os.path.lexists(d.root / "STOP"):
        return "driver_stopped"
    polled = poll_background(config, journal, call)
    if journal["pending"] is not None or request_ref is None:
        return "background_polled" if polled else "idle"
    request = handoff.load_request(d, request_ref)
    action = request["action"]
    entry = journal["operator_requests"][action["action_sha256"]]
    status, refs, _ = handoff.observe(d, entry)
    if status in {"operator_result_ready", "operator_outcome_unknown_requires_reconciliation"}:
        return status
    incoming, route = route_for(config, request)
    adapter = config.data["adapters"][route["adapter"]]
    directory = Path(request_ref["path"]).parent
    target = directory / "executor.json"
    key = digest(canonical({"driver": d.sha256, "action": action["action_sha256"]}))
    if not os.path.lexists(target):
        require(refs["acceptance"] is None, "operator_claim_owned_elsewhere")
        saved = {"config": config.ref, "request": request_ref, "acceptance": None,
                 "phase": "claiming", "operation_key": key, "job": None, "unknown_polls": 0,
                 "sequence": 0, "report": None, "outcome": None, "reservation": None}
        publish_new(target, saved)
    saved = executor_state(config, refs)
    if saved["phase"] == "stopped":
        return "operator_stopped"
    if saved["phase"] == "claiming":
        require(refs["acceptance"] is None, "operator_claim_recovery_required")
        args = SimpleNamespace(handoff_status=False, accept_handoff=request_ref["sha256"],
                               operator_id=config.actor, confirm_skill_read=True)
        _, result = driver.operator_command(d, args)
        saved.update(acceptance=result["acceptance"], phase="ready")
        replace_json(target, saved)
    require(saved["acceptance"] is not None
            and saved["acceptance"] == handoff.observe(d, entry)[1]["acceptance"], "operator_acceptance_changed")
    require(saved["phase"] != "waiting" or saved["job"] is not None, "operator_job_required")

    def finish(outcome, evidence, submission=None):
        report = {"status": outcome, "evidence": [evidence]}
        if submission is not None:
            report["background"] = {k: submission[k] for k in ("operation_key", "job", "status")}
        report_file = directory / "executor-report.json"
        if os.path.lexists(report_file):
            require(read_json(report_file) == report, "operator_report_changed")
        else:
            publish_new(report_file, report)
        saved.update(phase="returning", report=file_ref(report_file))
        replace_json(target, saved)

    def evidence(value):
        # Immutable provider observations, distinct from the control journal.
        name = "operator-" + key + "-%06d.json" % saved["sequence"]
        out = config.evidence / name
        require(not os.path.lexists(out), "operator_evidence_recovery_required")
        publish_new(out, value)
        return file_ref(out)

    # Publishing a report and updating the snapshot are separate atomic writes.
    # A restart in that gap returns the already published report, without querying
    # or submitting again (and without selecting different evidence).
    report_file = directory / "executor-report.json"
    if os.path.lexists(report_file):
        report_ref = file_ref(report_file)
        report = handoff.validate_report(d, parse(pinned(report_ref)))
        require(saved["report"] in (None, report_ref), "operator_report_changed")
        if report["status"] == "submitted":
            submission = report["background"]
            require(submission["operation_key"] == key and saved["job"] in (None, submission["job"]),
                    "operator_submission_changed")
            saved["job"] = submission["job"]
        saved.update(phase="returning", report=report_ref)
        replace_json(target, saved)
    require(saved["phase"] != "returning" or saved["report"] is not None,
            "operator_report_missing")
    if saved["phase"] == "returning":
        handoff.return_result(d, entry, config.actor, saved["acceptance"]["sha256"], saved["report"])
        saved["phase"] = "done"
        replace_json(target, saved)
        return handoff.observe(d, entry)[0]
    require(saved["phase"] != "done", "operator_result_disappeared")
    # Use the same authority and identity gate for later polling/recovery, not only the claim.
    driver.current_evidence(d, journal["current"])
    driver.observe_binding(d)
    # The driver may record the acceptance without changing the current action.
    _, live, live_request = current(config)
    require(live_request == request_ref and live["current"]["checkpoint"] == journal["current"]["checkpoint"],
            "operator_request_changed")
    payload = {"schema_version": 1, "operation_key": key, "binding": d.data["binding"],
               "action": incoming, "authority": d.data["authority"], "budget": config.data["budget"],
               "job": saved["job"], "method": None}

    def admit(probe, state):
        return admission(config, probe, outstanding=reservations(config, state), path_ids=incoming["path_ids"])

    def rpc(method):
        config.revalidate()
        _, latest, selected = current(config)
        require(selected == request_ref and latest["current"]["checkpoint"] == journal["current"]["checkpoint"],
                "operator_request_changed")
        if method == "execute":
            deadline = config.data["budget"]["deadline_at"]
            require(deadline is None or timestamp(now()) < timestamp(deadline), "operator_deadline_exhausted")
            require(admit(probe, latest) is None, "operator_admission_changed")
        return call(adapter, dict(payload, method=method), cwd=str(d.cwd),
                    timeout=config.data["rpc_timeout_seconds"])

    try:
        deadline = config.data["budget"]["deadline_at"]
        saved["sequence"] += 1
        replace_json(target, saved)  # Reserve evidence name before any provider call.
        if deadline is not None and timestamp(now()) >= timestamp(deadline):
            finish("not_executed" if saved["phase"] == "ready" else "unknown",
                   evidence({"reason": "operator_deadline_exhausted", "job": saved["job"]}))
        else:
            if saved["phase"] == "ready" and incoming["kind"] == "wait":
                saved["phase"] = "executing"
                replace_json(target, saved)
                method = "query"  # Waiting never submits work, even on the first tick.
            elif saved["phase"] == "ready":
                probe = rpc("probe")
                refusal = admit(probe, journal)
                proof = evidence({"method": "probe", "observation": probe, "refusal": refusal})
                if refusal:
                    finish("not_executed", proof)
                else:
                    saved.update(phase="executing", sequence=saved["sequence"] + 1,
                                 reservation=dict(probe["estimate"], training_slots=probe["training_slots"]))
                    replace_json(target, saved)  # Never execute again after this durable intent.
                    method = "execute"
            else:
                method = "query"
            if saved["phase"] != "returning":
                reply = rpc(method)
                validate_reply(reply, key, saved["job"])
                proof = evidence({"method": method, "reply": reply})
                saved["job"] = reply["job"]
                if reply["status"] in {"queued", "running"}:
                    if route["completion"] == "background":
                        finish("submitted", proof, reply)
                    else:
                        saved.update(phase="waiting", unknown_polls=0)
                elif reply["status"] == "unknown":
                    saved["unknown_polls"] += 1
                    if saved["unknown_polls"] >= config.data["max_unknown_polls"]:
                        finish("unknown", proof)
                    else:
                        saved["phase"] = "executing"  # Only query from here, never replay.
                else:
                    finish({"succeeded": "executed", "failed": "failed", "not_executed": "not_executed"}[reply["status"]], proof)
        replace_json(target, saved)
    except subprocess.TimeoutExpired:
        # A timed-out execute may have created a Job. Preserve intent and query on restart.
        if saved["phase"] == "ready":
            saved.update(phase="stopped", outcome="operator_probe_timeout")
        else:
            saved["unknown_polls"] += 1
            if saved["unknown_polls"] >= config.data["max_unknown_polls"]:
                finish("unknown", evidence({"reason": "operator_reconciliation_exhausted",
                                            "job": saved["job"]}))
            else:
                saved["phase"] = "executing"
        replace_json(target, saved)
    except Exception:
        saved.update(phase="stopped", outcome="operator_adapter_or_validation_failed")
        replace_json(target, saved)
        raise
    return "operator_stopped" if saved["phase"] == "stopped" else saved["phase"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-skill-read", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    config = Config(args.config, args.config_sha256)
    if not args.execute:
        print("operator_inputs_validated_no_execution")
        return 0
    require(args.confirm_skill_read, "operator_skill_read_confirmation_required")
    require(config.data["enabled"] and config.driver.data["enabled"], "operator_disabled")
    with locked(config):
        while True:
            try:
                status = tick(config)
            except Exception as exc:
                # Persist all native/permission/adapter failures; restart is not permission to retry.
                latch = config.driver.root / "operator-stop.json"
                if not os.path.lexists(latch):
                    publish_new(latch, {"at": now(), "reason": type(exc).__name__})
                print("operator_stopped_inspect_private_evidence", flush=True)
                return 2
            print(status, flush=True)
            if status in {"operator_stopped", "driver_stopped", "operator_outcome_unknown_requires_reconciliation"}:
                return 2
            if args.once:
                return 0
            time.sleep(config.data["poll_seconds"])


if __name__ == "__main__":
    raise SystemExit(main())
