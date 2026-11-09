import copy
import fcntl
import os
from pathlib import Path
import pwd
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError, validate
from supervisor import trae_trust as trust
from core.test_supervisor import config


@unittest.skipIf(trust.tomllib is None, "optional trust feature requires Python 3.11+")
class TrustTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.directory = self.home / ".trae"
        self.directory.mkdir()
        self.workspace = self.root / 'workspaces' / 'worker "quoted" 中文'
        self.workspace.mkdir(parents=True)
        self.target = self.directory / "traecli.toml"
        self.original = b'# keep comments\nmodel = "existing"\n[hooks]\nreviewed_hash = "keep-exactly"\n'
        self.target.write_bytes(self.original)
        self.target.chmod(0o600)
        self.policy = {"enabled": True, "hostname": "worker-host", "username": "worker",
                       "trae_home": str(self.directory), "launch_context_confirmed": True}
        self.env = {"HOME": str(self.home)}
        user = pwd.struct_passwd(("worker", "x", os.geteuid(), os.getgid(), "", str(self.home), "/bin/sh"))
        for patcher in (patch.object(trust.sys, "platform", "linux"),
                        patch.object(trust.socket, "gethostname", return_value="worker-host"),
                        patch.object(trust.pwd, "getpwuid", return_value=user)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def register(self, workspace=None):
        return trust.register(self.policy, self.workspace if workspace is None else workspace, self.env)

    def test_preserves_bytes_and_hooks_and_is_idempotent(self):
        self.assertTrue(self.register()["changed"])
        after = self.target.read_bytes()
        self.assertTrue(after.startswith(self.original))
        data = trust.parse(after)
        self.assertEqual(data["projects"], {str(self.workspace): {"trust_level": "trusted"}})
        self.assertEqual(data["hooks"], {"reviewed_hash": "keep-exactly"})
        self.assertFalse(self.register()["changed"])
        self.assertEqual(self.target.read_bytes(), after)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_missing_file_is_created_private(self):
        self.target.unlink()
        self.register()
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_wrong_account_host_home_and_config_refused(self):
        for mutation in (lambda: self.policy.update(username="other"),
                         lambda: self.policy.update(hostname="Mac"),
                         lambda: self.env.update(HOME="/other/home"),
                         lambda: self.env.update(TRAE_HOME="/other/.trae"),
                         lambda: self.policy.update(launch_context_confirmed=False)):
            policy, env = copy.deepcopy(self.policy), copy.deepcopy(self.env)
            mutation()
            with self.assertRaises(SafetyError):
                self.register()
            self.policy, self.env = policy, env
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_macos_and_missing_tomllib_refused(self):
        with patch.object(trust.sys, "platform", "darwin"), self.assertRaises(SafetyError):
            self.register()
        with patch.object(trust, "tomllib", None), self.assertRaises(SafetyError):
            self.register()

    def test_root_home_ancestor_and_config_refused(self):
        for path in (Path("/"), self.home, self.home.parent, self.directory):
            with self.subTest(path=path), self.assertRaises(SafetyError):
                self.register(path)
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_symlink_workspace_and_noncanonical_paths_refused(self):
        link = self.root / "linked-workspace"
        link.symlink_to(self.workspace, target_is_directory=True)
        for path in (link, str(self.workspace) + "/..", str(self.workspace) + "/*"):
            with self.subTest(path=path), self.assertRaises(SafetyError):
                self.register(path)

    def test_symlink_config_and_config_home_refused(self):
        saved = self.directory / "original.toml"
        self.target.rename(saved)
        self.target.symlink_to(saved)
        with self.assertRaises(OSError):
            self.register()
        self.assertEqual(saved.read_bytes(), self.original)
        link = self.root / "linked-trae"
        link.symlink_to(self.directory, target_is_directory=True)
        self.policy["trae_home"] = str(link)
        self.env["TRAE_HOME"] = str(link)
        with self.assertRaises(SafetyError):
            self.register()

    def test_unsafe_permissions_refused(self):
        for path, mode in ((self.target, 0o644), (self.directory, 0o777), (self.workspace, 0o777)):
            before = path.stat().st_mode & 0o777
            path.chmod(mode)
            with self.subTest(path=path), self.assertRaises(SafetyError):
                self.register()
            path.chmod(before)

    def test_existing_deny_or_incomplete_project_is_not_overwritten(self):
        import json
        for value in ('trust_level = "untrusted"', 'description = "existing"'):
            data = ('[projects.' + json.dumps(str(self.workspace), ensure_ascii=False) + ']\n' + value).encode()
            self.target.write_bytes(data)
            with self.assertRaises(SafetyError):
                self.register()
            self.assertEqual(self.target.read_bytes(), data)

    def test_malformed_or_nonextendable_toml_refused(self):
        for data in (b'secret = "SENSITIVE\n', b'projects = []', b'projects = {}'):
            self.target.write_bytes(data)
            with self.assertRaises(SafetyError) as error:
                self.register()
            self.assertNotIn("SENSITIVE", str(error.exception))
            self.assertEqual(self.target.read_bytes(), data)

    def test_lock_contention_prevents_write(self):
        with open(self.directory / ".swarm-trust.lock", "w") as stream:
            os.chmod(stream.name, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(SafetyError, "another Swarm"):
                self.register()
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_external_edit_before_replace_is_not_lost(self):
        original_snapshot = trust.snapshot
        calls = 0

        def changed(path):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.target.write_bytes(self.original + b'new_setting = true\n')
            return original_snapshot(path)

        with patch.object(trust, "snapshot", side_effect=changed), self.assertRaises(SafetyError):
            self.register()
        self.assertEqual(self.target.read_bytes(), self.original + b'new_setting = true\n')
        self.assertEqual(list(self.directory.glob(".swarm-trust-*")), [])

    def test_write_failure_preserves_original(self):
        with patch.object(trust.os, "replace", side_effect=OSError("write failed")), self.assertRaises(OSError):
            self.register()
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertEqual(list(self.directory.glob(".swarm-trust-*")), [])

    def test_sequential_projects_preserve_each_other(self):
        second = self.workspace.parent / "second"
        second.mkdir()
        self.register()
        self.register(second)
        self.assertEqual(set(trust.parse(self.target.read_bytes())["projects"]), {str(self.workspace), str(second)})

    def test_policy_requires_explicit_context_confirmation(self):
        c = config(self.root)
        c["trae_workspace_trust"] = self.policy
        validate(c)
        for field in ("hostname", "username", "trae_home", "launch_context_confirmed"):
            bad = copy.deepcopy(c)
            del bad["trae_workspace_trust"][field]
            with self.subTest(field=field), self.assertRaises(SafetyError):
                validate(bad)
