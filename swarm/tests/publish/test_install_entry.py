import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from deploy.publish_control_plane import ARTIFACT
from publish.test_install_control_plane import InstallerTests as InstallerFixture

REPO_SWARM = Path(__file__).resolve().parents[2]
ENTRY = REPO_SWARM / "deploy" / "install.sh"


def write(path, text="x\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class InstallEntryTests(unittest.TestCase):
    """install.sh is the discovery entry: it must find the workspace and then do nothing extra."""

    def setUp(self):
        self.directories = []

    def tearDown(self):
        for directory in self.directories:
            shutil.rmtree(directory, ignore_errors=True)

    def temporary(self):
        directory = tempfile.mkdtemp()
        self.directories.append(directory)
        return Path(directory)

    def checkout(self, workspace=True):
        """A checkout that carries its own copy of the deploy scripts."""
        root = self.temporary() / "workspace"
        if workspace:
            write(root / "swarm" / "coordinator-model.json", "{}\n")
            write(root / "swarm" / "worker-model-profiles.json", "{}\n")
            write(root / "skills" / "runtime-selection.md")
            write(root / "AGENTS.md")
            write(root / "swarm-private-integration.md")
            write(root / "workspaces.json", "{}\n")
            write(root / "workspace-directory-policy.md")
            for name in ("NOTICE.md", "MIGRATION_STATUS.md", "ARTIFACT.md"):
                write(root / "swarm-orca" / name)
            write(root / "swarm-orca" / "swarm" / "AGENTS.md")
            for stub in ("orca-cli", "orchestration"):
                write(root / "swarm-orca" / "orca" / "skills" / stub / "SKILL.md",
                      "---\nname: %s\n---\n" % stub)
            for skill in ("swarm-orchestration", "worktree-delivery"):
                write(root / "swarm-orca" / "swarm" / "skills" / skill / "SKILL.md",
                      "---\nname: %s\n---\n" % skill)
        deploy = root / "swarm-orca" / "swarm" / "deploy"
        deploy.mkdir(parents=True)
        for name in ("install.sh", "install-control-plane.sh", "publish_control_plane.py"):
            shutil.copyfile(REPO_SWARM / "deploy" / name, deploy / name)
        (deploy / "install.sh").chmod(0o755)
        (deploy / "install-control-plane.sh").chmod(0o755)
        return root / "swarm-orca" / "swarm" / "deploy" / "install.sh"

    def run_entry(self, script, *extra, timeout=120):
        environment = dict(os.environ)
        environment.pop("SWARM_INSTALL_PROBE", None)
        return subprocess.run(["bash", str(script)] + list(extra), capture_output=True,
                              text=True, env=environment, timeout=timeout)

    def test_it_detects_the_workspace_root_one_level_above_the_checkout(self):
        script = self.checkout()
        result = self.run_entry(script, "--allow-unpinned-source")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("detected workspace root", result.stdout)
        self.assertIn("Nothing was written", result.stdout)

    def test_a_standalone_clone_without_a_workspace_explains_what_to_pass(self):
        script = self.checkout(workspace=False)
        result = self.run_entry(script)
        self.assertEqual(result.returncode, 78)
        self.assertIn("cannot find the workspace root", result.stderr)
        self.assertIn("--source-root", result.stderr)

    def test_an_explicit_source_root_must_be_a_workspace(self):
        script = self.checkout(workspace=False)
        result = self.run_entry(script, "--source-root", str(self.temporary()))
        self.assertEqual(result.returncode, 78)
        self.assertIn("must contain swarm-orca/swarm, swarm/ and skills/", result.stderr)

    def test_a_missing_option_value_is_a_usage_error_not_a_hang(self):
        result = self.run_entry(self.checkout(), "--source-root", timeout=15)
        self.assertEqual(result.returncode, 78)
        self.assertIn("requires a value", result.stderr)

    def test_detection_refuses_a_workspace_that_does_not_own_this_checkout(self):
        workspace = self.temporary() / "workspace"
        write(workspace / "swarm" / "coordinator-model.json", "{}\n")
        write(workspace / "skills" / "x.md")
        write(workspace / "swarm-orca" / "AGENTS.md")
        write(workspace / "swarm-orca" / "swarm" / "coordinator_launch.py")
        # A renamed copy of the same scripts, one level away from a workspace it does not own.
        other = workspace / "swarm-orca-copy"
        deploy = other / "swarm" / "deploy"
        deploy.mkdir(parents=True)
        for name in ("install.sh", "install-control-plane.sh", "publish_control_plane.py"):
            shutil.copyfile(REPO_SWARM / "deploy" / name, deploy / name)
        (deploy / "install.sh").chmod(0o755)
        result = self.run_entry(deploy / "install.sh", "--allow-unpinned-source")
        self.assertEqual(result.returncode, 78)
        self.assertIn("does not own this checkout", result.stderr)

    def test_help_is_available_before_anything_else(self):
        result = self.run_entry(self.checkout(), "--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("first command to run on a new host", result.stdout.lower())

    def test_flags_reach_the_installer_unchanged(self):
        script = self.checkout()
        artifacts = self.temporary()
        result = self.run_entry(script, "--source-root", str(script.parents[3]),
                                "--artifact-root", str(artifacts), "--check",
                                "--allow-unpinned-source")
        # A missing host override is reported by the installer, which proves the flag arrived.
        self.assertEqual(result.returncode, 78)
        self.assertIn("host override missing", result.stderr)


class EntryApplyTests(InstallerFixture):
    """The entry point must reach the same result as calling the installer directly."""

    def run_via_entry(self, *extra):
        command = ["bash", str(ENTRY),
                   "--source-root", str(self.source),
                   "--artifact-root", str(self.artifacts),
                   "--pointer", str(self.pointer),
                   "--skills-dir", str(self.skills),
                   "--host-override", str(self.override),
                   "--allow-unpinned-source"] + list(extra)
        environment = dict(os.environ)
        environment.pop("SWARM_INSTALL_PROBE", None)
        return subprocess.run(command, capture_output=True, text=True, env=environment,
                              timeout=120)

    def test_apply_through_the_entry_point_publishes_and_links(self):
        result = self.run_via_entry("--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = sorted(path.name for path in self.artifacts.glob("%s-*" % ARTIFACT))
        self.assertEqual(len(names), 1)
        self.assertEqual(self.pointer.resolve().name, names[0])
        self.assertEqual(self.link_targets()["swarm-orchestration"],
                         "%s/code/skills/swarm-orchestration" % self.pointer)
        self.assertIn("converged", self.run_via_entry().stdout)


if __name__ == "__main__":
    unittest.main()
