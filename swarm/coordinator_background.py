"""Immutable background observations; only the driver updates/consumes its journal.

The Operator owns the append-only observation chain and its atomic head pointer.
Submission, provider termination and business acceptance are distinct facts. This
module never submits work, resumes a model, or infers free resources from silence.
"""

import os
from pathlib import Path

import coordinator_handoff as handoff
from coordinator_io import (canonical, digest, file_ref, now, parse, pinned, publish_new,
                            read_json, replace_json, require, scoped_refs, timestamp, validate_ref)

TERMINAL = {"succeeded", "failed"}
STATUSES = {"queued", "running", "unknown", *TERMINAL}


def validate_jobs(jobs, history):
    require(isinstance(jobs, dict), "invalid_background_history")
    for key, job in jobs.items():
        require(key in history and isinstance(job, dict) and set(job) ==
                {"request", "acceptance", "result", "latest", "consumed"}
                and all(job[k] == history[key][k] and job[k] is not None
                        for k in ("request", "acceptance", "result")), "invalid_background_history")
        for field in ("latest", "consumed"):
            ref = job[field]
            if ref is not None:
                validate_ref(ref)
                require(ref == job["result"] and field == "consumed" or
                        ref["path"] == str(Path(job["request"]["path"]).with_name(
                            "background-" + ref["sha256"] + ".json")), "background_cursor_mismatch")


def submitted(config, history):
    for key, entry in history.items():
        _, refs, report = handoff.observe(config, entry)
        if report is not None and report["status"] == "submitted":
            yield key, refs, report


def observe(config, job, *, refresh=True):
    """Validate the whole hash chain, including the previously journaled frontier."""
    _, refs, report = handoff.observe(config, job_subset(job))
    require(report is not None and report["status"] == "submitted", "background_submission_missing")
    request = handoff.load_request(config, refs["request"])
    initial = report["background"]
    directory = Path(refs["request"]["path"]).parent
    head = directory / "background-head.json"
    latest = job["latest"]
    if refresh:
        if os.path.lexists(head):
            pointer = read_json(head)
            require(set(pointer) == {"event"}, "invalid_background_head")
            latest = pointer["event"]
        else:
            require(latest is None, "background_history_disappeared")
    chain, seen, cursor = [], set(), latest
    while cursor is not None:
        validate_ref(cursor)
        require(cursor["sha256"] not in seen and cursor["path"] == str(directory /
                ("background-" + cursor["sha256"] + ".json")), "background_chain_invalid")
        seen.add(cursor["sha256"])
        event = parse(pinned(cursor))
        require(isinstance(event, dict) and set(event) == {"schema_version", "request", "result",
                "operation_key", "job", "sequence", "previous", "observed_at", "status", "evidence"}
                and type(event["schema_version"]) is int and event["schema_version"] == 1
                and event["request"] == refs["request"] and event["result"] == refs["result"]
                and event["operation_key"] == initial["operation_key"] and event["job"] == initial["job"]
                and type(event["sequence"]) is int and event["sequence"] > 0
                and event["status"] in STATUSES, "background_event_invalid")
        require(timestamp(event["observed_at"]) <= timestamp(now()), "background_event_time_invalid")
        require(event["evidence"], "background_evidence_required")
        scoped_refs(event["evidence"], config.progress_roots, config.excluded_evidence)
        chain.append((cursor, event))
        cursor = event["previous"]
    chain.reverse()
    status, evidence, previous_time = initial["status"], report["evidence"], timestamp(
        parse(pinned(refs["result"]))["reported_at"])
    cursors = [refs["result"]]
    for index, (ref, event) in enumerate(chain, 1):
        require(event["sequence"] == index and status not in TERMINAL and event["status"] != status
                and not (status == "running" and event["status"] == "queued")
                and timestamp(event["observed_at"]) >= previous_time, "background_transition_invalid")
        status, evidence, previous_time = event["status"], event["evidence"], timestamp(event["observed_at"])
        cursors.append(ref)
    require(job["latest"] is None or job["latest"] in cursors, "background_history_rollback")
    require(job["consumed"] is None or job["consumed"] in cursors, "background_consumption_rollback")
    incoming = parse(pinned(request["action"]["incoming_checkpoint"]))
    path_ids = incoming["next_action"]["path_ids"]
    return {"operation_key": initial["operation_key"], "job": initial["job"], "status": status,
            "path_ids": path_ids, "requirements": sorted({p["requirement_id"] for p in incoming["paths"]
                                                          if p["id"] in path_ids}),
            "latest": latest, "cursor": latest or refs["result"], "sequence": len(chain),
            "evidence": evidence, "unreviewed": job["consumed"] != (latest or refs["result"])}


def job_subset(job):
    return {k: job[k] for k in ("request", "acceptance", "result")}


def entry(refs):
    return dict(refs, latest=None, consumed=None)


def publish(config, job, status, evidence):
    """Operator-lock only. Identical status polls never create new model events."""
    observed = observe(config, job)
    require(status in STATUSES, "background_status_invalid")
    if status == observed["status"]:
        return observed["latest"]
    require(observed["status"] not in TERMINAL and
            not (observed["status"] == "running" and status == "queued"), "background_transition_invalid")
    require(evidence, "background_evidence_required")
    scoped_refs(evidence, config.progress_roots, config.excluded_evidence)
    event = {"schema_version": 1, "request": job["request"], "result": job["result"],
             "operation_key": observed["operation_key"], "job": observed["job"],
             "sequence": observed["sequence"] + 1, "previous": observed["latest"],
             "observed_at": now(), "status": status, "evidence": evidence}
    directory = Path(job["request"]["path"]).parent
    target = directory / ("background-" + digest(canonical(event) + b"\n") + ".json")
    publish_new(target, event)
    ref = file_ref(target)
    # A crash before head publication leaves harmless, unreferenced read-only
    # evidence. After publication the next poll recovers from the same chain.
    replace_json(directory / "background-head.json", {"event": ref})
    return ref


def collect(config, journal):
    """Driver-lock only, at a safe turn boundary. Never during a pending turn."""
    require(journal.data["pending"] is None, "background_collection_during_turn")
    changed = False
    for key, refs, _ in submitted(config, journal.data["operator_requests"]):
        history = journal.data["operator_requests"][key]
        if history != refs:
            history.update(refs)
            changed = True
        jobs = journal.data["background_jobs"]
        if key not in jobs:
            jobs[key] = entry(refs)
            changed = True
        job = jobs[key]
        observed = observe(config, job)
        if job["latest"] != observed["latest"]:
            job["latest"] = observed["latest"]
            changed = True
    if changed:
        journal.save()
        journal.event("background_observed", cursors=events(config, journal.data))


def views(config, state):
    return {key: observe(config, job, refresh=False) for key, job in state["background_jobs"].items()}


def events(config, state):
    return {key: view["cursor"] for key, view in views(config, state).items() if view["unreviewed"]}


def guard(checkpoint, jobs, reviewed):
    """A live/unknown Job cannot disappear, satisfy its requirement or free a slot."""
    paths = {p["id"]: p for p in checkpoint["paths"]}
    met = {r["id"] for r in checkpoint["requirements"] if r["status"] == "met"}
    for key, job in jobs.items():
        if job["status"] not in TERMINAL:
            require(checkpoint["decision"] != "complete" and all(p in paths for p in job["path_ids"])
                    and not met.intersection(job["requirements"]), "active_background_job_not_preserved")
        if checkpoint["decision"] == "complete":
            require(not job["unreviewed"] or reviewed.get(key) == job["cursor"],
                    "background_result_not_reviewed")
