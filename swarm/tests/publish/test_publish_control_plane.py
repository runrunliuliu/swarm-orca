import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from deploy import publish_control_plane as publisher


def write(path, text="x\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


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

    def source(self, stubs=True):
        root = self.temporary() / "orca_src"
        if stubs:
            write(root / "swarm-orca" / "orca" / "skills" / "orca-cli" / "SKILL.md",
                  "---\nname: orca-cli\n---\n")
            write(root / "swarm-orca" / "orca" / "skills" / "orchestration" / "SKILL.md",
                  "---\nname: orchestration\n---\n")
        write(root / "AGENTS.md")
        write(root / "swarm-private-integration.md")
        write(root / "workspaces.json", "{}\n")
        write(root / "workspace-directory-policy.md")
        write(root / "swarm-orca" / "AGENTS.md")
        write(root / "swarm-orca" / "NOTICE.md")
        write(root / "swarm-orca" / "MIGRATION_STATUS.md")
        write(root / "swarm-orca" / "README.md")
        write(root / "swarm-orca" / "swarm" / "coordinator_launch.py")
        write(root / "swarm-orca" / "swarm" / "docs" / "entry-paths.md")
        write(root / "swarm-orca" / "swarm" / "tests" / "test_launch.py")
        write(root / "swarm-orca" / "swarm" / "__pycache__" / "launch.pyc")
        write(root / "swarm-orca" / "swarm" / ".pytest_cache" / "CACHEDIR.TAG")
        write(root / "swarm" / "coordinator-model.json", "{}\n")
        write(root / "swarm" / "docs" / "validation" / "report.md")
        write(root / "swarm" / "trials" / "trial.md")
        write(root / "swarm" / "__pycache__" / "model.pyc")
        write(root / "skills" / "runtime-selection.md")
        return root

    def plan_report(self, source):
        return publisher.plan(SimpleNamespace(source_root=str(source), artifact_root=None))


class PlanTests(Fixture):
    def test_plan_excludes_tests_caches_and_validation_and_counts_the_rest(self):
        report = self.plan_report(self.source())
        self.assertEqual(report["fileCount"], 14)
        self.assertIn("code/tests", report["excluded"])
        self.assertIn("private/docs/validation", report["excluded"])
        self.assertIn("private/trials", report["excluded"])
        self.assertNotIn("code/.pytest_cache/CACHEDIR.TAG", report["included"])
        self.assertNotIn("code/tests/test_launch.py", report["included"])
        self.assertIn("code/coordinator_launch.py", report["included"])

    def test_plan_carries_the_two_orca_stubs_into_code_skills(self):
        report = self.plan_report(self.source())
        self.assertIn("code/skills/orca-cli/SKILL.md", report["included"])
        self.assertIn("code/skills/orchestration/SKILL.md", report["included"])

    def test_a_missing_stub_directory_is_refused(self):
        with self.assertRaises(publisher.Failure):
            self.plan_report(self.source(stubs=False))

    def test_plan_is_read_only(self):
        source = self.source()
        before = sorted(path.as_posix() for path in source.rglob("*"))
        self.plan_report(source)
        self.assertEqual(before, sorted(path.as_posix() for path in source.rglob("*")))

    def test_build_id_is_content_addressed(self):
        source = self.source()
        first = self.plan_report(source)["buildId"]
        self.assertRegex(first, r"^[0-9a-f]{12}$")
        self.assertEqual(first, self.plan_report(source)["buildId"])
        write(source / "swarm-orca" / "swarm" / "coordinator_launch.py", "changed\n")
        self.assertNotEqual(first, self.plan_report(source)["buildId"])


class PublishTests(Fixture):
    def setUp(self):
        super().setUp()
        self.artifacts = self.temporary()

    def publish(self, source, *extra):
        return publisher.main(["publish", "--source-root", str(source),
                               "--artifact-root", str(self.artifacts)] + list(extra))

    def artifact_directories(self):
        return [path for path in self.artifacts.iterdir()
                if path.is_dir() and not path.is_symlink()]

    def test_publish_requires_an_artifact_root(self):
        with self.assertRaises(SystemExit) as caught:
            publisher.main(["publish", "--source-root", str(self.source())])
        self.assertEqual(caught.exception.code, 2)

    def test_unpinned_source_is_refused_until_allowed(self):
        source = self.source()
        self.assertEqual(self.publish(source), publisher.EXIT_PRECONDITION)
        self.assertEqual(list(self.artifacts.iterdir()), [])
        self.assertEqual(self.publish(source, "--allow-unpinned-source"), 0)

    def test_dirty_source_is_refused_until_allowed(self):
        state = {"sourceRoot": "s", "orcaSrcCommit": "a", "orcaSrcBranch": "b",
                 "swarmOrcaCommit": "c", "swarmOrcaBranch": "d",
                 "dirty": True, "dirtyPaths": ["M docs/README.md"], "unpinned": False}
        with mock.patch.object(publisher, "source_state", return_value=state):
            self.assertEqual(self.publish(self.source()), publisher.EXIT_PRECONDITION)
            self.assertEqual(list(self.artifacts.iterdir()), [])
            self.assertEqual(self.publish(self.source(), "--allow-dirty"), 0)

    def test_publish_writes_identity_and_manifest_and_switches_the_pointer(self):
        pointer = self.artifacts / "current"
        self.assertEqual(self.publish(self.source(), "--allow-unpinned-source",
                                      "--switch-pointer", str(pointer)), 0)
        artifact = self.artifact_directories()[0]
        identity = json.loads((artifact / publisher.IDENTITY).read_text(encoding="utf-8"))
        self.assertEqual(identity["artifact"], publisher.ARTIFACT)
        self.assertEqual(identity["installDir"], str(artifact.resolve()))
        self.assertTrue(identity["source"]["unpinned"])
        self.assertEqual(identity["copyRuleVersion"], publisher.COPY_RULE_VERSION)
        self.assertEqual(len((artifact / publisher.MANIFEST).read_text().splitlines()), 14)
        self.assertFalse((artifact / "code" / "tests").exists())
        self.assertEqual(pointer.resolve(), artifact.resolve())
        self.assertEqual(publisher.main(["verify", "--artifact", str(artifact)]), 0)

    def test_publish_refuses_an_existing_artifact(self):
        source = self.source()
        self.assertEqual(self.publish(source, "--allow-unpinned-source"), 0)
        self.assertEqual(self.publish(source, "--allow-unpinned-source"),
                         publisher.EXIT_PRECONDITION)

    def test_a_failure_after_copying_retains_the_staging_tree(self):
        source = self.source()
        self.assertEqual(self.publish(source, "--allow-unpinned-source"), 0)
        before = sorted(path.name for path in self.artifacts.iterdir())
        self.assertEqual(self.publish(source, "--allow-unpinned-source"),
                         publisher.EXIT_PRECONDITION)
        after = sorted(path.name for path in self.artifacts.iterdir())
        self.assertEqual(len(after), len(before) + 1)
        self.assertTrue(any(name.startswith(".%s-staging-" % publisher.ARTIFACT)
                            for name in after))

    def test_a_symbolic_link_in_the_source_is_refused(self):
        source = self.source()
        outside = self.temporary() / "secret.txt"
        write(outside)
        (source / "swarm-orca" / "swarm" / "linked.py").symlink_to(outside)
        self.assertEqual(self.publish(source, "--allow-unpinned-source"),
                         publisher.EXIT_PRECONDITION)
        self.assertEqual(list(self.artifacts.iterdir()), [])

    def test_private_files_do_not_inherit_the_umask(self):
        self.assertEqual(self.publish(self.source(), "--allow-unpinned-source"), 0)
        artifact = self.artifact_directories()[0]
        self.assertEqual((artifact / "private" / "coordinator-model.json").stat().st_mode & 0o777,
                         0o640)
        self.assertEqual((artifact / "private").stat().st_mode & 0o777, 0o750)
        self.assertEqual((artifact / "code" / "coordinator_launch.py").stat().st_mode & 0o777,
                         0o644)
        self.assertEqual((artifact / publisher.MANIFEST).stat().st_mode & 0o777, 0o644)


class VerifyTests(Fixture):
    def setUp(self):
        super().setUp()
        self.artifacts = self.temporary()
        self.assertEqual(publisher.main(["publish", "--source-root", str(self.source()),
                                         "--artifact-root", str(self.artifacts),
                                         "--allow-unpinned-source"]), 0)
        self.artifact = next(path for path in self.artifacts.iterdir()
                             if path.is_dir() and not path.is_symlink())

    def verify(self, artifact=None):
        return publisher.main(["verify", "--artifact", str(artifact or self.artifact)])

    def test_verify_accepts_a_freshly_published_artifact(self):
        self.assertEqual(self.verify(), 0)

    def test_verify_rejects_a_changed_file(self):
        write(self.artifact / "code" / "coordinator_launch.py", "tampered\n")
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_missing_file(self):
        (self.artifact / "private" / "coordinator-model.json").unlink()
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_an_extra_file(self):
        write(self.artifact / "code" / "injected.py")
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_changed_identity_build_id(self):
        path = self.artifact / publisher.IDENTITY
        identity = json.loads(path.read_text(encoding="utf-8"))
        identity["buildId"] = "000000000000"
        path.write_text(json.dumps(identity), encoding="utf-8")
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_changed_included_list(self):
        path = self.artifact / publisher.IDENTITY
        identity = json.loads(path.read_text(encoding="utf-8"))
        identity["included"].append("code/not-copied.py")
        path.write_text(json.dumps(identity), encoding="utf-8")
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_symbolic_link_inside_the_artifact(self):
        (self.artifact / "code" / "linked.py").symlink_to("/etc/hostname")
        self.assertEqual(self.verify(), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_renamed_artifact_directory(self):
        renamed = self.artifacts / "renamed"
        self.artifact.rename(renamed)
        self.assertEqual(self.verify(renamed), publisher.EXIT_PRECONDITION)

    def test_verify_rejects_a_relocated_artifact(self):
        moved = self.temporary() / "elsewhere"
        shutil.copytree(self.artifact, moved)
        self.assertEqual(self.verify(moved), publisher.EXIT_PRECONDITION)


if __name__ == "__main__":
    unittest.main()
