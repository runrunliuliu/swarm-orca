"""Real RSI CLI -> exact projection -> scheduler, with explicit native fixtures.

Run with RSI_CHECKER_TEST_ROOT pointing at the actual target checkout. No mock
domain receipts, model calls, runtime writes or changes to the RSI checkout.
"""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from coordinator_io import canonical, digest, now, parse, pinned
from coordinator_tui_checkpoint import FIELDS, validate_record
from coordinator_tui_scheduler import dependencies
import test_coordinator_tui_scheduler as scheduling


@unittest.skipUnless(os.environ.get("RSI_CHECKER_TEST_ROOT"), "explicit real RSI checkout required")
class RsiIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(os.environ["RSI_CHECKER_TEST_ROOT"]).resolve(strict=True)
        self.s = scheduling.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.f = self.s.f
        self.sequence = 0
        self.source_root = self.f.t.f.bootstrap
        quote = "TEST FIXTURE ONLY: local edits allowed; max_workers=2."
        raw = self.source_root / "authority-source.txt"
        raw.write_text(quote)
        self.authority = dict(schema_version=1, run_id="run_test", scope_id="test-scope", events=[dict(
            id="fixture", actor="user", source=dict(path=raw.name, sha256=digest(raw.read_bytes()), excerpt=quote),
            patch={"permissions.local_edit": "granted", "limits.max_workers": {"mode": "bounded", "value": 2}})])
        self.authority_ref = self.f.t.ref("bootstrap/authority.json", self.authority)
        self.contract = dict(schema_version=1, run_id="run_test", objective_ref="fixture://objective",
            authorization_ref="fixture://authority", requirements=self.f.record["requirements"])
        self.contract_ref = self.f.t.ref("bootstrap/acceptance-contract.json", self.contract)
        self.authority_args = ["--authority", self.authority_ref["path"], "--authority-sha256",
            digest(canonical(self.authority)), "--source-root", str(self.source_root), "--run-id", "run_test",
            "--scope-id", "test-scope"]
        resolved = self.cli("resolve-authority", *self.authority_args)
        self.handoff = self.f.t.ref("bootstrap/handoff.json", resolved["result"]["handoff"])

    def cli(self, *args, error=None):
        proc = subprocess.run([sys.executable, "-B", "-S", "-m", "rsi", *args],
                              cwd=self.root, capture_output=True, text=True, timeout=20)
        reply = json.loads(proc.stdout or proc.stderr)
        self.assertEqual(proc.returncode, 0 if error is None else 2, reply)
        if error:
            self.assertIn(error, json.dumps(reply))
        return reply

    def source(self):
        self.s.new_turn(("waiting", "waiting"))
        record = copy.deepcopy(self.f.record["checkpoint"])
        for barrier in record["barriers"]:
            barrier.update(kind="dependency_running", attempt_refs=[], recovery_limit=None, alternatives_ref=None)
        record["next_action"].update(prerequisites=["orca-dispatch:d1"], expected_outputs=["fixture://recheck"])
        return dict(record, schema_version=2, run_id="run_test", observed_at=now(),
                    objective_ref=self.contract["objective_ref"], contract_sha256=digest(canonical(self.contract)),
                    claim_limits=[])

    def checked(self, source, *, technical="not_ready", error=None):
        self.sequence += 1
        prefix = f"bootstrap/check-{self.sequence}"
        source_ref = self.f.t.ref(prefix + "-source.json", source)
        context = dict(schema_version=1, run_id="run_test", scope_id="test-scope",
            authority_sha256=digest(canonical(self.authority)), contract_sha256=digest(canonical(self.contract)),
            paths=[dict(id=p["id"], operation=p["operation"], permissions=["local_edit"]) for p in source["paths"]])
        context_ref = self.f.t.ref(prefix + "-context.json", context)
        gates_ref = self.f.t.ref(prefix + "-gates.json", dict(schema_version=1, paths=[dict(
            id=p["id"], technical=technical, platform="allowed", evidence_refs=["fixture://native-dispatch"])
            for p in source["paths"]]))
        receipt = self.cli("check-authorized-progress", source_ref["path"], "--contract", self.contract_ref["path"],
            "--contract-sha256", digest(canonical(self.contract)), *self.authority_args,
            "--handoff", self.handoff["path"], "--context", context_ref["path"],
            "--context-sha256", digest(canonical(context)), "--gates", gates_ref["path"], error=error)
        if error:
            return
        self.f.record["checkpoint"] = {key: source[key] for key in FIELDS}
        self.f.record["domain_check"] = dict(adapter="rsi-authorized-progress-v1", source=source_ref,
            receipt=self.f.t.ref(prefix + "-receipt.json", receipt))
        self.f.record_path = self.source_root / (f"real-projection-{self.sequence}.json")
        self.f.rewrite_record(rebind=False)
        self.s.ended["completed_turn"].update(context_at=source["observed_at"], completed_at=now())
        return validate_record(self.f.record, self.f.config, self.f.c)

    def test_real_checker_projection_wait_and_native_completion(self):
        source = self.source()
        _, route = self.checked(source)
        self.assertEqual(route.kind, "dependency_wait")
        self.s.snapshot["workers"] = [dict(dispatch="d1", dispatch_status="dispatched", state="working")]
        self.assertEqual(self.s.tick()["state"], "waiting_dependencies")
        self.s.snapshot["workers"][0]["dispatch_status"] = "completed"
        self.assertEqual(self.s.tick()["state"], "continuation_enqueued")
        self.s.execute()
        self.assertEqual(len(self.s.m.messages), 1)

    def test_real_checker_preserves_extra_field_and_technical_conflict_refusals(self):
        source = self.source()
        source["next_action"]["dependencies"] = dict(dispatches=["d1"], jobs=[])
        self.checked(source, error="next_action_required")
        del source["next_action"]["dependencies"]
        self.checked(source, technical="ready", error="technical_blocker_conflict")

    def test_checker_success_does_not_authenticate_native_dependency(self):
        source = self.source()
        self.checked(source)
        with self.assertRaisesRegex(ValueError, "dependency_unknown"):
            dependencies(self.f.record, {"workers": [], "jobs": {}})
        self.assertEqual(self.s.m.messages, [])


if __name__ == "__main__":
    unittest.main()
