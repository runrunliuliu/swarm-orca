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

PROBE = '''import sys

args = sys.argv[1:]
# The installer probes the artifact directly before the switch (`--control-plane`), then the
# installed paths afterwards; the two exit codes let a test fail exactly one of them.
pre, post = {pre}, {post}
sys.exit(pre if "--control-plane" in args else post)
'''


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
        for skill in ("swarm-orchestration", "worktree-delivery"):
            write(self.source / "swarm-orca" / "swarm" / "skills" / skill / "SKILL.md",
                  "---\nname: %s\n---\n" % skill)
        # The artifact carries the real tools, so the installer's probes validate for real. Tests
        # that need a specific exit code replace readiness with the stub below.
        repo_swarm = Path(__file__).resolve().parents[2]
        shutil.copyfile(repo_swarm / "control_plane_readiness.py",
                        self.source / "swarm-orca" / "swarm" / "control_plane_readiness.py")
        write(self.source / "swarm-orca" / "swarm" / "deploy" / "__init__.py", "")
        shutil.copyfile(repo_swarm / "deploy" / "publish_control_plane.py",
                        self.source / "swarm-orca" / "swarm" / "deploy" / "publish_control_plane.py")
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

    def probe_stub(self, pre=0, post=0):
        """Replace readiness with a stub: only exit codes the real tool cannot produce on demand."""
        write(self.source / "swarm-orca" / "swarm" / "control_plane_readiness.py",
              PROBE.format(pre=pre, post=post))

    def write_override(self, **overrides):
        cli = write(self.root / "bin" / "orca-server-cli", "#!/bin/sh\n")
        cli.chmod(0o755)
        data = {
            "schemaVersion": 1,
            "label": "test",
            "hostnames": [socket.gethostname()],
            "verifiedOn": "2026-11-13",
            "paths": {"worktreeBase": str(self.root), "artifactRoot": str(self.artifacts),
                      "serverCli": str(cli)},
            "runtime": {"default": "independent_servers.test", "legacy": "legacy_desktop"},
            "projectSetups": {"test": "0000"},
        }
        data.update(overrides)
        return write(self.artifacts / "hosts" / ("%s.json" % socket.gethostname()),
                     json.dumps(data))

    def run_installer(self, *extra, timeout=120):
        command = ["bash", str(SCRIPT),
                   "--source-root", str(self.source),
                   "--artifact-root", str(self.artifacts),
                   "--pointer", str(self.pointer),
                   "--skills-dir", str(self.skills),
                   "--host-override", str(self.override),
                   "--allow-unpinned-source"] + list(extra)
        environment = dict(os.environ)
        environment.pop("SWARM_INSTALL_PROBE", None)
        return subprocess.run(command, capture_output=True, text=True, env=environment,
                              timeout=timeout)

    def artifact_names(self):
        return sorted(path.name for path in self.artifacts.glob("%s-*" % ARTIFACT))

    def link_targets(self):
        return {entry.name: os.readlink(entry) for entry in self.skills.iterdir()}

    # ------------------------------------------------------------------ tests

    def test_a_dry_run_reports_the_plan_and_writes_nothing(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("will publish", result.stdout)
        self.assertEqual(self.artifact_names(), [])
        self.assertEqual(self.link_targets(), {})
        self.assertFalse(self.pointer.exists())

    def test_check_is_an_explicit_alias_for_the_read_only_mode(self):
        result = self.run_installer("--check")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("read-only", result.stdout)
        self.assertEqual(self.artifact_names(), [])

    def test_apply_publishes_links_and_verifies(self):
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        names = self.artifact_names()
        self.assertEqual(len(names), 1)
        self.assertEqual(self.pointer.resolve().name, names[0])
        for skill in ("orca-cli", "orchestration", "swarm-orchestration", "worktree-delivery"):
            self.assertEqual(self.link_targets()[skill], "%s/code/skills/%s" % (self.pointer, skill))

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

    def test_the_template_is_asked_for_before_a_missing_artifact_root(self):
        self.override.unlink()
        missing = self.root / "not-created"
        result = subprocess.run(
            ["bash", str(SCRIPT), "--source-root", str(self.source),
             "--artifact-root", str(missing), "--pointer", str(missing / "current"),
             "--skills-dir", str(self.skills), "--host-override", str(missing / "hosts" / "h.json"),
             "--allow-unpinned-source"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 78)
        self.assertIn("host override missing", result.stderr)

    def test_an_unpinned_source_needs_the_flag(self):
        command = ["bash", str(SCRIPT), "--source-root", str(self.source),
                   "--artifact-root", str(self.artifacts), "--pointer", str(self.pointer),
                   "--skills-dir", str(self.skills), "--host-override", str(self.override)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 78)
        self.assertIn("--allow-unpinned-source", result.stderr)

    def test_a_missing_option_value_is_a_usage_error_not_a_hang(self):
        result = subprocess.run(["bash", str(SCRIPT), "--source-root"],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 78)
        self.assertIn("requires a value", result.stderr)

    def test_an_existing_real_directory_is_not_replaced(self):
        write(self.skills / "swarm-orchestration" / "SKILL.md", "---\nname: local\n---\n")
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 78)
        self.assertIn("refusing to replace", result.stderr)
        self.assertEqual(self.artifact_names(), [])

    def test_an_unmanaged_symlink_is_refused_unless_forced(self):
        local = self.root / "my-own-skill"
        local.mkdir()
        (self.skills / "orca-cli").symlink_to(local)
        refused = self.run_installer("--apply")
        self.assertEqual(refused.returncode, 78)
        self.assertIn("does not manage", refused.stderr)
        self.assertEqual(self.artifact_names(), [])
        forced = self.run_installer("--apply", "--force-links")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertEqual(self.link_targets()["orca-cli"],
                         "%s/code/skills/orca-cli" % self.pointer)

    def test_a_failed_artifact_probe_never_touches_the_pointer(self):
        self.probe_stub(pre=1, post=0)
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("failed the readiness probe", result.stderr)
        self.assertFalse(self.pointer.exists())
        self.assertEqual(self.link_targets(), {})

    def test_a_failed_post_switch_probe_removes_a_new_pointer(self):
        self.probe_stub(pre=0, post=1)
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        self.assertFalse(self.pointer.exists(), "a first install must not keep a failed pointer")
        self.assertEqual(self.link_targets(), {})

    def test_a_failed_post_switch_probe_restores_the_previous_pointer_and_links(self):
        self.assertEqual(self.run_installer("--apply").returncode, 0)
        first = os.readlink(self.pointer)
        before = self.link_targets()
        write(self.source / "swarm" / "coordinator-model.json", '{"changed": true}\n')
        self.probe_stub(pre=0, post=1)
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.pointer), first)
        self.assertEqual(self.link_targets(), before)

    def test_an_override_for_another_host_blocks_before_any_write(self):
        self.assertEqual(self.run_installer("--apply").returncode, 0)
        published = self.artifact_names()
        write(self.source / "swarm" / "coordinator-model.json", '{"changed": true}\n')
        self.write_override(hostnames=["some-other-host"])
        result = self.run_installer("--apply")
        self.assertEqual(result.returncode, 78)
        self.assertIn("pre-flight check failed", result.stderr)
        self.assertEqual(self.artifact_names(), published, "nothing new may be published")

    def test_a_failed_switch_restores_managed_previous_links(self):
        """Links that pointed at another artifact layout are restored, not left on the new one."""
        self.assertEqual(self.run_installer("--apply").returncode, 0)
        first = os.readlink(self.pointer)
        manual = self.artifacts / "manual" / "code" / "skills"
        for skill in ("orca-cli", "orchestration", "swarm-orchestration", "worktree-delivery"):
            write(manual / skill / "SKILL.md", "---\nname: %s\n---\n" % skill)
            entry = self.skills / skill
            entry.unlink()
            entry.symlink_to(manual / skill)
        before = self.link_targets()
        write(self.source / "swarm" / "coordinator-model.json", '{"changed": true}\n')
        self.probe_stub(pre=0, post=1)
        result = self.run_installer("--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rolling back", result.stderr)
        self.assertEqual(os.readlink(self.pointer), first)
        self.assertEqual(self.link_targets(), before)

    def test_skip_skills_leaves_the_directory_alone(self):
        result = self.run_installer("--apply", "--skip-skills")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.link_targets(), {})
        self.assertEqual(len(self.artifact_names()), 1)


if __name__ == "__main__":
    unittest.main()
