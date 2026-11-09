"""Reviewed pre-launch material assembly only; no Agent, Run or gate."""

import json
from pathlib import Path
from contextlib import redirect_stdout
import io
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from coordinator_input import input_bytes
from coordinator_io import file_ref, parse, pinned
from coordinator_strict import MAX_AGENT_ARGS_BYTES
from operator_materials import assemble, main, verify_materials
from trae_coordinator import TUI_EXECUTION


class OperatorMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "baseline")
        self.directory = self.root / "materials"
        self.directory.mkdir(mode=0o700)
        self.cwd = self.root / "workspace"
        self.cwd.mkdir()
        self.archive = self.root / "archive"
        self.archive.mkdir()

        self.authority = self.ref("authority.txt", "original user authorization")
        self.acceptance = self.ref("acceptance.md", "accept when all checks pass")
        self.scope = self.ref("scope.md", "read/write scope")
        self.baseline = self.ref("baseline.json", {"schema_version": 1,
            "kind": "reviewed_baseline", "baselines": [{"name": "code", "path": str(self.repo),
                "head": self.git("rev-parse", "HEAD").strip(), "clean": True,
                "note": "fixture baseline"}]})
        self.reference = self.ref("reference.md", "exact reference")
        self.model = self.ref("coordinator-model.json", {
            "schema_version": 1, "scope": "swarm_coordinator_only",
            "selection": {"mode": "explicit", "agent": "codex", "model": "gpt-5",
                          "effort": "high", "max_mode": None}})
        self.runtime = self.ref("coordinator-runtime.json", {
            "schema_version": 1, "scope": "swarm_coordinator_only",
            "execution": {"sandbox_mode": "danger-full-access", "approval_policy": "never",
                          "no_daemon": True}})
        self.workspace = {"id": "workspace_test", "path": str(self.cwd)}
        self.task_source = self.ref("business-task.json", {
            "schema_version": 1, "kind": "strict_business_task", "workspace": self.workspace,
            "objective": "complete the reviewed task", "authorization_refs": [self.authority]})
        self.source = {
            "schema_version": 1, "assembly_id": "assembly-1", "directory": str(self.directory),
            "read_roots": [str(self.root)], "write_roots": [str(self.directory)],
            "task_source": self.task_source, "task_workspace": self.workspace,
            "recovery_note": "resume startup without changing the objective",
            "authority_refs": [self.authority], "acceptance_refs": [self.acceptance],
            "scope_refs": [self.scope], "baseline_refs": [self.baseline],
            "reference_refs": [self.reference],
            "launch": {"agent": "codex", "codex": sys.executable, "cwd": str(self.cwd),
                       "archive_dir": str(self.archive), "write_dirs": [str(self.archive)],
                       "model_config": self.model["path"], "runtime_config": self.runtime["path"]}}
        self.input = self.root / "assembly-input.json"
        self.input.write_text(json.dumps(self.source))
        self.input_ref = file_ref(self.input)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout

    def ref(self, name, value):
        target = self.root / name
        if isinstance(value, (dict, list)):
            target.write_text(json.dumps(value))
        else:
            target.write_text(value)
        return file_ref(target)

    def cli(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--input", self.input_ref["path"],
                         "--input-sha256", self.input_ref["sha256"], "--execute"])
        return code, json.loads(output.getvalue())

    def test_assembles_handoff_plan_dependencies_and_final_checklist(self):
        result = assemble(self.input_ref)
        self.assertEqual(result["status"], "ready_for_external_review")
        self.assertFalse(result["execution_authorized"])
        checklist = verify_materials(result["materials"])
        self.assertEqual(checklist["business_task"]["objective"], "complete the reviewed task")
        self.assertEqual(checklist["business_task"]["recovery_note"],
                         "resume startup without changing the objective")
        self.assertFalse(checklist["agent_started"])
        self.assertFalse(checklist["run_created"])
        self.assertFalse(checklist["gate_issued"])
        self.assertFalse(checklist["final_checklist_includes_self"])

        for artifact in checklist["artifacts"].values():
            pinned(artifact)
        handoff = pinned(checklist["artifacts"]["handoff"]).decode()
        self.assertIn("Reviewed Coordinator handoff", handoff)
        self.assertIn("complete the reviewed task", handoff)
        bound = parse(pinned(checklist["artifacts"]["bound_launch_plan"]))
        self.assertIn("input_contract", bound)
        self.assertEqual(bound["argv"][0], sys.executable)
        self.assertIsNone(bound["command"])

        deps = checklist["dependencies"]
        self.assertEqual(deps["authority_refs"], [self.authority])
        self.assertEqual(deps["task_authority_refs"], [self.authority])
        self.assertEqual(deps["acceptance_refs"], [self.acceptance])
        self.assertEqual(deps["scope_refs"], [self.scope])
        self.assertEqual(deps["baseline_refs"], [self.baseline])
        self.assertEqual(deps["reference_refs"], [self.reference])
        self.assertEqual(deps["launch_config_refs"], [self.model, self.runtime])

        final_ref = result["materials"]
        all_refs = [checklist["input"], checklist["input_snapshot"], *checklist["artifacts"].values()]
        for group in deps.values():
            all_refs.extend(group)
        for item in checklist["source_snapshots"]:
            all_refs.extend([item["source"], item["snapshot"]])
        self.assertNotIn(final_ref, all_refs)
        sources = {item["source"]["path"] for item in checklist["source_snapshots"]}
        self.assertEqual(sources, {ref["path"] for ref in (
            self.input_ref, self.task_source, self.authority, self.acceptance, self.scope,
            self.baseline, self.reference, self.model, self.runtime)})

    def test_input_or_authority_changes_reject_old_material_pin(self):
        result = assemble(self.input_ref)
        self.input.write_text(json.dumps({**self.source, "assembly_id": "assembly-2"}))
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            verify_materials(result["materials"])

    def test_stale_baseline_pin_rejects_before_generating_materials(self):
        baseline = parse(pinned(self.baseline))
        baseline["baselines"][0]["head"] = "a" * 40
        Path(self.baseline["path"]).write_text(json.dumps(baseline))
        self.baseline = file_ref(self.baseline["path"])
        self.source["baseline_refs"] = [self.baseline]
        self.input.write_text(json.dumps(self.source))
        self.input_ref = file_ref(self.input)

        with self.assertRaisesRegex(ValueError, "baseline_head_changed"):
            assemble(self.input_ref)
        self.assertEqual(list(self.directory.iterdir()), [])

        code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "baseline_head_changed")
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_exact_git_root_and_no_git_override_required_before_writes(self):
        subdir = self.repo / "subdir"
        subdir.mkdir()
        baseline = parse(pinned(self.baseline))
        baseline["baselines"][0]["path"] = str(subdir)
        Path(self.baseline["path"]).write_text(json.dumps(baseline))
        self.baseline = file_ref(self.baseline["path"])
        self.source["baseline_refs"] = [self.baseline]
        self.input.write_text(json.dumps(self.source))
        self.input_ref = file_ref(self.input)

        with self.assertRaisesRegex(ValueError, "git_root_mismatch"):
            assemble(self.input_ref)
        self.assertEqual(list(self.directory.iterdir()), [])

        baseline["baselines"][0]["path"] = str(self.repo)
        Path(self.baseline["path"]).write_text(json.dumps(baseline))
        self.baseline = file_ref(self.baseline["path"])
        self.source["baseline_refs"] = [self.baseline]
        self.input.write_text(json.dumps(self.source))
        self.input_ref = file_ref(self.input)
        with patch.dict("os.environ", GIT_DIR=str(self.repo / ".git")):
            with self.assertRaisesRegex(ValueError, "git_context_override"):
                assemble(self.input_ref)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_authority_must_match_task_source_and_unknown_task_fields_stop(self):
        self.source["authority_refs"] = [self.acceptance]
        self.input.write_text(json.dumps(self.source))
        with self.assertRaisesRegex(ValueError, "operator_materials_task_authority_missing"):
            assemble(file_ref(self.input))

        self.source["authority_refs"] = [self.authority]
        task = parse(pinned(self.task_source))
        task["scope_notes"] = "extra"
        task_path = Path(self.task_source["path"])
        task_path.write_text(json.dumps(task))
        self.source["task_source"] = file_ref(task_path)
        self.input.write_text(json.dumps(self.source))
        self.input_ref = file_ref(self.input)
        with self.assertRaisesRegex(ValueError, "strict_config_task_source_invalid"):
            assemble(self.input_ref)
        code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "strict_config_task_source_invalid")
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_registered_bootstrap_flag_reaches_the_launch_plan(self):
        # Without this the registered prompt is unreachable from the materials
        # path, and a plan assembled after registration evidence exists would be
        # rejected as strict_registered_bootstrap_required.
        from operator_materials import launch_kwargs
        kwargs = launch_kwargs({"agent": "trae", "trae": sys.executable, "cwd": str(self.cwd),
                                "model_config": "/m/model.json",
                                "trae_runtime_config": "/r/runtime.json",
                                "strict_coordinator": True, "registered_bootstrap": True},
                               self.directory / "handoff.md")
        self.assertTrue(kwargs["registered_bootstrap"])
        self.assertTrue(kwargs["strict_coordinator"])
        self.assertFalse(launch_kwargs({"agent": "trae", "trae": sys.executable, "cwd": str(self.cwd),
                                        "model_config": "/m/model.json",
                                        "trae_runtime_config": "/r/runtime.json"},
                                       self.directory / "handoff.md")["registered_bootstrap"])

    def test_realistic_trae_strict_tui_materials_keep_native_args_bounded(self):
        bootstrap = self.root / "bootstrap"
        bootstrap.mkdir()
        trae_model = self.ref("trae-coordinator-model.json", {
            "schema_version": 1, "scope": "swarm_coordinator_only",
            "selection": {"mode": "explicit", "agent": "trae", "model": "gpt-5.5",
                          "effort": "xhigh", "max_mode": True}})
        trae_runtime = self.ref("trae-runtime.json", {
            "schema_version": 1, "scope": "swarm_coordinator_only", "provider": "trae",
            "cli_version": "0.213.1", "execution": TUI_EXECUTION})
        long_task = self.ref("business-task-trae.json", {
            "schema_version": 1, "kind": "strict_business_task", "workspace": self.workspace,
            "objective": "complete the reviewed Trae strict TUI validation " + "验" * 4000,
            "authorization_refs": [self.authority]})
        self.source.update(
            assembly_id="assembly-trae-tui",
            task_source=long_task,
            launch={"agent": "trae", "trae": sys.executable, "cwd": str(self.cwd),
                    "bootstrap_dir": str(bootstrap), "write_dirs": [str(bootstrap)],
                    "model_config": trae_model["path"],
                    "trae_runtime_config": trae_runtime["path"],
                    "strict_coordinator": True})
        self.input.write_text(json.dumps(self.source))

        result = assemble(file_ref(self.input))
        checklist = verify_materials(result["materials"])
        self.assertFalse(checklist["agent_started"])
        self.assertFalse(checklist["run_created"])
        self.assertFalse(checklist["gate_issued"])
        bound = parse(pinned(checklist["artifacts"]["bound_launch_plan"]))
        self.assertEqual(bound["adapter"], "trae-tui-runtime-v1")
        self.assertEqual(bound["phase"], "strict-tui-bootstrap")
        self.assertEqual(bound["native_launch"]["method"], "terminal.create")
        self.assertFalse(bound["native_launch"]["stdin_required"])
        self.assertEqual(bound["native_launch"]["prompt_delivery"],
                         "pinned-files-short-prompt-v1")
        self.assertGreater(len(input_bytes(bound)), MAX_AGENT_ARGS_BYTES)
        self.assertLessEqual(len(bound["native_launch"]["agent_args"].encode()),
                             MAX_AGENT_ARGS_BYTES)


if __name__ == "__main__":
    unittest.main()
