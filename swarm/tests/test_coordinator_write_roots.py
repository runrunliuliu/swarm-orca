from pathlib import Path
import tempfile
import unittest

from coordinator_write_roots import observe_write_roots


class WriteRootObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cwd = self.root / "workspace"
        self.archive = self.root / "archive"
        self.other = self.root / "workspace-other"
        for folder in (self.cwd, self.archive, self.other):
            folder.mkdir()
        self.policy = {"type": "workspace-write", "writable_roots": [str(self.archive)]}

    def test_cwd_is_implicit_without_removing_it_from_required_roots(self):
        required = [str(self.cwd), str(self.archive)]
        result = observe_write_roots(self.cwd, self.policy, required)
        self.assertEqual(result["required_roots"], required)
        self.assertEqual(result["implicit_cwd"], str(self.cwd))
        self.assertFalse(result["file_tool_probe_verified"])

    def test_missing_external_root_and_prefix_sibling_remain_refused(self):
        for required in ([str(self.other)], [str(self.cwd), str(self.archive), str(self.other)]):
            with self.subTest(required=required), self.assertRaisesRegex(ValueError, "roots missing"):
                observe_write_roots(self.cwd, self.policy, required)

    def test_alias_and_malformed_policy_are_not_permission_evidence(self):
        alias = self.root / "alias"
        alias.symlink_to(self.archive, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "canonical"):
            observe_write_roots(self.cwd, self.policy, [str(alias)])
        for value in (None, str(self.archive), [None]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                observe_write_roots(self.cwd, {**self.policy, "writable_roots": value}, [str(self.cwd)])

    def test_read_only_cannot_gain_implicit_write_access(self):
        with self.assertRaisesRegex(ValueError, "workspace-write"):
            observe_write_roots(self.cwd, {"type": "read-only", "writable_roots": []}, [str(self.cwd)])


if __name__ == "__main__":
    unittest.main()
