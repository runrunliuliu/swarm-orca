import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path

from deploy.publish_control_plane import ARTIFACT

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "install-control-plane.sh"


def write(path, text="x\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directories = []
        self.root = self.temporary()
        self.source = self.root / "orca_src"
        write(self.source / "AGENTS.md")
        write(self.source / "swarm-private-integration.md")
        write(self.source / "workspaces.json", "{}\n")
        write(self.source / "workspace-directory-policy.md")
        for name in ("AGENTS.md", "NOTICE.md", "MIGRATION_STATUS.md", "README.md"):
            write(self.source / "swarm-orca" / name)
        write(self.source / "swarm-orca" / "swarm" / "coordinator_launch.py")
        # The installer is what these tests cover; readiness has its own module tests. The stub
        # exits 0 so the plan/link/apply/rollback paths are what fail when they fail.
        write(self.source / "swarm-orca" / "swarm" / "control_plane_readiness.py",
              "import sys\nsys.exit(0)\n")
        write(self.source / "swarm-orca" / "swarm" / "deploy" / "publish_control_plane.py")
        write(self.source / "swarm-orca" / "orca" / "skills" / "orca-cli" / "SKILL.md",
              "---\nname: orca-cli\n---\n")
        write(self.source / "swarm-orca" / "orca" / "skills" / "orchestration" / "SKILL.md",
              "---\nname: orchestration\n---\n")
        write(self.source / "swarm" / "coordinator-model.json", "{}\n")
        write(self.source / "swarm" / "worker-model-profiles.json", "{}\n")
        write(self.source / "skills" / "runtime-selection.md")
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.skills = self.root / "skills-home"
        self.skills.mkdir()
        self.pointer = self.artifacts / "current"
        self.override = self.write_override()

    def tearDown(self):
        for directory in self.directories:
            shutil.rmtree(directory, ignore_errors=True)

    def temporary(self):
        directory = tempfile.mkdtemp()
        self.directories.append(directory)
        return Path(directory)

    def write_override(self):
        cli = write(self.root / "bin" / "orca-server-cli", "#!/bin/sh\n")
        cli.chmod(0o755)
        return write(self.artifacts / "hosts" / ("%s.json" % socket.gethostname()), json.dumps({
            "schemaVersion": 1,
            "label": "test",
            "hostnames": [socket.gethostname()],
            "verifiedOn": "2026-11-13",
            "paths": {"worktreeBase": str(self.root), "artifactRoot": str(self.artifacts),
                      "serverCli": str(cli)},
            "runtime": {"default": "independent_servers.test", "legacy": "legacy_desktop"},
            "projectSetups": {"test": "0000"},
        }))

    def run_installer(self, *extra, env=None):
        command = ["bash", str(SCRIPT),
                   "--source-root", str(self.source),
                   "--artifact-root", str(self.artifacts),
                   "--pointer", str(self.pointer),
                   "--skills-dir", str(self.skills),
                   "--host-override", str(self.override),
                   "--allow-unpinned-source"] + list(extra)
        environment = dict(os.environ)
        environment.pop("SWARM_INSTALL_PROBE", None)
        environment.update(env or {})
        return subprocess.run(command, capture_output=True, text=True, env=environment)

    def artifact_names(self):
        return sorted(path.name for path in self.artifacts.glob("%s-*" % ARTIFACT))

    # ------------------------------------------------------------------ tests

    def test_a_dry_run_reports_the_plan_and_writes_nothing(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("will publish", result.stdout)
        self.assertEqual(self.artifact_names(), [])
        self.assertEqual(list(self.skills.iterdir()), [])
        self.assertFalse(self.pointer.exists())

    def test_apply_publishes_links_and_verifies(self):
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = self.artifact_names()
        self.assertEqual(len(names), 1)
        self.assertEqual(self.pointer.resolve().name, names[0])
        for skill in ("orca-cli", "orchestration", "swarm-orchestration", "worktree-delivery"):
            entry = self.skills / skill
            self.assertTrue(entry.is_symlink(), skill)
            self.assertEqual(entry.readlink().as_posix(), "%s/code/skills/%s" % (self.pointer, skill))

    def test_a_second_apply_is_idempotent(self):
        self.assertEqual(self.run_installer("--apply").returncode, 0)
        again = self.run_installer("--apply")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(len(self.artifact_names()), 1)
        self.assertIn("converged", again.stdout)

    def test_a_missing_host_override_stops_with_a_template(self):
        self.override.unlink()
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 78)
        self.assertIn("host override missing", result.stderr)
        self.assertIn('"hostnames"', result.stderr)
        self.assertEqual(self.artifact_names(), [])

    def test_an_unpinned_source_needs_the_flag(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--source-root", str(self.source),
             "--artifact-root", str(self.artifacts), "--pointer", str(self.pointer),
             "--skills-dir", str(self.skills), "--host-override", str(self.override)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 78)
        self.assertIn("--allow-unpinned-source", result.stderr)

    def test_an_existing_real_directory_is_not_replaced(self):
        write(self.skills / "swarm-orchestration" / "SKILL.md", "---\nname: local\n---\n")
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 78)
        self.assertIn("refusing to replace", result.stderr)
        self.assertEqual(self.artifact_names(), [])

    def test_a_failed_probe_restores_the_previous_pointer(self):
        previous = self.root / "previous-artifact"
        previous.mkdir()
        self.pointer.symlink_to(previous)
        result = self.run_installer("--apply", env={"SWARM_INSTALL_PROBE": "/bin/false"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("readiness failed", result.stderr)
        self.assertEqual(self.pointer.resolve(), previous.resolve())
        self.assertIn("pointer restored", result.stderr)

    def test_skip_skills_leaves_the_directory_alone(self):
        result = self.run_installer("--apply", "--skip-skills")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.skills.iterdir()), [])
        self.assertEqual(len(self.artifact_names()), 1)


if __name__ == "__main__":
    unittest.main()
