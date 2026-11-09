import json
import shlex
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned
from coordinator_input import input_bytes
from coordinator_strict import strict_plan
from coordinator_write_roots import observe_write_roots
from operator_archive import prepare
from trae_coordinator import TUI_EXECUTION, build_trae_plan


class OperatorArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.cwd, self.bootstrap, self.archive, self.output = [self.root / name for name in
                                                               ("worktree", "bootstrap", "task-archive", "attempt")]
        for directory in (self.cwd, self.bootstrap, self.archive, self.output):
            directory.mkdir(mode=0o700)
        runtime = self.root / "runtime.json"
        runtime.write_text(json.dumps(dict(schema_version=1, scope="swarm_coordinator_only", provider="trae",
                                          cli_version="0.212.1", execution=TUI_EXECUTION)))
        prompt = self.root / "prompt.md"
        prompt.write_text("FIXTURE ONLY, no execution authority")
        self.plan = strict_plan(build_trae_plan(trae=sys.executable, cwd=self.cwd,
            archive_dir=None, write_dirs=[], bootstrap_dir=self.bootstrap, resume_session=None,
            prompt_file=prompt, runtime_config=runtime, selection=dict(mode="explicit", agent="trae",
                model="gpt-5.5", effort="xhigh", max_mode=True)))
        plan = self.root / "initial-plan.json"
        plan.write_text(json.dumps(self.plan))
        self.spec = dict(schema_version=1, directory=str(self.output), read_roots=[str(self.root)],
                         write_roots=[str(self.output), str(self.archive)], launch_plan=file_ref(plan),
                         archive_parent=str(self.archive))
        self.save()

    def save(self):
        target = self.root / "archive-input.json"
        target.write_text(json.dumps(self.spec))
        self.ref = file_ref(target)

    def test_adds_task_parent_and_retains_old_plan_and_audit_probe_boundaries(self):
        original = pinned(self.spec["launch_plan"])
        with patch("trae_coordinator.native") as native:
            result = prepare(self.ref)
        native.assert_not_called()
        plan = parse(pinned(result["launch_plan"]))
        self.assertEqual(plan["task_write_roots"], [str(self.bootstrap), str(self.archive)])
        args = shlex.split(plan["native_launch"]["agent_args"])
        self.assertIn(str(self.archive), [args[i + 1] for i, v in enumerate(args) if v == "--add-dir"])
        self.assertIn(str(self.archive), plan["task_write_roots"])
        self.assertIn(str(self.archive).encode(), input_bytes(plan))
        self.assertEqual(pinned(self.spec["launch_plan"]), original)
        self.assertFalse(result["file_tool_probe_verified"])
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(result["status"], "awaiting_external_audit")
        self.assertIsNone(result["run_id"])
        with self.assertRaisesRegex(ValueError, "write roots missing"):
            observe_write_roots(str(self.cwd), dict(type="workspace-write", writable_roots=[str(self.bootstrap)]),
                                result["required_session_write_roots"])
        observed = observe_write_roots(str(self.cwd), dict(type="workspace-write", writable_roots=plan["task_write_roots"]),
                                       result["required_session_write_roots"])
        self.assertFalse(observed["file_tool_probe_verified"])

    def test_shared_ancestor_rejected_even_with_broad_scope(self):
        self.spec.update(archive_parent=str(self.root), write_roots=[str(self.root)])
        self.save()
        with self.assertRaisesRegex(ValueError, "overlap|too_broad"):
            prepare(self.ref)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_repeated_attempt_no_overwrite(self):
        prepare(self.ref)
        before = {p.name: p.read_bytes() for p in self.output.iterdir()}
        with self.assertRaisesRegex(ValueError, "attempt_not_empty"):
            prepare(self.ref)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.output.iterdir()})

    def test_unapproved_directory_or_changed_plan_fails_before_writes(self):
        self.spec["write_roots"] = [str(self.output)]
        self.save()
        with self.assertRaisesRegex(ValueError, "outside_write_scope"):
            prepare(self.ref)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_directory_permissions_are_not_repaired(self):
        self.archive.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private_archive_directory_required"):
            prepare(self.ref)
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o755)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_plan_drift_rejected_without_changing_source(self):
        self.plan["native_launch"]["agent_args"] += " --bad"
        target = Path(self.spec["launch_plan"]["path"])
        target.write_text(json.dumps(self.plan))
        self.spec["launch_plan"] = file_ref(target)
        self.save()
        with self.assertRaisesRegex(ValueError, "strict_native_plan_changed"):
            prepare(self.ref)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_out_of_scope_prompt_not_read(self):
        with tempfile.TemporaryDirectory() as other:
            prompt = Path(other).resolve() / "private.md"
            prompt.write_text("must not be read")
            self.plan["prompt_file"] = str(prompt)
            plan_path = Path(self.spec["launch_plan"]["path"])
            plan_path.write_text(json.dumps(self.plan))
            self.spec["launch_plan"] = file_ref(plan_path)
            self.save()
            with patch("operator_archive.file_ref", wraps=file_ref) as reader:
                with self.assertRaisesRegex(ValueError, "outside_scope"):
                    prepare(self.ref)
            self.assertNotIn(prompt, [call.args[0] for call in reader.call_args_list])
        self.assertEqual(list(self.output.iterdir()), [])

    def test_directory_drift_prevents_success_publication(self):
        from coordinator_snapshots import recheck

        def changed(snapshots):
            recheck(snapshots)
            self.archive.chmod(0o750)

        with patch("operator_archive.snapshots_io.recheck", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "archive_directory_changed"):
                prepare(self.ref)
        self.assertTrue((self.output / "archive-intent.json").is_file())
        self.assertFalse((self.output / "prepared.json").exists())
        self.assertFalse((self.output / "launch-plan.json").exists())


if __name__ == "__main__":
    unittest.main()
