"""Native maintenance transport and review pins; no service management or live effects."""

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, publish_new
from operator_continuity_route import maintenance_call
from operator_planned_restart import review_source


class PlannedRestartTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cli = self.write("cli", b"fixture")
        self.plan = self.write("plan.json", {})
        proposal = dict(plan=self.plan)
        self.prepared = dict(proposal=proposal, proposalCanonicalSha256=digest(canonical(proposal)), runId="run")
        self.prep = self.write("preparation.json", dict(preparation=self.prepared,
                              preparationCanonicalSha256=digest(canonical(self.prepared))))
        self.sealed = dict(runId="run", sourceRuntimeId="source", databaseId="db")
        self.seal = self.write("seal.json", dict(seal=self.sealed, sealCanonicalSha256=digest(canonical(self.sealed))))
        self.contract = dict(cli=self.cli, runtime="source", run=dict(id="run"))

    def write(self, name, value):
        target = self.root / name
        publish_new(target, value)
        return file_ref(target)

    def test_native_transport_pins_cli_and_keeps_runtime_validation(self):
        request = dict(phase="transition", seal=self.seal)
        seen = []
        def execute(args, **kwargs):
            self.assertEqual(args[:4], [self.cli["path"], "orchestration", "planned-restart", "--request-file"])
            self.assertEqual(args[-1], "--json")
            temporary = Path(args[4])
            self.assertEqual(json.loads(temporary.read_bytes()), request)
            seen.append(temporary)
            return subprocess.CompletedProcess(args, 0, canonical(dict(ok=True, result=dict(phase="transition"),
                                                       _meta=dict(runtimeId="target"))).decode(), "")
        with patch("trae_coordinator.subprocess.run", side_effect=execute) as call:
            self.assertEqual(maintenance_call(self.cli, "target", request), dict(phase="transition"))
            with self.assertRaisesRegex(ValueError, "runtime changed"):
                maintenance_call(self.cli, "other", request)
        self.assertEqual(call.call_count, 2)
        self.assertTrue(all(not path.exists() for path in seen))

    def test_review_checks_canonical_pins_before_native_and_checks_response(self):
        proof = dict(preparationCanonicalSha256=digest(canonical(self.prepared)))
        result = dict(review=proof, reviewCanonicalSha256=digest(canonical(proof)))
        with patch("operator_planned_restart.original", return_value=(None, None, None, None, self.contract)), \
             patch("operator_planned_restart.maintenance_call", return_value=result) as call:
            self.assertEqual(review_source(self.plan, self.prep, self.seal, approved=True, reason="independent"), result)
            self.assertEqual(call.call_args.args[2]["phase"], "review")
            bad = self.write("bad-preparation.json", dict(preparation=self.prepared, preparationCanonicalSha256="f" * 64))
            with self.assertRaisesRegex(ValueError, "preparation_mismatch"):
                review_source(self.plan, bad, self.seal, approved=True, reason="independent")
            self.assertEqual(call.call_count, 1)
            call.return_value = copy.deepcopy(result)
            call.return_value["reviewCanonicalSha256"] = "f" * 64
            with self.assertRaisesRegex(ValueError, "review_mismatch"):
                review_source(self.plan, self.prep, self.seal, approved=True, reason="independent")


if __name__ == "__main__":
    unittest.main()
