import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import control_plane_readiness as readiness
from deploy import publish_control_plane as publisher


def socket_gethostname():
    import socket
    return socket.gethostname()


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

    def override(self, **overrides):
        import socket
        directory = self.temporary()
        artifacts, cli = self.temporary(), self.temporary() / "orca-server-cli"
        write(cli, "#!/bin/sh\n")
        cli.chmod(0o755)
        data = {
            "schemaVersion": 1,
            "label": "test-host",
            "hostnames": [socket.gethostname()],
            "verifiedOn": "2026-11-13",
            "paths": {"worktreeBase": str(directory), "artifactRoot": str(artifacts),
                      "serverCli": str(cli)},
            "runtime": {"default": "independent_servers.test", "legacy": "legacy_desktop"},
            "projectSetups": {"orca_src": "db11c9a3-0000-0000-0000-000000000000"},
        }
        data.update(overrides)
        return write(directory / "override.json", json.dumps(data))

    def report(self, **overrides):
        values = {"project": str(self.project()),
                  "expect_config": [],
                  "host_override": None,
                  "require_host_override": False,
                  "pointer": str(self.temporary() / "no-pointer"),
                  "control_plane": None,
                  "agent": "agents",
                  "skills_dir": str(self.skills(*readiness.REQUIRED_SKILLS)),
                  "artifacts": None,
                  "require_pin": False}
        values.update(overrides)
        # The default override path is host state: point it at an empty directory so a real
        # /opt/swarm/hosts file cannot decide what these assertions see.
        with mock.patch.dict(os.environ,
                             {"SWARM_HOST_OVERRIDE_DIR": str(self.temporary() / "no-hosts")}):
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

    def test_a_legacy_identity_artifact_is_not_a_pin_source(self):
        artifact = self.artifact()
        manifest = publisher.read_manifest(artifact)
        legacy = publisher.legacy_build_id(manifest)
        renamed = artifact.with_name("%s-%s" % (publisher.ARTIFACT, legacy))
        artifact.rename(renamed)
        identity_path = renamed / publisher.IDENTITY
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity.update(buildId=legacy, copyRuleVersion=2, installDir=str(renamed))
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        result = self.report(control_plane=str(renamed), require_pin=True)
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("control-plane-legacy-identity")
                            for item in result["blocking"]))

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

    def test_a_valid_host_override_supplies_the_local_paths(self):
        override = self.override()
        result = self.report(control_plane=str(self.artifact()), host_override=str(override))
        self.assertTrue(result["ready"], result["blocking"])
        self.assertEqual(result["hostOverride"]["state"], "ok")
        self.assertRegex(result["hostOverride"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(result["plan"]["paths"]["artifacts"]["source"], "host-override")
        self.assertEqual(result["plan"]["paths"]["serverCli"]["source"], "host-override")
        self.assertEqual(result["plan"]["runtime"],
                         {"default": "independent_servers.test", "source": "host-override"})

    def test_an_explicit_artifacts_flag_beats_the_override(self):
        explicit = self.temporary()
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override()),
                             artifacts=str(explicit))
        self.assertEqual(result["plan"]["paths"]["artifacts"],
                         {"value": str(explicit), "source": "explicit"})

    def test_an_explicit_override_that_does_not_exist_blocks(self):
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.temporary() / "absent.json"))
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("host-override-missing")
                            for item in result["blocking"]))

    def test_no_override_still_plans_a_generic_project(self):
        result = self.report(control_plane=str(self.artifact()))
        self.assertTrue(result["ready"], result["blocking"])
        self.assertEqual(result["hostOverride"]["state"], "missing")
        self.assertEqual(result["plan"]["paths"]["artifacts"], {"value": None, "source": "unset"})

    def test_requiring_the_override_blocks_when_absent(self):
        result = self.report(control_plane=str(self.artifact()), require_host_override=True)
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("host-override-missing")
                            for item in result["blocking"]))

    def test_a_foreign_hostname_blocks(self):
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(hostnames=["another-host"])))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-host-mismatch", " ".join(result["blocking"]))

    def test_an_unknown_key_blocks(self):
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(extra="not-allowed")))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-unknown-key: extra", result["blocking"])

    def test_a_relative_path_blocks(self):
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(
                                 paths={"artifactRoot": "relative/path"})))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-not-absolute: paths.artifactRoot", result["blocking"])

    def test_a_missing_directory_blocks(self):
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(
                                 paths={"worktreeBase": "/nonexistent/worktrees"})))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-path-missing: paths.worktreeBase", result["blocking"])

    def test_a_non_executable_server_cli_blocks(self):
        cli = write(self.temporary() / "cli", "#!/bin/sh\n")
        cli.chmod(0o644)
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(
                                 paths={"serverCli": str(cli)})))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-server-cli-not-executable: %s" % cli, result["blocking"])

    def test_a_hostname_string_cannot_match_by_substring(self):
        import socket
        result = self.report(control_plane=str(self.artifact()),
                             host_override=str(self.override(
                                 hostnames="%s-extra" % socket.gethostname())))
        self.assertFalse(result["ready"])
        self.assertTrue(any(item.startswith("host-override-invalid-value: hostnames")
                            for item in result["blocking"]))

    def test_hostnames_must_be_a_list_of_strings(self):
        for value in ({"a": 1}, [socket_gethostname(), 5], []):
            result = self.report(control_plane=str(self.artifact()),
                                 host_override=str(self.override(hostnames=value)))
            self.assertFalse(result["ready"])

    def test_a_malformed_nested_container_is_refused_not_raised(self):
        for key, value in (("paths", []), ("runtime", "x"), ("projectSetups", [])):
            result = self.report(control_plane=str(self.artifact()),
                                 host_override=str(self.override(**{key: value})))
            self.assertFalse(result["ready"])
            self.assertIn("host-override-invalid-value: %s" % key, result["blocking"])

    def test_duplicate_json_keys_are_refused(self):
        path = self.override()
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace('"label": "test-host",',
                                     '"label": "test-host", "label": "other",'), encoding="utf-8")
        result = self.report(control_plane=str(self.artifact()), host_override=str(path))
        self.assertFalse(result["ready"])
        self.assertIn("host-override-invalid-json: duplicate key 'label'", result["blocking"])

    def test_a_symlinked_path_is_refused_and_the_target_is_reported(self):
        real = self.temporary() / "real-artifacts"
        real.mkdir()
        link = self.temporary() / "linked-artifacts"
        link.symlink_to(real, target_is_directory=True)
        blocked = self.report(control_plane=str(self.artifact()),
                              host_override=str(self.override(paths={"artifactRoot": str(link)})))
        self.assertFalse(blocked["ready"])
        self.assertIn("host-override-symlink: paths.artifactRoot", blocked["blocking"])
        ok = self.report(control_plane=str(self.artifact()))
        self.assertEqual(ok["hostOverride"]["pathsResolved"], {})

    def test_the_override_reports_resolved_paths(self):
        override = self.override()
        result = self.report(control_plane=str(self.artifact()), host_override=str(override))
        resolved = result["hostOverride"]["pathsResolved"]
        for key in ("worktreeBase", "artifactRoot", "serverCli"):
            self.assertTrue(resolved[key].startswith("/"))

    def test_main_exit_codes(self):
        artifact, skills = self.artifact(), self.skills(*readiness.REQUIRED_SKILLS)
        common = ["--project", str(self.project()), "--control-plane", str(artifact),
                  "--skills-dir", str(skills), "--json"]
        self.assertEqual(readiness.main(common), 0)
        absent = self.temporary() / "absent-pointer"
        self.assertEqual(readiness.main(["--project", str(self.project()),
                                         "--pointer", str(absent),
                                         "--skills-dir", str(skills)]),
                         readiness.EXIT_BLOCKED)


if __name__ == "__main__":
    unittest.main()
