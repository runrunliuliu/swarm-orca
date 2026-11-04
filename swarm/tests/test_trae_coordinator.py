from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from coordinator_launch import build_plan, main
from coordinator_input import input_bytes
from log_io import prefix_digest
from trae_coordinator import AUTO_REVIEW_EXECUTION, ContextFreshnessError, observe, stream_thread, verify_log


SID = "12345678-1234-1234-1234-123456789012"


class TraeCoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cwd = self.root / "space's $(no)"
        self.cwd.mkdir()
        self.bootstrap = self.root / "bootstrap"
        self.bootstrap.mkdir()
        self.archive = self.root / "run_real"
        self.archive.mkdir()
        self.prompt = self.root / "prompt.md"
        self.prompt.write_text("Authorized research task")
        self.model = self.root / "model.json"
        self.model.write_text(json.dumps({
            "schema_version": 1, "scope": "swarm_coordinator_only",
            "selection": {"mode": "explicit", "agent": "trae", "model": "gpt-5.5",
                          "effort": "xhigh", "max_mode": True}}))
        self.runtime = self.root / "trae-runtime.json"
        self.runtime.write_text(json.dumps({
            "schema_version": 1, "scope": "swarm_coordinator_only", "provider": "trae",
            "cli_version": "0.210.1", "execution": {"sandbox_mode": "workspace-write",
                "approval_policy": "never", "launch_mode": "exec", "network_access": True}}))
        self.args = dict(trae=sys.executable, cwd=self.cwd, bootstrap_dir=self.bootstrap,
                         model_config=self.model, trae_runtime_config=self.runtime,
                         prompt_file=self.prompt)
        self.now = datetime.now(timezone.utc)
        self.meta = {"type": "session_meta", "payload": {"id": SID, "session_id": SID,
            "cli_version": "0.210.1", "model_provider": "trae", "cwd": str(self.cwd),
            "source": "exec", "originator": "codex_exec", "parent_thread_id": None}}
        self.context = {"type": "turn_context", "timestamp": self.now.isoformat(),
            "payload": {"model": "GPT-5.5", "model_provider": "trae", "effort": "xhigh",
                "model_backend_variant": "max", "cwd": str(self.cwd), "approval_policy": "never",
                "sandbox_policy": {"type": "workspace-write", "network_access": True,
                    "writable_roots": [str(self.bootstrap)]}}}
        self.log = self.root / "log.jsonl"

    def write_log(self, records=None):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in (records or [self.meta, self.context])))

    def verify(self, **kwargs):
        return verify_log(self.log, thread_id=SID, cwd=self.cwd,
                          roots=[str(self.bootstrap)], now=self.now, **kwargs)

    def use_auto_review(self):
        config = json.loads(self.runtime.read_text())
        config["execution"] = dict(AUTO_REVIEW_EXECUTION)
        self.runtime.write_text(json.dumps(config))
        self.context["payload"]["approval_policy"] = "on-request"
        self.context["payload"]["approvals_reviewer"] = "guardian_subagent"

    def test_bootstrap_plan_is_pure_and_separate(self):
        plan = build_plan(**self.args)
        self.assertEqual(plan["phase"], "bootstrap")
        self.assertIsNone(plan["preparation"])
        self.assertEqual(plan["native_launch"]["method"], "agent.launch")
        self.assertEqual(plan["native_launch"]["agent"], "trae")
        self.assertEqual(plan["native_launch"]["target"]["kind"], "existing")
        self.assertEqual(plan["native_launch"]["stdin_sha256"],
                         plan["input_contract"]["stdin_sha256"])
        self.assertFalse(plan["native_launch"]["strict_eligible"])
        self.assertIn("stdin", plan["native_launch"]["requires_runtime_support"])
        self.assertNotIn("danger-full-access", plan["argv"])
        self.assertNotIn('--no-daemon', plan["argv"])
        self.assertIn('approval_policy="never"', plan["argv"])
        self.assertIn('sandbox_workspace_write.network_access=true', plan["argv"])
        self.assertIn('model_backend_variant="max"', plan["argv"])
        self.assertIsNone(plan["command"])
        self.assertTrue(input_bytes(plan).endswith(self.prompt.read_bytes()))
        self.assertEqual(list(self.bootstrap.iterdir()), [])

    def test_explicit_exact_resume_and_real_run_directory(self):
        args = dict(self.args, bootstrap_dir=None, archive_dir=self.archive, resume_session=SID)
        plan = build_plan(**args)
        self.assertEqual(plan["argv"][-3:], ["resume", SID, "-"])
        self.assertEqual(plan["phase"], "run")
        self.assertIn("Phase: run.", plan["prompt_fragment"])
        self.assertIn("progress-checkpoint", plan["prompt_fragment"])
        self.assertNotIn("MUST NOT dispatch", plan["prompt_fragment"])
        self.assertNotIn("Bootstrap may", plan["prompt_fragment"])
        self.assertNotIn("Run ID and finish", plan["prompt_fragment"])
        for changes in ({"resume_session": "latest"}, {"resume_session": None},
                        {"archive_dir": self.bootstrap}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                build_plan(**dict(args, **changes))

    def test_phase_fragments_are_pinned_into_input_without_modifying_prompt_file(self):
        original = self.prompt.read_bytes()
        variants = [({}, "bootstrap"),
                    (dict(bootstrap_dir=None, archive_dir=self.archive, resume_session=SID), "run"),
                    (dict(bootstrap_dir=None, archive_dir=self.archive, replacement_run="run_real"), "recovery")]
        for options, phase in variants:
            with self.subTest(phase=phase):
                plan = build_plan(**dict(self.args, **options))
                self.assertIn("Phase: " + phase + ".", plan["prompt_fragment"])
                self.assertEqual(self.prompt.read_bytes(), original)
                self.assertIn(plan["prompt_fragment"].encode(), input_bytes(plan))
                self.assertEqual("worker-plan --request" in plan["prompt_fragment"], phase != "bootstrap")
                self.assertEqual("MUST NOT dispatch" in plan["prompt_fragment"], phase == "bootstrap")
                if phase == "bootstrap":
                    self.assertIn("MUST NOT create", plan["prompt_fragment"])
                    self.assertIn("session startup gate", plan["prompt_fragment"])
                    self.assertNotIn("Return its Run ID", plan["prompt_fragment"])

    def test_run_cli_requires_explicit_single_turn_or_goal_loop(self):
        argv = ["--trae", sys.executable, "--cwd", str(self.cwd),
                "--archive-dir", str(self.archive), "--resume-session", SID,
                "--prompt-file", str(self.prompt), "--model-config", str(self.model),
                "--trae-runtime-config", str(self.runtime)]
        with redirect_stderr(io.StringIO()) as errors, self.assertRaises(SystemExit) as raised:
            main(argv)
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("goal-loop", errors.getvalue())
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main([*argv, "--single-turn"]), 0)
        self.assertEqual(json.loads(output.getvalue())["resume_session"], SID)
        self.assertEqual(list(self.archive.iterdir()), [])

    def test_auto_review_plan_pins_both_approval_fields(self):
        self.use_auto_review()
        plan = build_plan(**self.args)
        self.assertEqual(plan["execution"], AUTO_REVIEW_EXECUTION)
        self.assertIn('approval_policy="on-request"', plan["argv"])
        self.assertIn('approvals_reviewer="auto_review"', plan["argv"])
        self.assertNotIn('approval_policy="never"', plan["argv"])
        self.assertNotIn('danger-full-access', plan["argv"])
        self.assertEqual(plan["runtime_config"], str(self.runtime))
        self.assertIn('--trae-runtime-config', plan["prompt_fragment"])
        self.assertIsNone(plan["command"])

    def test_persistent_auto_review_config_is_supported(self):
        config = Path(__file__).resolve().parents[1] / "trae-coordinator-runtime.json"
        plan = build_plan(**dict(self.args, trae_runtime_config=config))
        self.assertEqual(plan["execution"], AUTO_REVIEW_EXECUTION)

    def test_current_211_runtime_config_is_supported_and_observed(self):
        config = json.loads(self.runtime.read_text())
        config["cli_version"] = "0.211.1"
        self.runtime.write_text(json.dumps(config))
        self.meta["payload"]["cli_version"] = "0.211.1"
        self.write_log()
        plan = build_plan(**self.args)
        self.assertEqual(plan["cli_version"], "0.211.1")
        result = self.verify(cli_version="0.211.1")
        self.assertEqual(result["cli_version"], "0.211.1")

    def test_unknown_runtime_version_is_rejected(self):
        config = json.loads(self.runtime.read_text())
        config["cli_version"] = "0.212.0"
        self.runtime.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "unsupported Trae runtime"):
            build_plan(**self.args)

    def test_partial_or_incompatible_auto_review_policy_rejected(self):
        for update in ({"approvals_reviewer": None}, {"approvals_reviewer": "user"},
                       {"approvals_reviewer": "guardian_subagent"},
                       {"approval_policy": "never"}, {"network_access": 1},
                       {"sandbox_mode": "danger-full-access"}):
            self.use_auto_review()
            config = json.loads(self.runtime.read_text())
            config["execution"].update(update)
            if update == {"approvals_reviewer": None}:
                del config["execution"]["approvals_reviewer"]
            self.runtime.write_text(json.dumps(config))
            with self.subTest(update=update), self.assertRaises(ValueError):
                build_plan(**self.args)

    def test_no_implicit_codex_permissions_or_other_provider(self):
        with self.assertRaises(ValueError):
            build_plan(**dict(self.args, trae_runtime_config=None))
        config = json.loads(self.runtime.read_text())
        config["execution"]["sandbox_mode"] = "danger-full-access"
        self.runtime.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            build_plan(**self.args)

    def test_explicit_replacement_keeps_run_but_starts_new_session(self):
        args = dict(self.args, bootstrap_dir=None, archive_dir=self.archive,
                    replacement_run="run_real")
        plan = build_plan(**args)
        self.assertEqual(plan["phase"], "replacement")
        self.assertEqual(plan["replacement_run"], "run_real")
        self.assertIsNone(plan["resume_session"])
        self.assertNotIn("resume", plan["argv"])
        self.assertIn("prove the previous Coordinator process exited", plan["prompt_fragment"])
        self.assertIn("Before creating a replacement terminal/session", plan["prompt_fragment"])
        self.assertIn("strict-v1 has no safe rebind/adoption", plan["prompt_fragment"])
        self.assertNotIn("ordinary native run-use", plan["prompt_fragment"])
        self.assertIn("No run-create", plan["prompt_fragment"])
        self.assertNotIn("Bootstrap may", plan["prompt_fragment"])
        self.assertEqual(list(self.archive.iterdir()), [])

    def test_replacement_rejects_ambiguous_or_mismatched_identity(self):
        args = dict(self.args, bootstrap_dir=None, archive_dir=self.archive,
                    replacement_run="run_real")
        for changes in ({"resume_session": SID}, {"replacement_run": "run_wrong"},
                        {"replacement_run": "latest"}, {"bootstrap_dir": self.bootstrap},
                        {"archive_dir": None}, {"replacement_run": 1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                build_plan(**dict(args, **changes))

    def test_stream_requires_one_structured_event(self):
        event = json.dumps({"type": "thread.started", "thread_id": SID})
        self.assertEqual(stream_thread("shell prompt\n" + event), SID)
        for value in ("model says " + SID, event + "\n" + event,
                      json.dumps({"type": "thread.started", "thread_id": "bad"})):
            with self.subTest(value=value), self.assertRaises(ValueError):
                stream_thread(value)

    def test_effective_settings_from_log_not_defaults(self):
        self.write_log()
        result = self.verify()
        self.assertEqual(result["effective"]["model_backend_variant"], "max")
        self.assertIn("not-process-attested", result["trust"])
        self.assertEqual(len(result["prefix_sha256"]), 64)

    def test_55_mib_log_uses_latest_complete_context_and_full_prefix_digest(self):
        self.write_log()
        row = json.dumps({"type": "response_item", "payload": {"text": "x" * (1024 * 1024)}}).encode() + b"\n"
        with self.log.open("ab") as target:
            for _ in range(55):
                target.write(row)
            target.write(json.dumps(self.context).encode() + b"\n")
            target.write(b'{"type":"turn_context","payload":')
        result = self.verify()
        self.assertGreater(result["prefix_bytes"], 55 * 1024 * 1024)
        self.assertEqual(result["prefix_bytes"], self.log.stat().st_size)
        expected = hashlib.sha256()
        with self.log.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                expected.update(chunk)
        self.assertEqual(result["prefix_sha256"], expected.hexdigest())
        # Finish the partial record with a conflicting effective setting.
        wrong = {**self.context["payload"], "model": "other"}
        with self.log.open("ab") as target:
            target.write(json.dumps(wrong).encode() + b"}\n")
        with self.assertRaisesRegex(ValueError, "settings mismatch"):
            self.verify()

    def test_rewrite_truncation_and_replacement_during_scan_are_rejected(self):
        for change in ("rewrite", "truncate", "replace"):
            self.write_log()
            def mutate(source, size):
                content = self.log.read_bytes()
                if change == "rewrite":
                    self.log.write_bytes(content.replace(b"GPT-5.5", b"GPT-0.0"))
                elif change == "truncate":
                    self.log.write_bytes(content[:-20])
                else:
                    replacement = self.root / "replacement.jsonl"
                    replacement.write_bytes(content)
                    replacement.replace(self.log)
                return prefix_digest(source, size)
            with self.subTest(change=change), patch("trae_coordinator.prefix_digest", side_effect=mutate):
                with self.assertRaisesRegex(ValueError, "changed|truncated|replaced"):
                    self.verify()

    def test_append_after_initial_eof_belongs_to_next_observation(self):
        self.write_log()
        size = self.log.stat().st_size
        def append(source, length):
            with self.log.open("ab") as target:
                target.write(json.dumps({"type": "response_item"}).encode() + b"\n")
            return prefix_digest(source, length)
        with patch("trae_coordinator.prefix_digest", side_effect=append):
            result = self.verify()
        self.assertEqual(result["prefix_bytes"], size)
        self.assertGreater(self.log.stat().st_size, size)

    def test_auto_review_observation_accepts_native_alias(self):
        self.use_auto_review()
        for reviewer in ("auto_review", "guardian_subagent"):
            self.context["payload"]["approvals_reviewer"] = reviewer
            self.write_log()
            with self.subTest(reviewer=reviewer):
                result = self.verify(execution=AUTO_REVIEW_EXECUTION)
                self.assertEqual(result["effective"]["approvals_reviewer"], reviewer)

    def test_auto_review_observation_requires_actual_reviewer(self):
        self.use_auto_review()
        for reviewer in (None, "user", "auto", ""):
            self.context["payload"]["approvals_reviewer"] = reviewer
            self.write_log()
            with self.subTest(reviewer=reviewer), self.assertRaisesRegex(ValueError, "reviewer"):
                self.verify(execution=AUTO_REVIEW_EXECUTION)
        del self.context["payload"]["approvals_reviewer"]
        self.write_log()
        with self.assertRaisesRegex(ValueError, "reviewer"):
            self.verify(execution=AUTO_REVIEW_EXECUTION)

    def test_legacy_never_is_not_silently_accepted_for_auto_review(self):
        self.write_log()
        with self.assertRaisesRegex(ValueError, "settings mismatch"):
            self.verify(execution=AUTO_REVIEW_EXECUTION)

    def test_mismatched_or_missing_settings_rejected(self):
        for key, value in (("model", "other"), ("effort", "high"),
                           ("model_backend_variant", None), ("approval_policy", "on-request"),
                           ("sandbox_policy", {"type": "workspace-write", "writable_roots": []})):
            old = self.context["payload"][key]
            self.context["payload"][key] = value
            self.write_log()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify()
            self.context["payload"][key] = old

    def test_stale_context_wrong_session_and_symlink_rejected(self):
        self.context["timestamp"] = "2000-01-01T00:00:00+00:00"
        self.write_log()
        with self.assertRaises(ValueError):
            self.verify()
        self.context["timestamp"] = self.now.isoformat()
        self.meta["payload"]["id"] = "different"
        self.write_log()
        with self.assertRaises(ValueError):
            self.verify()
        link = self.root / "link.jsonl"
        link.symlink_to(self.log)
        with self.assertRaises(ValueError):
            verify_log(link, thread_id=SID, cwd=self.cwd, roots=[], now=self.now)

    def test_context_freshness_boundaries_and_typed_errors(self):
        for age, max_age in ((0, 0), (0.125, 0.125), (300, 300), (347, 900), (900, 900)):
            self.context["timestamp"] = (self.now - timedelta(seconds=age)).isoformat()
            self.write_log()
            with self.subTest(age=age, max_age=max_age):
                self.assertEqual(self.verify(max_age=max_age)["observed_at"], self.context["timestamp"])
        for age, max_age in ((300.001, 300), (900.001, 900), (-0.001, 900)):
            self.context["timestamp"] = (self.now - timedelta(seconds=age)).isoformat()
            self.write_log()
            with self.subTest(age=age, max_age=max_age), self.assertRaises(ContextFreshnessError) as raised:
                self.verify(max_age=max_age)
            self.assertEqual(raised.exception.code,
                             "session_context_in_future" if age < 0 else "session_context_stale")
            self.assertEqual(raised.exception.age_seconds, age)
            self.assertEqual(raised.exception.max_age_seconds, max_age)

    def test_context_max_age_is_finite_nonnegative_number(self):
        self.write_log()
        for value in (None, True, -1, "900", float("inf"), float("-inf"), float("nan")):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid context max age"):
                self.verify(max_age=value)

    def test_recent_tool_activity_does_not_refresh_context_age(self):
        self.context["timestamp"] = (self.now - timedelta(seconds=347)).isoformat()
        self.write_log([self.meta, self.context, {
            "type": "response_item", "timestamp": self.now.isoformat(),
            "payload": {"type": "function_call_output", "output": "readiness complete"}}])
        with self.assertRaises(ContextFreshnessError):
            self.verify()
        result = self.verify(max_age=900)
        self.assertEqual(result["observed_at"], self.context["timestamp"])

    def test_missing_context_rejected(self):
        self.write_log([self.meta])
        with self.assertRaises(ValueError):
            self.verify()

    def test_network_access_must_be_observed(self):
        self.context["payload"]["sandbox_policy"].pop("network_access")
        self.write_log()
        with self.assertRaises(ValueError):
            self.verify()

    def test_other_origin_or_child_session_rejected(self):
        for key, value in (("source", "cli"), ("originator", "codex_cli_rs"),
                           ("session_id", "other"), ("parent_thread_id", SID)):
            old = self.meta["payload"][key]
            self.meta["payload"][key] = value
            self.write_log()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify()
            self.meta["payload"][key] = old

    def native_fixture(self, *, evicted=False, changed=False, wrong_run=False):
        self.write_log()
        directory = self.root / "2026" / "10" / "17"
        directory.mkdir(parents=True)
        self.log.rename(directory / ("rollout-time-" + SID + ".jsonl"))
        shows = 0
        def query(cli, runtime, args):
            nonlocal shows
            if args == ["status"]:
                return {"runtime": {"appVersion": "1.4.219", "state": "ready"}}
            if args[:2] == ["terminal", "show"]:
                shows += 1
                return {"terminal": {"handle": "term_test", "incarnationId":
                    "changed" if changed and shows > 1 else "inc_test",
                    "worktreeId": "workspace_test", "executionHostId": "local",
                    "connected": True, "orphaned": False, "tabId": "tab", "leafId": "leaf"}}
            if args[:2] == ["worktree", "show"]:
                return {"worktree": {"id": "workspace_test", "path": str(self.cwd)}}
            if args[:2] == ["orchestration", "run-current"]:
                return {"run": {"id": "wrong" if wrong_run else "run_test"}}
            if args[:2] == ["terminal", "read"]:
                cursor = args[args.index("--cursor") + 1]
                return {"terminal": {"source": "stream", "oldestCursor": "3" if evicted else "0",
                    "nextCursor": "3" if cursor == "2" else "4", "latestCursor": "4",
                    # Native numeric cursor strings; final limited page must terminate.
                    "limited": True, "tail": ["startup"] if cursor == "2" else [
                        json.dumps({"type": "thread.started", "thread_id": SID})]}}
            self.fail(args)
        return query

    def observe_fixture(self, **kwargs):
        return observe(cli=sys.executable, runtime="runtime_test", terminal="term_test",
                       incarnation="inc_test", workspace="workspace_test", cwd=self.cwd,
                       cursor=2, log_root=self.root, roots=[str(self.bootstrap)], run="run_test",
                       **kwargs)

    def test_native_observer_uses_explicit_auto_review_contract(self):
        self.use_auto_review()
        with patch("trae_coordinator.native", side_effect=self.native_fixture()):
            result = self.observe_fixture(trae_runtime_config=self.runtime)
        self.assertEqual(result["effective"]["approval_policy"], "on-request")
        self.assertEqual(result["effective"]["approvals_reviewer"], "guardian_subagent")

    def test_native_observer_paginates_numeric_string_cursors(self):
        with patch("trae_coordinator.native", side_effect=self.native_fixture()) as native:
            result = self.observe_fixture()
        self.assertEqual(result["thread_id"], SID)
        self.assertEqual(sum(call.args[2][:2] == ["terminal", "read"]
                             for call in native.call_args_list), 2)

    def test_more_than_32_pages_finish_at_initial_end_even_if_stream_grows(self):
        original = self.native_fixture()
        pages = []
        def query(cli, runtime, args):
            if args[:2] != ["terminal", "read"]:
                return original(cli, runtime, args)
            position = int(args[args.index("--cursor") + 1])
            pages.append(position)
            return {"terminal": {"source": "stream", "oldestCursor": "0",
                "nextCursor": str(position + 1), "latestCursor": str(43 + len(pages)),
                "limited": True, "tail": [json.dumps({"type": "thread.started", "thread_id": SID})]
                if position == 43 else ["startup"]}}
        with patch("trae_coordinator.native", side_effect=query):
            self.assertEqual(self.observe_fixture()["thread_id"], SID)
        self.assertEqual(len(pages), 42)

    def test_stalled_startup_cursor_is_rejected(self):
        original = self.native_fixture()
        def query(cli, runtime, args):
            value = original(cli, runtime, args)
            if args[:2] == ["terminal", "read"]:
                value["terminal"]["nextCursor"] = args[args.index("--cursor") + 1]
            return value
        with patch("trae_coordinator.native", side_effect=query):
            with self.assertRaisesRegex(ValueError, "invalid stream cursor"):
                self.observe_fixture()

    def test_evicted_native_startup_rejected(self):
        with patch("trae_coordinator.native", side_effect=self.native_fixture(evicted=True)):
            with self.assertRaisesRegex(ValueError, "evicted"):
                self.observe_fixture()

    def anchor_fixture(self):
        from coordinator_io import file_ref
        original = self.native_fixture()
        with patch("trae_coordinator.native", side_effect=original):
            anchor = self.observe_fixture()
        target = self.root / "anchor.json"
        target.write_text(json.dumps(anchor))
        return original, anchor, file_ref(target)

    def test_pinned_startup_anchor_survives_eviction_but_rechecks_native_and_settings(self):
        original, anchor, ref = self.anchor_fixture()
        def query(cli, runtime, args):
            self.assertNotEqual(args[:2], ["terminal", "read"])
            return original(cli, runtime, args)
        with patch("trae_coordinator.native", side_effect=query) as native:
            result = self.observe_fixture(startup_anchor=ref, expected_thread=SID)
        self.assertEqual(result["kind"], "trae_session_observation")
        self.assertEqual(native.call_count, 8)
        # Appended effective context must still be checked, not cached from anchor.
        wrong = {**self.context, "payload": {**self.context["payload"], "model": "other"}}
        with Path(anchor["log_path"]).open("a") as stream:
            stream.write(json.dumps(wrong) + "\n")
        with patch("trae_coordinator.native", side_effect=query), self.assertRaisesRegex(ValueError, "settings"):
            self.observe_fixture(startup_anchor=ref, expected_thread=SID)

    def test_startup_anchor_rejects_pin_identity_and_historical_prefix_changes(self):
        from coordinator_io import file_ref
        original, anchor, ref = self.anchor_fixture()
        for key, value in (("runtime_id", "other"), ("stream_start_cursor", 9), ("kind", "trae_session_observation"),
                           ("terminal", {}), ("log_inode", -1), ("prefix_sha256", "0" * 64)):
            Path(ref["path"]).write_text(json.dumps({**anchor, key: value}))
            changed = file_ref(Path(ref["path"]))
            with self.subTest(key=key), patch("trae_coordinator.native", side_effect=original), self.assertRaises(ValueError):
                self.observe_fixture(startup_anchor=changed, expected_thread=SID)
        with patch("trae_coordinator.native", side_effect=original), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.observe_fixture(startup_anchor=ref, expected_thread=SID)

    def test_startup_anchor_never_replaces_live_identity_or_context_freshness(self):
        original, anchor, ref = self.anchor_fixture()
        def changed(cli, runtime, args):
            result = original(cli, runtime, args)
            if args[:2] == ["terminal", "show"]:
                result["terminal"]["incarnationId"] = "changed"
            return result
        with patch("trae_coordinator.native", side_effect=changed), self.assertRaisesRegex(ValueError, "identity"):
            self.observe_fixture(startup_anchor=ref, expected_thread=SID)
        with patch("trae_coordinator.native", side_effect=original), self.assertRaises(ContextFreshnessError):
            self.observe_fixture(startup_anchor=ref, expected_thread=SID, context_max_age_seconds=0)

    def test_native_identity_change_rejected(self):
        with patch("trae_coordinator.native", side_effect=self.native_fixture(changed=True)):
            with self.assertRaisesRegex(ValueError, "identity"):
                self.observe_fixture()

    def test_native_run_mismatch_rejected(self):
        with patch("trae_coordinator.native", side_effect=self.native_fixture(wrong_run=True)):
            with self.assertRaisesRegex(ValueError, "Run ownership"):
                self.observe_fixture()


if __name__ == "__main__":
    unittest.main()
