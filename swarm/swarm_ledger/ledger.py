"""Durable accounting only: never writes native lifecycle or budget state."""

import copy
from contextlib import nullcontext
from datetime import datetime, timezone
import math

from supervisor.config import digest, exact_id, require
from supervisor.store import Store
from . import raw_usage

TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens",
                "cache_write_tokens", "reasoning_tokens")


def timestamp(value, *, native=False):
    if value is None:
        return None
    require(isinstance(value, str), "timestamp must be ISO-8601 text")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        # Orca 1.4.219 SQLite datetime('now') is UTC, not collector local time.
        require(native, "explicit timezone required")
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def seconds(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def elapsed(start, end):
    if start is None or end is None:
        return None
    result = seconds(end) - seconds(start)
    require(math.isfinite(result) and result >= 0, "end precedes start")
    return round(result, 3)


def text_id(value):
    require(exact_id(value) and len(value) <= 1024, "missing/invalid accounting identifier")
    return value


def optional_object(value):
    require(value is None or isinstance(value, dict), "invalid native optional object")
    return value or {}


def token_counts(raw):
    require(isinstance(raw, dict), "tokens must be an object")
    result = {k: raw.get(k) for k in TOKEN_FIELDS}
    require(all(v is None or type(v) is int and v >= 0 for v in result.values()),
            "tokens must be nonnegative integers or null")
    inp, out = result["input_tokens"], result["output_tokens"]
    cache = [result[k] for k in ("cache_read_tokens", "cache_write_tokens")]
    require(inp is None or sum(x or 0 for x in cache) <= inp,
            "input_tokens includes cache read/write; cache exceeds input")
    require(out is None or (result["reasoning_tokens"] or 0) <= out,
            "reasoning_tokens is a subset of output_tokens")
    result["total_tokens"] = inp + out if inp is not None and out is not None else None
    require("total_tokens" not in raw or
            (raw["total_tokens"] is None or type(raw["total_tokens"]) is int) and raw["total_tokens"] == result["total_tokens"],
            "total_tokens must equal input_tokens + output_tokens")
    return result


def trae_provenance(sample):
    raw = sample.get("trae_provenance")
    require(isinstance(raw, dict), "Trae producer provenance required")
    provenance = {k: text_id(raw[k]) for k in ("thread_id", "session_tree_id", "binding_source", "counter_semantics", "thread_cli_version")}
    provenance["semantics_source"] = text_id(raw["semantics_source"]) if raw.get("semantics_source") else None
    require(provenance["thread_id"] == sample["session_id"], "Trae provenance identity mismatch")
    return provenance


def turn_measurements(sample, begin, end):
    """Optional provider turn timings, separate from native lifecycle durations."""
    if "turns" not in sample:
        return {}
    require(sample["provider"] == "trae" and isinstance(sample["turns"], list), "invalid turn measurements")
    require(type(sample.get("turn_timing_complete")) is bool, "turn timing completeness required")
    turns, ids = [], set()
    for raw in sample["turns"]:
        require(isinstance(raw, dict), "invalid turn measurement")
        tid, thread = text_id(raw["id"]), text_id(raw["thread_id"])
        require(thread == sample["session_id"] and tid not in ids, "turn identity mismatch/duplicate")
        ids.add(tid)
        start, finish = timestamp(raw.get("started_at")), timestamp(raw.get("ended_at"))
        elapsed(start, finish)
        require(not start or seconds(start) >= seconds(begin), "turn begins before sample window")
        require(not finish or seconds(finish) <= seconds(end), "turn ends after sample window")
        duration = raw.get("duration_ms")
        require(duration is None or type(duration) is int and duration >= 0, "invalid turn duration")
        require(raw.get("status") in ("completed", "failed", "interrupted", "inProgress"), "invalid turn status")
        if sample["turn_timing_complete"]:
            require(start and finish and duration is not None and raw["status"] != "inProgress", "incomplete turn timing")
        turns.append({"thread_id": thread, "id": tid, "started_at": start, "ended_at": finish,
                      "duration_ms": duration, "status": raw["status"]})
    warnings = sample.get("turn_timing_warnings", [])
    require(isinstance(warnings, list) and all(exact_id(w) for w in warnings), "invalid turn warning codes")
    require(not sample["turn_timing_complete"] or bool(turns) and not warnings, "incomplete turn timing")
    return {"turns": turns, "turn_timing_complete": sample["turn_timing_complete"],
            "turn_timing_warnings": warnings, "trae_provenance": trae_provenance(sample)}


def raw_measurements(sample):
    """Whitelist independently labeled raw evidence, including on usage-import."""
    if "raw_usage" not in sample:
        return {}
    from .trae_jsonl import binding, prefix
    raw = sample["raw_usage"]
    require(isinstance(raw, dict) and sample["provider"] == "trae" and
            raw.get("contract") in raw_usage.TRAE_JSONL_CONTRACTS.values() and raw.get("counter_semantics") == "unverified",
            "unsupported raw usage contract")
    provenance = trae_provenance(sample)
    require(raw["contract"] == raw_usage.trae_jsonl_contract(provenance.get("thread_cli_version")),
            "raw usage producer/contract mismatch")
    require(not sample["complete"] and "counter_semantics_unverified" in sample.get("warnings", []) and
            all(v is None for v in token_counts(sample["tokens"]).values()),
            "unverified raw usage cannot supply normalized tokens")
    bound = binding(raw["binding"])
    require(bound["thread_id"] == sample["session_id"], "raw thread identity mismatch")
    capture = prefix(raw["capture"])
    require(capture["bytes"] >= bound["verified_prefix"]["bytes"], "raw capture precedes verified prefix")
    for key, value in (("stable", raw["capture"].get("stable")),
                       ("task_complete_observed", raw.get("task_complete_observed"))):
        require(type(value) is bool, "invalid raw observation flag")
    capture["stable"] = raw["capture"]["stable"]
    require(sample["source"] == "trae-jsonl:sha256:" + capture["sha256"], "raw source digest mismatch")
    rows = raw_usage.requests(raw["requests"])
    sums = raw_usage.totals(rows)
    require(all(raw_usage.counts(raw[k]) == sums[k] for k in sums), "raw subtotal mismatch")
    return {"trae_provenance": provenance,
            "raw_usage": {"contract": raw["contract"], "counter_semantics": "unverified",
                          "binding": bound, "capture": capture, "requests": rows, **sums,
                          "task_complete_observed": raw["task_complete_observed"]}}


class Ledger:
    def __init__(self, root, **kwargs):
        # Reuse private SQLite, locking and crash-safe transaction infrastructure.
        # Use a dedicated root, separate from any Supervisor budget database.
        self.store = Store(root, **kwargs)

    def close(self):
        self.store.close()

    def transaction(self):
        # A CLI sync plus all bound usage samples commits as one unit.
        return nullcontext() if self.store.db.in_transaction else self.store.transaction()

    def now(self):
        return datetime.fromtimestamp(self.store.clock(), timezone.utc).isoformat().replace("+00:00", "Z")

    @staticmethod
    def key(runtime, run):
        return "ledger:" + digest([text_id(runtime), text_id(run)])

    def get(self, runtime, run):
        data = self.store.get(self.key(runtime, run))
        require(data is not None, "Run not enrolled; sync first")
        return data

    def save(self, data):
        self.store.put(self.key(data["runtime_id"], data["run_id"]), data)

    def sync(self, runtime, run, workers, *, binding_agent_ids=None):
        """One complete read-only inventory; failures leave previous snapshot intact."""
        rid = text_id(run["id"])
        start = timestamp(run.get("created_at"), native=True)
        require(start is not None and not run.get("legacy"), "missing start or legacy Run")
        rows = {}
        for receipt in workers:
            dispatch, worker = receipt["dispatch"], receipt["worker"]
            aid = text_id(dispatch["id"])
            require(dispatch.get("runId") == rid and worker.get("dispatchId") == aid,
                    "foreign worker receipt")
            require(aid not in rows, "duplicate Dispatch")
            options = optional_object(worker.get("startOptions"))
            launch = optional_object(optional_object(options.get("launch")).get("effective"))
            terminal = optional_object(receipt.get("terminal")).get("handle")
            resource_terminal = optional_object(receipt.get("terminalResource")).get("terminalHandle")
            require(not terminal or not resource_terminal or terminal == resource_terminal,
                    "native terminal identity conflict")
            terminal = terminal or resource_terminal
            row = {
                "agent_id": aid, "role": "worker", "task_id": text_id(dispatch["taskId"]),
                "retry_of": dispatch.get("retryOfDispatchId"),
                "provider": launch.get("agent"), "model": launch.get("model"),
                "effort": launch.get("effort"), "status": worker.get("state", "unknown"),
                "dispatch_status": dispatch.get("status", "unknown"),
                "host": dispatch.get("hostScope"),
                "terminal_handle": text_id(terminal) if terminal is not None else None,
                "started_at": timestamp(dispatch.get("dispatchedAt"), native=True),
                "ended_at": timestamp(dispatch.get("completedAt"), native=True),
                "released_at": timestamp(optional_object(receipt.get("terminalResource")).get("releaseCompletedAt"), native=True),
                "time_source": "orca:dispatch.dispatchedAt/completedAt (includes waits/tools)",
                "samples": {}, "usage_complete_source": None,
            }
            elapsed(row["started_at"], row["ended_at"])
            rows[aid] = row
        with self.transaction():
            old = self.store.get(self.key(runtime, rid))
            if old:
                require(old["started_at"] == start, "Run start changed")
                require(set(old["agents"]) - {"coordinator"} <= set(rows), "fleet lost a known Dispatch")
                for aid, row in rows.items():
                    prior = old["agents"].get(aid)
                    if prior:
                        require(prior["task_id"] == row["task_id"], "Dispatch task changed")
                        require(prior.get("host") == row.get("host"), "Dispatch host changed")
                        require(not prior.get("terminal_handle") or not row["terminal_handle"] or
                                prior["terminal_handle"] == row["terminal_handle"], "Dispatch terminal changed")
                        row["terminal_handle"] = row["terminal_handle"] or prior.get("terminal_handle")
                        require(row["provider"] is None or all(s["provider"] == row["provider"] for s in prior["samples"].values()),
                                "native provider conflicts with usage")
                        for field in ("started_at", "ended_at"):
                            require(prior[field] is None or prior[field] == row[field], "Dispatch time regressed/changed")
                        row["samples"] = prior["samples"]
                        row["usage_complete_source"] = prior["usage_complete_source"]
                if old["ended_at"]:
                    require(set(old["agents"]) - {"coordinator"} == set(rows), "closed Run gained Dispatches")
                    require(all(r["ended_at"] and seconds(r["ended_at"]) <= seconds(old["ended_at"])
                                for r in rows.values()), "closed Run has unfinished/later work")
            coordinator = old["agents"]["coordinator"] if old else {
                "agent_id": "coordinator", "role": "coordinator", "task_id": None,
                "provider": None, "model": None, "effort": None, "status": "unknown",
                "started_at": None, "ended_at": None, "released_at": None,
                "time_source": None, "samples": {}, "usage_complete_source": None,
            }
            data = old or {"schema_version": 1, "runtime_id": runtime, "run_id": rid,
                           "started_at": start, "ended_at": None, "end_source": None, "outcome": "unknown"}
            data.update(agents={"coordinator": coordinator, **rows}, observed_at=self.now(),
                        coordinator_handle=run.get("coordinator_handle"))
            # Native inventory alone cannot discover safe usage bindings. Record
            # this checkpoint's explicit coverage, even if old samples exist.
            data.pop("usage_binding_coverage", None)
            if binding_agent_ids is not None:
                configured = {text_id(aid) for aid in binding_agent_ids}
                require(configured <= set(data["agents"]), "usage binding targets unknown Agent")
                required = {aid for aid, row in rows.items() if not row["usage_complete_source"]}
                missing = sorted(required - configured)
                data["usage_binding_coverage"] = {
                    "observed_at": data["observed_at"],
                    "configured_agent_ids": sorted(configured),
                    "required_worker_ids": sorted(required), "missing_worker_ids": missing,
                    "warnings": ["worker_usage_bindings_missing"] if missing else [],
                }
            self.save(data)
        return self.report(runtime, rid)

    def coordinator(self, runtime, run, *, started_at, ended_at, source, provider=None, model=None):
        start, end = timestamp(started_at), timestamp(ended_at)
        require(start is not None, "Coordinator start required")
        elapsed(start, end)
        with self.transaction():
            data = self.get(runtime, run)
            row = data["agents"]["coordinator"]
            provider = provider or row["provider"]
            model = model or row["model"]
            require(not provider or all(s["provider"] == provider for s in row["samples"].values()),
                    "Coordinator provider conflicts with usage")
            for field, value in (("started_at", start), ("ended_at", end)):
                require(row[field] is None or row[field] == value, "Coordinator time conflict")
            require(not data["ended_at"] or not end or seconds(end) <= seconds(data["ended_at"]),
                    "Coordinator ends after closed Run")
            row.update(started_at=start, ended_at=end, time_source=text_id(source),
                       provider=provider, model=model, status="completed" if end else "observed")
            self.save(data)

    def finish(self, runtime, run, *, ended_at, outcome, source):
        end = timestamp(ended_at)
        require(end is not None and outcome in ("succeeded", "failed", "cancelled"), "explicit Run outcome/end required")
        with self.transaction():
            data = self.get(runtime, run)
            elapsed(data["started_at"], end)
            require(seconds(end) <= seconds(self.now()), "Run end cannot be in the future")
            for row in data["agents"].values():
                if row["role"] == "worker" or row["started_at"]:
                    require(row["ended_at"] is not None, "unfinished/unknown Agent; do not close accounting")
                require(not row["ended_at"] or seconds(row["ended_at"]) <= seconds(end), "Run ends before Agent")
            require(data["ended_at"] is None or (data["ended_at"], data["outcome"], data["end_source"])
                    == (end, outcome, source), "conflicting Run closure")
            data.update(ended_at=end, outcome=outcome, end_source=text_id(source))
            self.save(data)

    def usage(self, runtime, run, agent, sample, *, final=False):
        """Upsert an absolute window subtotal, never add repeated imports to it."""
        provider, session = text_id(sample["provider"]), text_id(sample["session_id"])
        begin, end = timestamp(sample["since"]), timestamp(sample["until"])
        require(begin is not None and end is not None, "bounded usage window required")
        elapsed(begin, end)
        require(seconds(begin) < seconds(end), "usage window must be nonempty")
        require(type(sample.get("complete")) is bool, "sample.complete must be boolean")
        clean = {"provider": provider, "session_id": session, "since": begin, "until": end,
                 "tokens": token_counts(sample["tokens"]), "source": text_id(sample["source"]),
                 "complete": sample["complete"], "warnings": sample.get("warnings", [])}
        clean.update(turn_measurements(sample, begin, end))
        clean.update(raw_measurements(sample))
        require(isinstance(clean["warnings"], list) and all(exact_id(x) for x in clean["warnings"]), "invalid warning codes")
        skey = digest([provider, session, begin])
        with self.transaction():
            data = self.get(runtime, run)
            require(agent in data["agents"], "unknown Agent/Dispatch")
            row = data["agents"][agent]
            if "raw_usage" in clean:
                from .trae_jsonl import check_scope
                check_scope(self, runtime, run, agent, clean["raw_usage"]["binding"])
            require(row.get("provider") in (None, provider), "usage provider does not match Agent")
            require(all(s["provider"] == provider for s in row["samples"].values()),
                    "usage provider conflicts with existing samples")
            old = row["samples"].get(skey)
            if row["usage_complete_source"]:
                require(old == clean, "finalized usage cannot change")
            if old:
                require(seconds(end) >= seconds(old["until"]), "usage window regressed")
                for field, value in old["tokens"].items():
                    require(value is None or clean["tokens"][field] is not None and clean["tokens"][field] >= value,
                            "usage subtotal regressed")
                if "raw_usage" in old:
                    previous_raw, incoming_raw = old["raw_usage"], clean.get("raw_usage")
                    require(incoming_raw is not None and previous_raw["binding"] == incoming_raw["binding"],
                            "raw usage binding changed or removed")
                    require(previous_raw["contract"] == incoming_raw["contract"], "raw usage contract changed")
                    old_capture, new_capture = previous_raw["capture"], incoming_raw["capture"]
                    require(new_capture["bytes"] >= old_capture["bytes"], "raw capture regressed")
                    require(new_capture["bytes"] != old_capture["bytes"] or
                            new_capture["sha256"] == old_capture["sha256"], "raw capture changed")
                    incoming_requests = {r["id"]: r for r in incoming_raw["requests"]}
                    require(all(incoming_requests.get(r["id"]) == r for r in previous_raw["requests"]),
                            "raw request history regressed or changed")
                previous_turns = {t["id"]: t for t in old.get("turns", [])}
                incoming_turns = {t["id"]: t for t in clean.get("turns", [])}
                for tid, prior in previous_turns.items():
                    require(tid in incoming_turns, "turn history regressed")
                    for field in ("started_at", "ended_at", "duration_ms"):
                        require(prior[field] is None or incoming_turns[tid][field] == prior[field], "turn timing changed")
            # One provider session/window cannot be counted for two actors or Runs.
            for other in self.store.entries("ledger:").values():
                if other["runtime_id"] != runtime:
                    continue
                for oid, actor in other["agents"].items():
                    for key, existing in actor["samples"].items():
                        if other["run_id"] == run and oid == agent and key == skey:
                            continue
                        if (existing["provider"], existing["session_id"]) == (provider, session):
                            require(max(seconds(begin), seconds(existing["since"])) >=
                                    min(seconds(end), seconds(existing["until"])), "overlapping session attribution")
                            require(not ({t["id"] for t in existing.get("turns", [])} &
                                         {t["id"] for t in clean.get("turns", [])}), "duplicate turn attribution")
                            require(not ({r["id"] for r in existing.get("raw_usage", {}).get("requests", [])} &
                                         {r["id"] for r in clean.get("raw_usage", {}).get("requests", [])}),
                                    "duplicate raw request attribution")
            row["samples"][skey] = clean
            if final:
                require(all(s["complete"] and not s["warnings"] and s["tokens"]["total_tokens"] is not None
                            for s in row["samples"].values()), "cannot finalize incomplete usage")
                row["usage_complete_source"] = clean["source"]
            self.save(data)
        return self.report(runtime, run)

    def report(self, runtime, run):
        data = copy.deepcopy(self.get(runtime, run))
        agents = []
        for row in data.pop("agents").values():
            samples = list(row.pop("samples").values())
            row["usage_sources"] = samples
            row["raw_usage_groups"] = raw_usage.groups(samples)
            row["elapsed_seconds"] = elapsed(row["started_at"], row["ended_at"])
            row["elapsed_to_observation_seconds"] = (elapsed(row["started_at"], data["observed_at"])
                if row["started_at"] and not row["ended_at"] and seconds(row["started_at"]) <= seconds(data["observed_at"]) else None)
            row["usage_status"] = "final" if row["usage_complete_source"] else "partial" if samples else "unknown"
            row["tokens"] = {k: sum(s["tokens"][k] for s in samples) if samples and all(s["tokens"][k] is not None for s in samples)
                             else None for k in (*TOKEN_FIELDS, "total_tokens")}
            row["known_tokens"] = {k: sum(s["tokens"][k] for s in samples if s["tokens"][k] is not None)
                                   for k in (*TOKEN_FIELDS, "total_tokens")}
            turns = [t for s in samples for t in s.get("turns", [])]
            timing_complete = bool(samples) and all(s.get("turn_timing_complete", False) for s in samples)
            known_ms = sum(t["duration_ms"] for t in turns if t["duration_ms"] is not None)
            row["known_turn_seconds"] = round(known_ms / 1000, 3)
            row["turn_seconds"] = row["known_turn_seconds"] if timing_complete else None
            row["turn_count"] = len(turns)
            row["turn_timing_status"] = "complete" if timing_complete else "partial" if turns else "unknown"
            agents.append(row)
        data["agents"] = sorted(agents, key=lambda r: (r["role"] != "coordinator", r["agent_id"]))
        final = bool(agents) and all(r["usage_status"] == "final" for r in agents)
        durations = [r["elapsed_seconds"] for r in agents]
        data["summary"] = {
            "wall_seconds": elapsed(data["started_at"], data["ended_at"]),
            "wall_to_observation_seconds": elapsed(data["started_at"], data["observed_at"]),
            "known_agent_seconds": round(sum(d for d in durations if d is not None), 3),
            "unknown_agent_duration_count": sum(d is None for d in durations),
            "agent_seconds": round(sum(durations), 3) if all(d is not None for d in durations) else None,
            "agent_count": len(agents), "unknown_usage_count": sum(r["usage_status"] == "unknown" for r in agents),
            "partial_usage_count": sum(r["usage_status"] == "partial" for r in agents),
            "usage_status": "final" if final else "incomplete",
            "known_tokens": {k: sum(r["known_tokens"][k] for r in agents)
                             for k in (*TOKEN_FIELDS, "total_tokens")},
            "total_tokens": sum(r["tokens"]["total_tokens"] for r in agents) if final else None,
            "raw_usage_groups": raw_usage.groups([s for r in agents for s in r["usage_sources"]]),
        }
        return data

    def reports(self):
        return [self.report(r["runtime_id"], r["run_id"]) for r in self.store.entries("ledger:").values()]
