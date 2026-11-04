"""Policy over native Run/Task/Dispatch truth; never a second lifecycle scheduler."""

import hashlib
import json
import re
from pathlib import Path, PurePosixPath

from .config import SafetyError, digest, overlap, relative_path, require, task_spec
from .orca import result
from .launch_guard import preflight as launch_preflight, require_ready
from .store import AdmissionError


def object_value(value):
    value = json.loads(value) if isinstance(value, str) else value
    require(isinstance(value, dict), "expected structured native record")
    return value


def observation(tasks, workers, messages):
    """Ignore heartbeat traffic, but retain liveness/attention and task changes."""
    return digest({
        "tasks": sorted((t["id"], t["status"], t.get("dispatch_id")) for t in tasks),
        "workers": sorted((w["dispatchId"], w["workerState"], w["dispatchStatus"], w["terminalState"],
                           w["projection"]["liveness"]["verdict"],
                           sorted(w["projection"].get("attention", {}).get("categories", []))) for w in workers),
        "messages": sorted(m["id"] for m in messages if m.get("type") != "heartbeat"),
    })


class Engine:
    def __init__(self, config, store, native):
        self.c, self.s, self.n = config, store, native
        self.g = config["goal_id"]
        self.contracts = {t["key"]: t for t in config["tasks"]}

    def get(self, key, default=None):
        return self.s.get(self.g + ":" + key, default)

    def put(self, key, value):
        self.s.put(self.g + ":" + key, value)

    def op(self, key, argv):
        receipt = self.s.operation(self.g, self.g + ":" + key, argv, self.n.invoke)
        try:
            return result(receipt)
        except SafetyError:
            self.s.pause("native_operation_failed:" + key, goal=self.g)
            raise

    def initialize(self):
        if not self.get("run") and self.s.receipt(self.g + ":run-create") is None:
            launch_preflight(self.c)  # Before any Orca call or launch reservation.
        self.n.verify_runtime()
        terminal = self.n.identity()
        if self.get("run"):
            self.verify()
            return self.get("run")
        identity = {"handle": terminal["handle"], "pty_id": terminal["ptyId"]}
        require(self.get("initial_identity") in (None, identity),
                "initial Coordinator incarnation changed; manual recovery required")
        self.put("initial_identity", identity)  # Fence even a crash just after run-create.
        self.n.preflight(self.c["runtime"]["coordinator_worktree_id"])
        self.s.admission(self.c)
        # Count the operator-launched initial Coordinator too. No claim of a provider cap.
        self.s.reserve(self.c, self.g + ":round:0", "coordinator")
        saved = self.s.receipt(self.g + ":run-create")
        if saved is None:
            current = self.n.read("orchestration", "run-current").get("run")
            require(current is None, "Coordinator already has a Run; never replace it implicitly")
        created = self.op("run-create", ["orchestration", "run-create", "--objective", self.c["objective"]])["run"]
        require(not created.get("legacy") and created.get("coordinator_handle") == terminal["handle"],
                "Run did not bind to this Coordinator")
        with self.s.transaction():
            self.put("run", {"id": created["id"], "coordinator_handle": terminal["handle"],
                             "consumer_generation": created["consumer_generation"], "pty_id": terminal["ptyId"]})
            self.put("round", {"number": 0, "phase": "active", "started": self.s.clock()})
        self.verify()
        return self.get("run")

    def verify(self, *, supervisor=False):
        self.n.verify_runtime()
        binding = self.get("run")
        require(binding, "initialize from the genuine Coordinator first")
        run = self.n.read("orchestration", "run-show", "--id", binding["id"])["run"]
        require(not run.get("legacy") and all(run.get(k) == binding[k]
                for k in ("id", "coordinator_handle", "consumer_generation")), "Run identity changed; manual takeover required")
        terminal = self.n.terminal(binding["coordinator_handle"]) if supervisor else self.n.identity()
        require(terminal["handle"] == binding["coordinator_handle"] and terminal["ptyId"] == binding["pty_id"],
                "Coordinator incarnation changed; no automatic takeover")
        if not supervisor:
            current = self.n.read("orchestration", "run-current").get("run")
            require(current and current["id"] == binding["id"], "this Coordinator is not bound to the saved Run")
        return binding["id"]

    def hydrate(self):
        """Repair a crash between receipt persistence and policy-index persistence."""
        mapping = self.get("tasks", {})
        for key in self.contracts:
            receipt = self.s.receipt(self.g + ":create:" + key)
            if receipt:
                task_id = result(receipt)["task"]["id"]
                require(key not in mapping or mapping[key]["id"] == task_id, "task receipt conflict")
                mapping.setdefault(key, {"id": task_id})
            receipt = self.s.receipt(self.g + ":start:" + key)
            if receipt:
                launch = result(receipt)
                require(key in mapping and launch.get("taskId") == mapping[key]["id"], "start task mismatch")
                require_ready(launch)
                self.validate_launch(key, launch)
                mapping[key]["dispatch"] = launch["dispatchId"]
        self.put("tasks", mapping)
        return mapping

    def validate_launch(self, key, started):
        agent = self.c["agents"][self.contracts[key]["role"]]
        effective = started.get("launch", {}).get("effective", {})
        require(isinstance(effective, dict) and effective, "missing effective launch settings")
        for option in ("model", "effort"):
            require(not agent.get(option) or effective.get(option) == agent[option],
                    "effective launch preference mismatch")
        self.put("launch:" + key, effective)

    def inventory(self):
        mapping = self.hydrate()
        run = self.get("run")["id"]
        tasks, workers = self.n.tasks(run), self.n.workers(run)
        require({t["id"] for t in tasks} == {t["id"] for t in mapping.values()},
                "native task inventory differs from approved plan")
        by_task = {t["id"]: t for t in tasks}
        expected = {v["dispatch"]: v["id"] for v in mapping.values() if v.get("dispatch")}
        require({w["dispatchId"] for w in workers} == set(expected), "native Dispatch inventory is incomplete or has unknown attempts")
        for w in workers:
            require(w["taskId"] == expected[w["dispatchId"]], "Dispatch task mismatch")
            require(by_task[w["taskId"]].get("dispatch_id") == w["dispatchId"], "Task active Dispatch changed")
            require(w["projection"]["liveness"]["verdict"] in ("live", "unverifiable", "exited"), "unknown liveness schema")
        for entry in mapping.values():
            task = by_task[entry["id"]]
            if not entry.get("dispatch"):
                require(task["status"] in ("ready", "pending", "blocked") and not task.get("dispatch_id"),
                        "unrecorded native attempt; never launch again")
        return mapping, by_task, {w["dispatchId"]: w for w in workers}

    def settlement(self, key, task, worker):
        require(task["status"] in ("completed", "failed"), "Task has no accepted settlement")
        report = object_value(task.get("result"))
        expected = "succeeded" if task["status"] == "completed" else "failed"
        require(report.get("provenance") == "worker_report" and report.get("outcome") == expected
                and report.get("messageId"), "settlement is not an accepted worker report")
        require(worker["workerState"] == expected and worker["projection"].get("outcome") == expected,
                "Worker and Task settlement disagree")
        return report

    def evidence(self, key, value, report):
        """Validate a Coordinator-attested manifest, NOT execute worker-provided shell text."""
        task = self.contracts[key]
        require(isinstance(value, dict) and value.get("message_id") == report["messageId"], "evidence message mismatch")
        require(value.get("base_commit") == self.c["base_commit"], "evidence base mismatch")
        require(re.fullmatch(r"[0-9a-f]{40}", value.get("commit", "")) and set(value["commit"]) != {"0"}, "full delivered SHA required")
        require(isinstance(value.get("files"), list) and all(relative_path(p) for p in value["files"]), "evidence file list required")
        require(all(any(PurePosixPath(p) == PurePosixPath(a) or PurePosixPath(a) in PurePosixPath(p).parents
                        for a in task["allowed_paths"]) for p in value["files"]), "changes outside task ownership")
        require(not any(overlap(p, a) for p in value["files"] for a in task["do_not_touch"]), "protected path changed")
        tests = value.get("tests", [])
        require(isinstance(tests, list) and {t.get("command") for t in tests} == set(task["acceptance"]["commands"]),
                "all acceptance commands need results")
        require(all(type(t.get("exit_code")) is int for t in tests), "numeric test exit codes required")
        require(value.get("coordinator_verified") is True and isinstance(value.get("risks"), list), "Coordinator must inspect evidence and risks")
        require(isinstance(value.get("artifacts"), list) and value["artifacts"]
                and all(isinstance(a, dict) and isinstance(a.get("path"), str) and a["path"].startswith("/")
                        and re.fullmatch(r"[0-9a-f]{64}", a.get("sha256", "")) for a in value["artifacts"]),
                "durable sanitized artifact paths and SHA256s required before release")
        root = Path(self.c["artifact_dir"]).resolve()
        for artifact in value["artifacts"]:
            path = Path(artifact["path"])
            require(root in path.parents and path == path.resolve() and path.is_file(),
                    "preserve sanitized evidence under artifact_dir before releasing the Worker")
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            require(digest.hexdigest() == artifact["sha256"], "artifact digest mismatch")
        require(value.get("verdict") in ("pass", "fail"), "explicit evidence verdict required")
        if value["verdict"] == "pass":
            require(report["outcome"] == "succeeded" and all(t["exit_code"] == 0 for t in tests), "cannot pass failed work")
        # Whitelist fields; never copy raw native message bodies into public summaries.
        clean = {k: value[k] for k in ("message_id", "base_commit", "commit", "files", "tests", "risks", "artifacts", "verdict")}
        clean["role"] = task["role"]
        saved = self.get("evidence", {})
        require(key not in saved or saved[key] == clean, "evidence is immutable")
        saved[key] = clean
        self.put("evidence", saved)
        if clean["verdict"] == "fail":
            self.put("blocked:" + key, "acceptance_failed; manual re-plan required")

    def cleanup(self, mapping, tasks, workers):
        need = []
        evidence = self.get("evidence", {})
        for key, entry in mapping.items():
            if not entry.get("dispatch"):
                continue
            w, t = workers[entry["dispatch"]], tasks[entry["id"]]
            if t["status"] not in ("completed", "failed"):
                continue
            self.settlement(key, t, w)
            if key not in evidence:
                need.append(key)
                continue
            if w["terminalState"] == "released":
                continue
            require(w["terminalState"] == "reclaimable", "settled resource state uncertain; inspect, do not cancel")
            released = self.op("release:" + key, ["orchestration", "worker-release", "--dispatch", entry["dispatch"]])
            require(released.get("dispatchId") == entry["dispatch"] and released.get("state") == "released",
                    "release unconfirmed; preserve native recovery receipt and request manual recovery")
        return need

    def check(self):
        delivery = self.get("delivery")
        if delivery is not None:
            return delivery
        number = self.get("check_number", 0)
        delivery = self.op("check:" + str(number), ["orchestration", "check", "--run", self.get("run")["id"]])
        require(isinstance(delivery.get("messages"), list) and not delivery.get("legacyCompatibility"), "unsupported Delivery")
        require(not delivery["messages"] or delivery.get("deliveryId"), "messages have no FIFO delivery identity")
        with self.s.transaction():
            self.put("check_number", number + 1)
            self.put("delivery", delivery if delivery.get("deliveryId") else None)
        return delivery

    def process_delivery(self, delivery, decisions, mapping, tasks, workers):
        pending = []
        evidence = self.get("evidence", {})
        handled = self.get("handled", {})
        # Receipt acknowledgment and human authorization are separate states.
        # Retain private originals so an acknowledged question can be answered later,
        # including after restart, without keeping the native FIFO batch open.
        human_messages = self.get("human_messages", {})
        delivered_ids = {m["id"] for m in delivery["messages"]}
        messages = delivery["messages"] + [m for mid, m in human_messages.items() if mid not in delivered_ids]
        for message in messages:
            mid = message["id"]
            require(message.get("run_id") == self.get("run")["id"] and
                    message.get("delivery_contract") not in ("legacy_direct", "audit_only"), "foreign/read-only message")
            if mid in handled:
                continue
            decision = decisions.get(mid)
            if message.get("type") == "worker_done":
                payload = object_value(message.get("payload"))
                keys = [k for k, v in mapping.items() if v["id"] == payload.get("taskId") and v.get("dispatch") == payload.get("dispatchId")]
                require(len(keys) == 1, "worker_done does not match the expected active attempt")
                key = keys[0]
                report = self.settlement(key, tasks[payload["taskId"]], workers[payload["dispatchId"]])
                require(report["messageId"] == mid and report["outcome"] == payload.get("outcome"), "completion report mismatch")
                if key not in evidence:
                    pending.append(mid)
                    continue
                require(workers[payload["dispatchId"]]["terminalState"] == "released", "release before acknowledgment")
                handled[mid] = "settled_and_released"
            elif message.get("type") in ("question", "escalation"):
                human = self.get("human:" + mid)
                if decision and decision.get("action") == "reply":
                    require(decision.get("within_scope") is True and isinstance(decision.get("body"), str) and decision["body"].strip(),
                            "reply needs an in-scope answer; new authority requires a human")
                    self.op("reply:" + mid, ["orchestration", "reply", "--id", mid, "--body", decision["body"], "--run", self.get("run")["id"]])
                    handled[mid] = "replied"
                    human_messages.pop(mid, None)
                    with self.s.transaction():
                        self.put("handled", handled)
                        self.put("human_messages", human_messages)
                        if human:
                            self.put("human:" + mid, {**human, "resolved": True,
                                                      "resolved_at": self.s.clock()})
                elif (decision and decision.get("action") == "human") or (human and not human["resolved"]):
                    if decision and decision.get("action") == "human":
                        human = {"reason": decision.get("reason", "approval_required"),
                                 "message_id": mid, "resolved": False}
                    human_messages[mid] = message
                    # Commit the deferred question BEFORE acknowledging its Delivery.
                    # Also upgrades old unacked human records on their next step.
                    with self.s.transaction():
                        self.put("human:" + mid, human)
                        self.put("human_messages", human_messages)
                else:
                    pending.append(mid)
            elif message.get("type") == "heartbeat":
                handled[mid] = "heartbeat_received"  # No reply, approval, or model decision.
            elif decision and decision.get("action") == "reviewed":
                require(decision.get("note"), "non-lifecycle messages require a review note")
                handled[mid] = "reviewed"
            else:
                pending.append(mid)  # Unknown message types never silently disappear.
            self.put("handled", handled)
        if delivery.get("deliveryId") and not pending:
            did = delivery["deliveryId"]
            # Ack can ALSO return the next Delivery. Preserve and process it on the next step.
            following = self.op("ack:" + did, ["orchestration", "check", "--run", self.get("run")["id"], "--ack", did])
            require(isinstance(following.get("messages"), list), "invalid acknowledgment receipt")
            require(not following["messages"] or following.get("deliveryId"), "following messages lack Delivery ID")
            self.put("delivery", following if following.get("deliveryId") else None)
        return pending

    def prepare_trae_workspace(self, key, place):
        """Resolve creation receipts before trusting; never guess a new path."""
        if place["kind"] == "new-top-level":
            created = self.op("workspace:" + key, [
                "worktree", "create", "--repo", "id:" + self.c["runtime"]["repo_id"],
                "--name", place["name"], "--no-parent", "--base-branch", self.c["base_commit"],
                "--setup", "skip"])
            workspace_id = created["worktree"]["id"]
        else:
            workspace_id = place["worktree_id"]
        require(isinstance(workspace_id, str)
                and workspace_id.startswith(self.c["runtime"]["repo_id"] + "::/")
                and workspace_id != self.c["runtime"]["coordinator_worktree_id"],
                "prepared Trae workspace identity mismatch")
        self.put("workspace:" + key, workspace_id)
        self.s.event("trae_trust_intent", goal=self.g, task=key, worktree_id=workspace_id)
        receipt = self.n.trust_workspace(workspace_id, expected_head=(
            self.c["base_commit"] if place["kind"] == "new-top-level" else None))
        self.put("trust:" + key, receipt)
        self.s.event("trae_workspace_trusted", goal=self.g, task=key, **receipt)
        return workspace_id

    def schedule(self, mapping, tasks, workers):
        try:
            self.s.admission(self.c)
        except AdmissionError as error:
            self.s.pause(str(error), goal=self.g)
            return []
        except SafetyError:
            return []  # Budget/pause does not prevent readback, replies and settled cleanup.
        if self.s.pending(self.g):
            return []
        active = [w for w in workers.values() if w["terminalState"] != "released"]
        if any(w["projection"]["liveness"]["verdict"] != "live" for w in active):
            return []
        if any(w["workerState"] != "ready" for w in active):
            return []
        roles = [self.contracts[k]["role"] for k, v in mapping.items() if v.get("dispatch") in {w["dispatchId"] for w in active}]
        evidence, launched = self.get("evidence", {}), []
        for key, contract in self.contracts.items():
            entry = mapping.get(key)
            if entry and entry.get("dispatch"):
                continue
            if self.get("blocked:" + key) or not all(evidence.get(d, {}).get("verdict") == "pass" for d in contract.get("depends_on", [])):
                continue
            role = contract["role"]
            if len(roles) >= self.c["limits"]["total_concurrency"] or "integration" in roles:
                break
            if role == "integration" and roles:
                continue
            if role == "implementation" and roles.count(role) >= self.c["limits"]["implementation_concurrency"]:
                continue
            place = contract["placement"]
            try:
                launch_preflight(self.c)
            except SafetyError:
                self.s.pause("launch_contract_blocked", goal=self.g)
                return launched  # Keep readback/settlement available for existing attempts.
            self.n.preflight(place.get("worktree_id"))
            auto_trust = (self.c["agents"][role]["agent"] == "trae"
                          and self.c.get("trae_workspace_trust", {}).get("enabled") is True)
            if auto_trust:
                self.n.check_trust_context()  # Fail before even creating a workspace.
            try:
                self.s.reserve(self.c, self.g + ":worker:" + key, role)
            except AdmissionError:
                break
            run = self.get("run")["id"]
            if not entry:
                deps = [mapping[d]["id"] for d in contract.get("depends_on", [])]
                # Integration needs the implementation SHAs as well as its direct review verdict.
                prerequisites = set(contract.get("depends_on", []))
                queue = list(prerequisites)
                while queue:
                    for dep in self.contracts[queue.pop()].get("depends_on", []):
                        if dep not in prerequisites:
                            prerequisites.add(dep)
                            queue.append(dep)
                spec = task_spec(self.c, contract, {d: evidence[d] for d in sorted(prerequisites)})
                created = self.op("create:" + key, ["orchestration", "task-create", "--spec", spec, "--task-title", key,
                                                  "--deps", json.dumps(deps), "--run", run])
                entry = {"id": created["task"]["id"]}
                mapping[key] = entry
                self.put("tasks", mapping)
            native_tasks = {t["id"]: t for t in self.n.tasks(run)}
            require(native_tasks[entry["id"]]["status"] == "ready", "native task is not ready; no forced launch")
            place, agent = contract["placement"], self.c["agents"][role]
            argv = ["orchestration", "worker-start", "--task", entry["id"], "--run", run, "--agent", agent["agent"], "--timeout-ms", "45000"]
            if auto_trust:
                try:
                    workspace_id = self.prepare_trae_workspace(key, place)
                except (SafetyError, OSError):
                    self.s.pause("trae_workspace_preparation_failed:" + key, goal=self.g)
                    raise
                argv += ["--worktree", "id:" + workspace_id]
            elif place["kind"] == "new-top-level":
                argv += ["--worktree", "new-top-level", "--repo", "id:" + self.c["runtime"]["repo_id"],
                         "--name", place["name"], "--base-branch", self.c["base_commit"], "--setup", "skip"]
            else:
                argv += ["--worktree", "id:" + place["worktree_id"]]
            for option in ("model", "effort"):
                if agent.get(option):
                    argv += ["--" + option, agent[option]]
            started = self.op("start:" + key, argv)
            require_ready(started)
            require(started.get("taskId") == entry["id"], "worker launch task mismatch")
            entry["dispatch"] = started["dispatchId"]
            self.put("tasks", mapping)
            self.validate_launch(key, started)
            self.s.event("worker_started", goal=self.g, task=key, dispatch=entry["dispatch"])
            roles.append(role)
            launched.append(key)
        return launched

    def step(self, decisions=None):
        decisions = decisions or {}
        self.verify()
        require(not self.s.pending(self.g), "unresolved native operation; inspect receipts before continuing")
        round_ = self.get("round")
        require(round_["phase"] in ("active", "waking"), "begin a new authorized round before stepping")
        require(self.s.clock() - round_["started"] <= self.c["limits"]["max_round_seconds"], "Coordinator round expired")
        if round_["phase"] == "waking":
            round_["phase"] = "active"
            self.put("round", round_)
        mapping, tasks, workers = self.inventory()
        for key, value in decisions.get("evidence", {}).items():
            require(key in mapping and mapping[key].get("dispatch"), "evidence for unknown task")
            entry = mapping[key]
            report = self.settlement(key, tasks[entry["id"]], workers[entry["dispatch"]])
            self.evidence(key, value, report)
        needs_evidence = self.cleanup(mapping, tasks, workers)
        mapping, tasks, workers = self.inventory()
        delivery = self.check()
        pending = self.process_delivery(delivery, decisions.get("messages", {}), mapping, tasks, workers)
        launched = self.schedule(mapping, tasks, workers)
        mapping, tasks, workers = self.inventory()
        evidence = self.get("evidence", {})
        waiting_human = sorted(self.get("human_messages", {}))
        complete = (len(mapping) == len(self.contracts) and not self.get("delivery") and not waiting_human and
                    all(t["status"] == "completed" for t in tasks.values()) and
                    all(w["terminalState"] == "released" for w in workers.values()) and
                    all(evidence.get(k, {}).get("verdict") == "pass" for k in self.contracts))
        self.put("complete", complete)
        self.put("progress_at", self.s.clock()) if launched or decisions or complete else None
        return {"complete": complete, "launched": launched, "needs_evidence": needs_evidence,
                "pending_messages": pending, "waiting_human": waiting_human,
                "next_delivery": bool(self.get("delivery")),
                "run_id": self.get("run")["id"]}

    def checkpoint(self):
        run = self.verify()
        require(not self.s.pending(self.g), "cannot checkpoint an uncertain operation")
        _, tasks, workers = self.inventory()
        require(not any(w["terminalState"] == "reclaimable" for w in workers.values()), "settled Workers still need evidence and release")
        peek = self.n.read("orchestration", "check", "--run", run, "--peek")
        require(isinstance(peek.get("messages"), list) and not peek.get("legacyCompatibility"), "unsupported checkpoint peek")
        messages = peek["messages"]
        round_ = self.get("round")
        require(round_["phase"] == "active", "round not active")
        handled = self.get("handled", {})
        human_messages = self.get("human_messages", {})
        # Peek is an observation, NOT evidence of handling. Check the cached next
        # Delivery too: an ack may have returned messages the Agent has not seen.
        cached = (self.get("delivery") or {}).get("messages", [])
        unprocessed = [m for m in messages + cached if m.get("type") != "heartbeat"
                       and m["id"] not in handled and m["id"] not in human_messages]
        if unprocessed:
            self.put("complete", False)
            raise SafetyError("unprocessed messages; run coordinator-step before checkpoint")
        round_.update(phase="waiting", fingerprint=observation(list(tasks.values()), list(workers.values()), messages))
        round_["operator_request"] = self.get("operator_request", 0)
        self.put("round", round_)
        self.put("checkpoint_at", self.s.clock())
        return {"phase": "waiting", "complete": self.get("complete", False), "end_agent_turn_now": True}
