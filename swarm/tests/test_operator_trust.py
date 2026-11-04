import contextlib
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, publish_new
import operator_prepare
import operator_trust as subject
from supervisor.orca import Orca
import test_trae_trust


class OperatorTrustTests(unittest.TestCase):
    def setUp(self):
        test_trae_trust.TrustTests.setUp(self)
        self.output = self.root / "receipts"
        self.output.mkdir(mode=0o700)
        subprocess.run(["git", "init", "-q", str(self.workspace)], check=True)
        subprocess.run(["git", "-C", str(self.workspace), "-c", "user.name=test", "-c",
                        "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], check=True)
        head = subprocess.check_output(["git", "-C", str(self.workspace), "rev-parse", "HEAD"], text=True).strip()
        self.workspace_id = "repo::" + str(self.workspace)
        self.review = self.root / "review.json"
        publish_new(self.review, {"note": "fixture only"})
        self.source = {
            "schema_version": 1, "runtime": {"cli": "/usr/bin/true", "runtime_id": "runtime",
                                              "version": "1.4.219", "repo_id": "repo"},
            "workspace": self.workspace_id, "head": head, "agent": "trae", "role": "reviewer",
            "policy": self.policy, "authority_refs": [file_ref(self.review)],
            "content_review_refs": [file_ref(self.review)], "directory": str(self.output)}
        owner = self
        self.calls = []

        class Native(Orca):
            def read(self, *argv):
                owner.calls.append(argv)
                if argv == ("status",):
                    return {"runtime": {"state": "ready", "reachable": True,
                                        "runtimeId": "runtime", "appVersion": "1.4.219"}}
                if argv[:2] == ("repo", "show"):
                    return {"repo": {"id": "repo"}}
                if argv[:2] == ("worktree", "show"):
                    return {"worktree": {"id": owner.workspace_id, "repoId": "repo",
                                         "path": str(owner.workspace), "hostId": "local"}}
                raise AssertionError(argv)

        self.native = Native

    def run_registration(self):
        source = self.root / "input.json"
        source.write_text(json.dumps(self.source))
        return subject.register(file_ref(source), env=self.env, native_factory=self.native)

    def test_success_and_repeat_are_read_only_after_exact_grant(self):
        result = self.run_registration()
        self.assertTrue(result["registration"]["changed"])
        before = self.target.read_bytes()
        receipt = Path(result["receipt"]["path"]).read_bytes()
        with patch.object(subject.trae_trust, "register", side_effect=AssertionError("second grant")):
            self.assertTrue(self.run_registration()["reused_receipt"])
        self.assertEqual(self.target.read_bytes(), before)
        self.assertEqual(Path(result["receipt"]["path"]).read_bytes(), receipt)
        self.assertFalse(result["execution_authorized"])
        self.assertTrue(all(c[0] in ("status", "repo", "worktree") for c in self.calls))

    def test_dirty_git_refuses_before_intent(self):
        (self.workspace / "unexpected").write_text("dirty")
        with self.assertRaisesRegex(Exception, "dirty"):
            self.run_registration()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_head_and_runtime_mismatch_refuse(self):
        for key, value in (("head", "1" * 40), ("runtime", {**self.source["runtime"], "runtime_id": "other"})):
            old = self.source[key]
            self.source[key] = value
            with self.subTest(key=key), self.assertRaises(Exception):
                self.run_registration()
            self.source[key] = old
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_changed_native_identity_refuses(self):
        self.workspace_id = "other::" + str(self.workspace)
        with self.assertRaisesRegex(Exception, "identity mismatch"):
            self.run_registration()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_refs_are_required_and_pinned(self):
        for key in ("authority_refs", "content_review_refs"):
            old = self.source[key]
            self.source[key] = []
            with self.assertRaisesRegex(ValueError, "review_refs_required"):
                self.run_registration()
            self.source[key] = old
        self.review.write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.run_registration()

    def test_grant_never_overwrites_existing_distrust(self):
        self.target.write_text('[projects.' + json.dumps(str(self.workspace)) + ']\ntrust_level="untrusted"\n')
        before = self.target.read_bytes()
        with self.assertRaisesRegex(Exception, "not trusted"):
            self.run_registration()
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse((self.output / "trusted.json").exists())

    def test_revoked_trust_cannot_reuse_receipt(self):
        self.run_registration()
        self.target.write_bytes(self.original)
        with self.assertRaisesRegex(ValueError, "revoked_or_missing"):
            self.run_registration()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_crash_after_grant_preserves_intent_no_automatic_retry(self):
        publish = subject.publish_new

        def fail(target, value):
            if target.name == "trusted.json":
                raise OSError("fixture crash")
            return publish(target, value)

        with patch.object(subject, "publish_new", side_effect=fail), self.assertRaises(OSError):
            self.run_registration()
        self.assertTrue((self.output / "trust-intent.json").exists())
        self.assertFalse((self.output / "trusted.json").exists())
        with self.assertRaisesRegex(ValueError, "incomplete_attempt"):
            self.run_registration()

    def test_permission_failure_is_not_retried(self):
        with patch.object(subject.trae_trust, "register", side_effect=PermissionError(13, "fixture")) as grant:
            with self.assertRaises(PermissionError):
                self.run_registration()
            self.assertEqual(grant.call_count, 1)
        self.assertFalse((self.output / "trusted.json").exists())

    def test_git_environment_override_refuses(self):
        self.env["GIT_CONFIG_COUNT"] = "1"
        with self.assertRaisesRegex(ValueError, "git_override"):
            self.run_registration()

    def test_input_drift_during_native_check_refuses(self):
        check = self.native.verify_runtime

        def changed(native):
            result = check(native)
            self.review.write_text("drift")
            return result

        with patch.object(self.native, "verify_runtime", changed), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.run_registration()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_drift_during_last_prewrite_check_never_grants(self):
        check = self.native.verify_runtime
        checks = 0

        def changed(native):
            nonlocal checks
            result = check(native)
            checks += 1
            if checks == 2:
                self.review.write_text("drift during last prewrite query")
            return result

        with patch.object(self.native, "verify_runtime", changed), \
                patch.object(subject.trae_trust, "register") as grant, \
                self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.run_registration()
        grant.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_wrong_workspace_in_receipt_cannot_be_reused(self):
        result = self.run_registration()
        receipt = Path(result["receipt"]["path"])
        value = json.loads(receipt.read_text())
        value["workspace"] = "other::/other"
        receipt.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "receipt_mismatch"):
            self.run_registration()

    def test_cli_requires_execute_and_delegates(self):
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = operator_prepare.main(["trust-workspace", "--input", "/unused", "--input-sha256", "0" * 64])
        self.assertEqual(code, 2)
        self.assertIn("explicit_execute_required", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
