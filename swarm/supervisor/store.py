"""Private crash-safe policy storage. Never opens Orca's database."""

import contextlib
import fcntl
import json
import os
import sqlite3
import time
from pathlib import Path

from .config import SafetyError, digest, require


class LockBusy(SafetyError):
    pass


class AdmissionError(SafetyError):
    pass


def budget_require(condition, reason):
    if not condition:
        raise AdmissionError(reason)


def private_directory(path):
    path = Path(path)
    require(not path.is_symlink(), "private directory cannot be a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = path.stat()
    require(st.st_uid == os.getuid() and st.st_mode & 0o077 == 0, "private directory needs owner-only mode 0700")
    require(path.absolute() == path.resolve(), "private path contains symlinks")
    return path


@contextlib.contextmanager
def lock(root, name):
    path = Path(root) / name
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise LockBusy("another process owns " + name) from error
        yield
    finally:
        os.close(fd)  # flock is released on normal exit AND process death; never unlink it.


class Store:
    def __init__(self, root, clock=time.time):
        self.root = private_directory(root)
        self.clock = clock
        path = self.root / "policy.sqlite3"
        require(not path.is_symlink(), "database cannot be a symlink")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        require(path.stat().st_uid == os.getuid() and path.stat().st_mode & 0o077 == 0,
                "database permissions must be 0600")
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations (
            key TEXT PRIMARY KEY, goal TEXT NOT NULL, fingerprint TEXT NOT NULL,
            state TEXT NOT NULL, receipt TEXT, created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS charges (
            key TEXT PRIMARY KEY, goal TEXT NOT NULL, role TEXT NOT NULL, created REAL NOT NULL,
            reserved INTEGER NOT NULL, actual INTEGER, source TEXT, details TEXT);
          CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY, created REAL NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))

    def event(self, kind, **details):
        # Callers supply identifiers/reasons, never raw stderr, prompts, or secrets.
        self.db.execute("INSERT INTO events(created,kind,details) VALUES (?,?,?)",
                        (self.clock(), kind, json.dumps(details, ensure_ascii=False)))

    def enroll(self, config):
        goal = config["goal_id"]
        service = {k: v for k, v in config["limits"].items() if k.startswith("max_service")
                   or k in ("max_period_micro_usd", "period_seconds", "max_failures")}
        with self.transaction():
            saved = self.get("service_policy")
            require(saved in (None, service), "service limits changed; do not reset budget with a new config")
            self.put("service_policy", service)
            saved = self.get(goal + ":config_hash")
            require(saved in (None, digest(config)), "authorized plan changed; existing goal is immutable")
            if saved is None:
                self.put(goal + ":config_hash", digest(config))
                self.put(goal + ":started", self.clock())
                self.put(goal + ":tasks", {})
                self.put(goal + ":evidence", {})
                self.event("goal_enrolled", goal=goal)

    def pause(self, reason, *, goal=None):
        key = (goal + ":" if goal else "service:") + "pause"
        existing = self.get(key)
        # An operator pause must never overwrite a safety gate and make it resumable.
        if not existing or str(existing).startswith("operator:"):
            self.put(key, reason)
        self.event("paused", goal=goal, reason=reason)

    def admission(self, config):
        goal = config["goal_id"]
        reason = self.get("service:pause") or self.get(goal + ":pause")
        require(not reason, "paused: " + str(reason))
        budget_require(self.clock() - self.get(goal + ":started") < config["limits"]["max_run_seconds"],
                       "run_duration_exhausted")

    def reserve(self, config, key, role):
        try:
            self._reserve(config, key, role)
        except AdmissionError as error:
            self.pause(str(error), goal=config["goal_id"])
            raise

    def _reserve(self, config, key, role):
        limits, goal = config["limits"], config["goal_id"]
        amount = limits["coordinator_reservation_micro_usd" if role == "coordinator" else "worker_reservation_micro_usd"]
        with self.transaction():
            old = self.db.execute("SELECT * FROM charges WHERE key=?", (key,)).fetchone()
            if old:
                require(old["goal"] == goal and old["role"] == role and old["reserved"] == amount,
                        "charge identity reused for different work")
                return
            self.admission(config)
            period = int(self.clock() // limits["period_seconds"]) * limits["period_seconds"]
            run = self.totals(goal=goal)
            service = self.totals()
            window = self.totals(since=period)
            budget_require(run["launches"] < limits["max_run_launches"], "run_launch_budget_exhausted")
            budget_require(service["launches"] < limits["max_service_launches"], "service_launch_budget_exhausted")
            budget_require(run["charged_micro_usd"] + amount <= limits["max_run_micro_usd"], "run_spend_budget_exhausted")
            budget_require(service["charged_micro_usd"] + amount <= limits["max_service_micro_usd"], "service_spend_budget_exhausted")
            budget_require(window["charged_micro_usd"] + amount <= limits["max_period_micro_usd"], "period_spend_budget_exhausted")
            self.db.execute("INSERT INTO charges(key,goal,role,created,reserved) VALUES (?,?,?,?,?)",
                            (key, goal, role, self.clock(), amount))

    def totals(self, *, goal=None, since=None):
        rows = self.db.execute("SELECT * FROM charges").fetchall()
        rows = [r for r in rows if (goal is None or r["goal"] == goal) and (since is None or r["created"] >= since)]
        return {"launches": len(rows), "charged_micro_usd": sum(r["actual"] if r["actual"] is not None else r["reserved"] for r in rows),
                "known_actual_micro_usd": sum(r["actual"] or 0 for r in rows),
                "unknown_actual_count": sum(r["actual"] is None for r in rows)}

    def cost(self, key, actual, source, details):
        require(type(actual) is int and actual >= 0 and bool(source), "actual cost needs nonnegative integer and evidence source")
        with self.transaction():
            row = self.db.execute("SELECT * FROM charges WHERE key=?", (key,)).fetchone()
            require(row is not None, "unknown charge key")
            data = json.dumps(details, sort_keys=True)
            if row["actual"] is not None:
                require((row["actual"], row["source"], row["details"]) == (actual, source, data), "conflicting duplicate cost")
                return
            self.db.execute("UPDATE charges SET actual=?,source=?,details=? WHERE key=?", (actual, source, data, key))
            if actual > row["reserved"]:
                self.pause("actual_cost_exceeded_reservation")

    def operation(self, goal, key, args, invoke):
        """Write intent before effects; ambiguous calls NEVER execute again automatically."""
        signature = digest(args)
        with self.transaction():
            row = self.db.execute("SELECT * FROM operations WHERE key=?", (key,)).fetchone()
            if row:
                require(row["goal"] == goal and row["fingerprint"] == signature, "operation identity conflict")
                require(row["state"] == "received", "unresolved operation; inspect native request receipt: " + key)
                return json.loads(row["receipt"])
            self.db.execute("INSERT INTO operations VALUES (?,?,?,?,?,?)",
                            (key, goal, signature, "intent", None, self.clock()))
        try:
            receipt = invoke(args)
        except Exception:
            self.pause("unresolved_operation:" + key, goal=goal)
            raise
        with self.transaction():
            self.db.execute("UPDATE operations SET state='received',receipt=? WHERE key=?", (json.dumps(receipt), key))
        return receipt

    def pending(self, goal):
        return [r[0] for r in self.db.execute("SELECT key FROM operations WHERE goal=? AND state!='received'", (goal,))]

    def receipt(self, key):
        row = self.db.execute("SELECT state,receipt FROM operations WHERE key=?", (key,)).fetchone()
        if row:
            require(row["state"] == "received", "unresolved operation: " + key)
            return json.loads(row["receipt"])
        return None

    def charge_rows(self, goal):
        return [dict(r) for r in self.db.execute("SELECT * FROM charges WHERE goal=? ORDER BY created,key", (goal,))]

    def entries(self, prefix):
        return {row["key"][len(prefix):]: json.loads(row["value"])
                for row in self.db.execute("SELECT key,value FROM kv") if row["key"].startswith(prefix)}

    def failure(self, limits, reason):
        with self.transaction():
            failures = self.get("service:failures", 0) + 1
            self.put("service:failures", failures)
            self.put("service:retry_after", self.clock() + min(10 * 2 ** min(failures - 1, 6), 300))
            self.event("supervisor_failure", count=failures, reason=reason)
            if failures >= limits["max_failures"]:
                self.pause("supervisor_circuit_open")
        return failures
