import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import control_plane_readiness as readiness
from deploy import publish_control_plane as publisher


def write(path, text="x\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def skill(directory, name, declared=None):
    write(directory / name / "SKILL.md",
          "---\nname: %s\ndescription: test\n---\n\nbody\n" % (declared or name))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.directories = []

    def tearDown(self):
        for directory in self.directories:
            shutil.rmtree(directory, ignore_errors=True)

    def temporary(self):
        directory = tempfile.mkdtemp()
        self.directories.append(directory)
        return Path(directory)

    def source(self, code=True, model=True, profiles=True):
        root = self.temporary() / "orca_src"
        write(root / "AGENTS.md")
        write(root / "swarm-private-integration.md")
        write(root / "workspaces.json", "{}\n")
        write(root / "workspace-directory-policy.md")
        write(root / "swarm-orca" / "AGENTS.md")
        write(root / "swarm-orca" / "NOTICE.md")
        write(root / "swarm-orca" / "MIGRATION_STATUS.md")
        write(root / "swarm-orca" / "README.md")
        if code:
            write(root / "swarm-orca" / "swarm" / "coordinator_launch.py")
        if model:
            write(root / "swarm" / "coordinator-model.json", "{}\n")
        if profiles:
            write(root / "swarm" / "worker-model-profiles.json", "{}\n")
        write(root / "skills" / "runtime-selection.md")
        return root

    def artifact(self):
        artifacts = self.temporary()
        self.assertEqual(publisher.main(["publish", "--source-root", str(self.source()),
                                         "--artifact-root", str(artifacts),
                                         "--allow-unpinned-source"]), 0)
        return next(path for path in artifacts.iterdir() if path.is_dir() and not path.is_symlink())

    def skills(self, *names, declared=None):
        directory = self.temporary() / "skills-home"
        for name in names:
            skill(directory, name, declared)
        return directory

    def project(self, agents_md=True):
        project = self.temporary() / "project"
        project.mkdir()
        if agents_md:
            write(project / "AGENTS.md")
        return project

    def report(self, **overrides):
        values = {"project": str(self.project()),
                  "expect_config": [],
                  "pointer": str(self.temporary() / "no-pointer"),
                  "control_plane": None,
                  "agent": "agents",
                  "skills_dir": str(self.skills(*readiness.REQUIRED_SKILLS)),
                  "artifacts": None,
                  "require_pin": False}
        values.update(overrides)
        return readiness.report(SimpleNamespace(**values))


class ReadinessTests(Fixture):
    def test_released_artifact_with_project_material_is_ready(self):
        result = self.report(control_plane=str(self.artifact()))
        self.assertTrue(result["ready"], result["blocking"])
        self.assertEqual(result["controlPlane"]["state"], "ok")
        self.assertTrue(Path(result["plan"]["argv"][2]).is_file())
        self.assertIn("--model-config", result["plan"]["argv"])
        self.assertIn("unconfirmed", result["plan"]["maxWorkers"])
        self.assertEqual(result["plan"]["cwd"], result["project"]["path"])

    def test_a_dev_checkout_is_usable_for_trials_without_the_pin_flag(self):
        result = self.report(control_plane=str(self.source()))
        self.assertTrue(result["ready"], result["blocking"])
        self.assertEqual(result["controlPlane"]["state"], "dev-checkout")
        self.assertTrue(Path(result["plan"]["argv"][2]).is_file())

    def test_a_dev_checkout_is_refused_when_a_pin_is_required(self):
        result = self.report(control_plane=str(self.source()), require_pin=True)
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("control-plane-dev-checkout")
                            for item in result["blocking"]))
        self.assertIsNone(result["plan"])

    def test_a_missing_pointer_blocks_without_any_fallback(self):
        result = self.report()
        self.assertFalse(result["ready"])
        self.assertEqual(result["controlPlane"]["state"], "missing")
        self.assertIn("control-plane-missing: no pointer and no --control-plane", result["blocking"])

    def test_a_tampered_artifact_blocks(self):
        artifact = self.artifact()
        write(artifact / "code" / "coordinator_launch.py", "tampered\n")
        result = self.report(control_plane=str(artifact))
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("control-plane-invalid") for item in result["blocking"]))

    def test_a_relocated_artifact_blocks(self):
        moved = self.temporary() / "elsewhere"
        shutil.copytree(self.artifact(), moved)
        result = self.report(control_plane=str(moved))
        self.assertFalse(result["ready"])

    def test_project_without_agents_md_blocks_and_names_the_path(self):
        project = self.project(agents_md=False)
        result = self.report(project=str(project), control_plane=str(self.artifact()))
        self.assertFalse(result["ready"])
        self.assertIn("project-agents-missing: %s" % project, result["blocking"])

    def test_a_missing_skill_blocks_and_names_it(self):
        skills = self.skills(*readiness.REQUIRED_SKILLS[:-1])
        result = self.report(control_plane=str(self.artifact()), skills_dir=str(skills))
        self.assertFalse(result["ready"])
        self.assertIn("skills-missing: %s" % readiness.REQUIRED_SKILLS[-1], result["blocking"])

    def test_a_skill_with_the_wrong_name_blocks(self):
        skills = self.skills(*readiness.REQUIRED_SKILLS)
        skill(skills, "swarm-orchestration", declared="something-else")
        result = self.report(control_plane=str(self.artifact()), skills_dir=str(skills))
        self.assertFalse(result["ready"])
        self.assertIn("skills-name-mismatch: swarm-orchestration", result["blocking"])

    def test_missing_private_config_blocks(self):
        source = self.source(profiles=False)
        result = self.report(control_plane=str(source))
        self.assertFalse(result["ready"])
        self.assertIn("config-missing: worker-model-profiles.json", result["blocking"])

    def test_missing_launcher_blocks(self):
        result = self.report(control_plane=str(self.source(code=False)))
        self.assertFalse(result["ready"])
        self.assertIn("config-missing: coordinator_launch.py", result["blocking"])

    def test_a_non_control_plane_directory_is_invalid_not_a_dev_checkout(self):
        result = self.report(control_plane=str(self.temporary()))
        self.assertFalse(result["ready"])
        self.assertEqual(result["controlPlane"]["state"], "invalid")

    def test_report_is_read_only(self):
        project, artifact = self.project(), self.artifact()

        def snapshot():
            return [sorted(path.as_posix() for path in tree.rglob("*"))
                    for tree in (project, artifact)]

        before = snapshot()
        self.report(project=str(project), control_plane=str(artifact))
        self.assertEqual(before, snapshot())

    def test_a_pointer_to_a_dev_checkout_is_reported_as_dev_checkout(self):
        source, pointer = self.source(), self.temporary() / "current"
        pointer.symlink_to(source, target_is_directory=True)
        result = self.report(pointer=str(pointer))
        self.assertEqual(result["controlPlane"]["state"], "dev-checkout")
        self.assertTrue(result["ready"], result["blocking"])

    def test_require_pin_refuses_a_released_artifact_built_from_a_dirty_source(self):
        dirty = {"sourceRoot": "s", "orcaSrcCommit": "a", "orcaSrcBranch": "b",
                 "swarmOrcaCommit": "c", "swarmOrcaBranch": "d",
                 "dirty": True, "dirtyPaths": ["M docs/README.md"], "unpinned": False}
        artifacts = self.temporary()
        from unittest import mock
        with mock.patch.object(publisher, "source_state", return_value=dirty):
            self.assertEqual(publisher.main(["publish", "--source-root", str(self.source()),
                                             "--artifact-root", str(artifacts),
                                             "--allow-dirty"]), 0)
        artifact = next(path for path in artifacts.iterdir()
                        if path.is_dir() and not path.is_symlink())
        result = self.report(control_plane=str(artifact), require_pin=True)
        self.assertFalse(result["ready"])
        self.assertIn("control-plane-dirty: published from a modified source", result["blocking"])

    def test_require_pin_refuses_an_unpinned_released_artifact(self):
        result = self.report(control_plane=str(self.artifact()), require_pin=True)
        self.assertFalse(result["ready"])
        self.assertIn("control-plane-unpinned: published without a pinned source",
                      result["blocking"])

    def test_expected_config_hash_is_compared(self):
        artifact = self.artifact()
        good = readiness.sha256(artifact / "private" / "coordinator-model.json")
        ready = self.report(control_plane=str(artifact),
                            expect_config=["coordinator-model.json=%s" % good])
        self.assertTrue(ready["ready"], ready["blocking"])
        wrong = self.report(control_plane=str(artifact),
                            expect_config=["coordinator-model.json=%s" % ("0" * 64)])
        self.assertFalse(wrong["ready"])
        self.assertIn("config-hash-mismatch: coordinator-model.json", wrong["blocking"])
        unknown = self.report(control_plane=str(artifact),
                              expect_config=["other.json=%s" % ("0" * 64)])
        self.assertIn("config-unexpected: other.json", unknown["blocking"])

    def test_a_symlinked_code_directory_blocks(self):
        source = self.source()
        code = source / "swarm-orca" / "swarm"
        moved = source / "moved-code"
        code.rename(moved)
        code.symlink_to(moved, target_is_directory=True)
        result = self.report(control_plane=str(source))
        self.assertFalse(result["ready"])
        self.assertIn("config-symlink: %s" % code, result["blocking"])

    def test_a_malformed_expect_config_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as caught:
            readiness.main(["--project", str(self.project()),
                            "--expect-config", "coordinator-model.json"])
        self.assertEqual(caught.exception.code, 2)

    def test_main_exit_codes(self):
        artifact, skills = self.artifact(), self.skills(*readiness.REQUIRED_SKILLS)
        common = ["--project", str(self.project()), "--control-plane", str(artifact),
                  "--skills-dir", str(skills), "--json"]
        self.assertEqual(readiness.main(common), 0)
        self.assertEqual(readiness.main(["--project", str(self.project()),
                                         "--skills-dir", str(skills)]),
                         readiness.EXIT_BLOCKED)


if __name__ == "__main__":
    unittest.main()
