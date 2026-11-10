import io
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import trae_exec_capture as capture
from trae_coordinator import stream_thread
from coordinator_input import bind_prompt, input_bytes
from coordinator_loop import phase_contract


SID = "01a14d83-c795-7540-a2da-79be5545e1ee"
START = ('{"type":"thread.started", "thread_id":"' + SID + '"}\n').encode()


class CaptureTests(unittest.TestCase):
    def relay(self, data):
        with tempfile.TemporaryFile() as raw:
            output = io.BytesIO()
            errors = capture.relay(io.BufferedReader(io.BytesIO(data)), raw, output)
            raw.seek(0)
            self.assertEqual(raw.read(), data)
            return output.getvalue(), errors

    def test_large_tool_output_preserves_original_start_bytes(self):
        item = json.dumps({"type": "item.completed", "text": "x" * 900000}).encode() + b"\n"
        output, errors = self.relay(START + item * 3)
        self.assertEqual(output, START)
        self.assertEqual(errors, [])
        self.assertEqual(stream_thread(output.decode()), SID)

    def test_duplicates_are_not_deduplicated(self):
        output, errors = self.relay(START * 2)
        self.assertEqual(output, START * 2)
        self.assertEqual(errors, [])
        with self.assertRaisesRegex(ValueError, "exactly one"):
            stream_thread(output.decode())

    def test_model_prose_is_not_an_event(self):
        output, errors = self.relay(json.dumps({"type": "item.completed", "text": START.decode()}).encode() + b"\n")
        self.assertEqual(output, b"")
        self.assertEqual(errors, [])

    def test_invalid_and_partial_records_fail_closed(self):
        self.assertEqual(self.relay(b"not json\n")[1], ["invalid_json_record"])
        self.assertEqual(self.relay(START[:-1])[1], ["incomplete_record"])

    def test_identity_output_is_bounded(self):
        output, errors = self.relay(START * 10000)
        self.assertLessEqual(len(output), capture.MAX_FORWARD + 128)
        self.assertEqual(errors, ["identity_output_limit"])
        with self.assertRaises(ValueError):
            stream_thread(output.decode())

    def test_direct_wait_receipt_private_files_and_no_relaunch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            prompt = root / "prompt.md"
            prompt.write_text("test")
            plan = root / "plan.json"
            plan.write_text(json.dumps(bind_prompt({"adapter": "trae-exec-stream-v1", "phase": "replacement",
                "resume_session": None, "cwd": folder, "prompt_file": str(prompt),
                "prompt_fragment": phase_contract("recovery"),
                "argv": [sys.executable, "-c", "import sys; print('diagnostic',file=sys.stderr); sys.exit(7)"]}, prompt)))
            self.assertEqual(capture.run(plan, io.BytesIO()), 7)
            receipt = json.loads(plan.with_suffix(".process.json").read_text())
            self.assertEqual(receipt["exit_code"], 7)
            self.assertGreater(receipt["child_pid"], 0)
            self.assertEqual(receipt["stream_errors"], [])
            self.assertEqual(plan.with_suffix(".stderr.log").read_bytes(), b"diagnostic\n")
            for suffix in (".process-intent.json", ".stdout.jsonl", ".stderr.log", ".process.json", ".stdin.md"):
                self.assertEqual(os.stat(plan.with_suffix(suffix)).st_mode & 0o777, 0o600)
            status = json.loads(plan.with_suffix(".status.json").read_text())
            self.assertEqual(status["process_state"], "exited")
            self.assertEqual(status["completion_status"], "process_exited_without_turn_completion")
            self.assertFalse(status["business_complete"])
            self.assertFalse(status["raw_text_included"])
            self.assertEqual(os.stat(plan.with_suffix(".status.json")).st_mode & 0o777, 0o600)
            before = plan.with_suffix(".status.json").read_text()
            with self.assertRaises(FileExistsError):
                capture.run(plan, io.BytesIO())
            self.assertEqual(plan.with_suffix(".status.json").read_text(), before)

    def test_actual_child_receives_phase_contract_and_original_brief(self):
        for phase, contract_phase in (("bootstrap", "bootstrap"), ("run", "run"),
                                      ("replacement", "recovery")):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                prompt = root / "brief's $(not-shell).md"
                original = "原任务：保留范围，不新增授权。\n".encode()
                prompt.write_bytes(original)
                plan = bind_prompt({"adapter": "trae-exec-stream-v1", "phase": phase,
                    "resume_session": SID if phase == "run" else None, "cwd": folder,
                    "prompt_fragment": phase_contract(contract_phase),
                    "argv": [sys.executable, "-c", "import sys,hashlib,json; "
                             "print(json.dumps({'stdin_hash':hashlib.sha256(sys.stdin.buffer.read()).hexdigest()}))"]}, prompt)
                target = root / "plan.json"
                target.write_text(json.dumps(plan))
                self.assertEqual(capture.run(target, io.BytesIO()), 0)
                delivered = target.with_suffix(".stdin.md").read_bytes()
                self.assertEqual(delivered, input_bytes(plan))
                self.assertTrue(delivered.endswith(original))
                self.assertEqual(prompt.read_bytes(), original)
                actual = json.loads(target.with_suffix(".stdout.jsonl").read_text())
                self.assertEqual(actual["stdin_hash"], hashlib.sha256(delivered).hexdigest())
                receipt = json.loads(target.with_suffix(".process.json").read_text())
                self.assertEqual(receipt["stdin_sha256"], actual["stdin_hash"])
                status = json.loads(target.with_suffix(".status.json").read_text())
                self.assertEqual(status["completion_status"], "process_exited_without_turn_completion")

    def test_missing_pin_or_changed_input_rejects_before_spawn(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            prompt = root / "brief.md"
            prompt.write_text("approved")
            original = bind_prompt({"adapter": "trae-exec-stream-v1", "phase": "run",
                "resume_session": SID, "cwd": folder, "argv": [sys.executable],
                "prompt_fragment": phase_contract("run")}, prompt)
            for mode in ("legacy", "fragment", "brief", "raw-command"):
                plan = dict(original)
                prompt.write_text("approved")
                if mode == "legacy":
                    del plan["input_contract"]
                elif mode == "fragment":
                    plan["prompt_fragment"] += " changed"
                elif mode == "brief":
                    prompt.write_text("changed")
                else:
                    plan["command"] = "raw < brief"
                target = root / (mode + ".json")
                target.write_text(json.dumps(plan))
                with self.subTest(mode=mode), patch.object(capture.subprocess, "Popen") as popen:
                    with self.assertRaises(ValueError):
                        capture.run(target, io.BytesIO())
                    popen.assert_not_called()
                    self.assertFalse(target.with_suffix(".process-intent.json").exists())

    def test_record_larger_than_16_mib_is_preserved(self):
        item = json.dumps({"type": "item.completed", "text": "x" * (17 * 1024 * 1024)}).encode() + b"\n"
        output, errors = self.relay(START + item)
        self.assertEqual(output, START)
        self.assertEqual(errors, [])

    def test_large_invalid_record_and_invalid_utf8_still_rejected(self):
        output, errors = self.relay(START + b"x" * (17 * 1024 * 1024) + b"\n" + b"\xff\n")
        self.assertEqual(errors, ["invalid_json_record"])
        self.assertEqual(output.count(b"operator.stream_error"), 1)
        with self.assertRaisesRegex(ValueError, "stream is invalid"):
            stream_thread(output.decode())

    def test_crlf_and_chunk_boundaries(self):
        item = json.dumps({"type": "item.completed", "text": "x" * 65500}).encode() + b"\n"
        start = START.replace(b"\n", b"\r\n")
        output, errors = self.relay(item + start)
        self.assertEqual(output, start)
        self.assertEqual(errors, [])

    def test_many_errors_emit_one_marker_per_reason(self):
        output, errors = self.relay(START + b"bad\n" * 10000)
        self.assertEqual(errors, ["invalid_json_record"])
        self.assertEqual(output.count(b"operator.stream_error"), 1)
        with self.assertRaisesRegex(ValueError, "stream is invalid"):
            stream_thread(output.decode())

    def test_final_error_receipt_rejected(self):
        receipt = json.dumps({"type": "operator.child_exited", "stream_errors": ["incomplete_record"]})
        with self.assertRaisesRegex(ValueError, "stream is invalid"):
            stream_thread(START.decode() + receipt)

    def test_turn_completion_status_is_separate_from_process_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            prompt = root / "brief.md"
            prompt.write_text("approved")
            script = "import json; print(json.dumps({'type':'thread.started','thread_id':'" + SID + "'})); print(json.dumps({'type':'turn.completed'}))"
            plan = root / "plan.json"
            plan.write_text(json.dumps(bind_prompt({"adapter": "trae-exec-stream-v1", "phase": "run",
                "resume_session": SID, "cwd": folder, "prompt_file": str(prompt),
                "prompt_fragment": phase_contract("run"),
                "argv": [sys.executable, "-c", script]}, prompt)))
            self.assertEqual(capture.run(plan, io.BytesIO()), 0)
            status = json.loads(plan.with_suffix(".status.json").read_text())
            self.assertEqual(status["thread_ids"], [SID])
            self.assertTrue(status["turn_completed"])
            self.assertEqual(status["completion_status"], "turn_completed")
            self.assertFalse(status["business_complete"])

    def test_status_command_and_help_do_not_treat_help_as_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan = root / "plan.json"
            plan.write_text(json.dumps({"adapter": "trae-exec-stream-v1"}))
            out = io.BytesIO()
            self.assertEqual(capture.main(["status", str(plan)], out), 1)
            self.assertIn(b'"process_state": "not_started"', out.getvalue())
            help_out = io.BytesIO()
            self.assertEqual(capture.main(["--help"], help_out), 0)
            self.assertFalse(plan.with_suffix(".process-intent.json").exists())


if __name__ == "__main__":
    unittest.main()
