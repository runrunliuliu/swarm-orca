"""Protocol tests with native mailbox receipts, never real sends or workers."""

import copy
import contextlib
from datetime import datetime, timedelta, timezone
import errno
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import (bound_lock, canonical, digest, file_ref, now, publish_new, read_json,
                            replace_json, timestamp)
from coordinator_startup import KIND, identity
from coordinator_tui_continue import check, freshness, main, step, validate_config
from trae_coordinator import ContextFreshnessError, TUI_ADAPTER
import trae.test_trae_tui as tui
import coordinator.test_coordinator_startup as startup
import coordinator.test_coordinator_loop as loop


class ContinuationTests(unittest.TestCase):
    def setUp(self):
        self.t = tui.TuiTests()
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)
        self.s = startup.StartupGateTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.s.use_v2()
        self.c = self.s.contract
        self.c["adapter"] = TUI_ADAPTER
        self.c["runtime_config"] = file_ref(self.t.f.runtime)
        self.c["observation"] = dict(profile=str(self.t.profile), caller_receipt=self.t.caller_ref,
            log_root=str(self.t.f.root), roots=[str(self.t.f.bootstrap)],
            startup_anchor=self.t.ref("anchor.json", self.t.observe()))
        self.c["run"] = {"id": "run_test", "generation": 1}
        self.contract_ref = self.t.ref("contract.json", self.c)
        self.state = self.t.f.bootstrap / "state"
        self.state.mkdir(mode=0o700)
        acceptance, checkpoint = loop.LoopTests().fixture()
        self.record = dict(binding=dict(runtime="runtime_test", id="run_test", generation=1, terminal="term_test"),
            requirements=acceptance["requirements"], checkpoint=checkpoint,
            domain_check={})
        self.domain_version = 0
        self.bind_domain()
        gate = dict(kind=KIND, schema_version=2, ok=True, phase="first-dispatch", actor="coordinator",
                    started_at=now(), completed_at=now(), valid_until=(timestamp(now()) + timedelta(seconds=180)).isoformat(),
                    contract_sha256=self.contract_ref["sha256"], identity_sha256=digest(canonical(identity(self.c))),
                    run=dict(id="run_test", coordinator_handle="term_test", consumer_generation=1))
        self.config = dict(schema_version=1, contract=self.contract_ref, dispatch_gate=self.t.ref("gate.json", gate),
            state_root=str(self.state), deadline=(timestamp(now()) + timedelta(minutes=10)).isoformat(),
            acceptance=self.t.ref("acceptance.json", acceptance), checkpoint_head=str(self.t.f.bootstrap / "head.json"))
        self.config_ref = self.t.ref("continue-config.json", self.config)
        self.record_path = self.t.f.bootstrap / "checkpoint-projection.json"
        publish_new(self.record_path, self.record)
        self.record_ref = file_ref(self.record_path)
        publish_new(self.t.f.bootstrap / "head.json", self.record_ref)
        self.calls, self.sends = [], []
        self.receipt = None
        self.timeout = False
        self.caller = copy.deepcopy(self.t.caller)
        self.owner = "term_test"
        self.generation = 1
        self.patcher = patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test")
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.observer = patch("trae_tui.observe", return_value={
            "thread_id": self.c["coordinator"]["session"], "observed_at": now()})
        self.observer_mock = self.observer.start()
        self.addCleanup(self.observer.stop)

    def query(self, cli, runtime, args):
        self.calls.append(args)
        if args[:2] == ["orchestration", "strict-caller-check"]:
            return copy.deepcopy(self.caller)
        if args[:2] == ["terminal", "show"]:
            if args[-1] in ("term_sender", "term-operator"):
                s = (dict(terminal="term_sender", incarnation="inc_sender", workspace="ws_sender")
                     if args[-1] == "term_sender" else
                     dict(terminal="term-operator", incarnation="inc-operator", workspace="repo::/operator"))
                return {"terminal": dict(handle=s["terminal"], incarnationId=s["incarnation"],
                    worktreeId=s["workspace"], connected=True, orphaned=False, agentIdentity=None,
                    tabId="sender-tab", leafId="sender-leaf")}
            return {"terminal": copy.deepcopy(self.t.term)}
        if args[:2] == ["orchestration", "run-show"]:
            return dict(coordinatorPolicy="strict-v1", run=dict(id="run_test", coordinator_handle=self.owner,
                                                                consumer_generation=self.generation))
        if args[:2] == ["orchestration", "send"]:
            self.sends.append(args)
            self.receipt = dict(mutation={"requestId": args[args.index("--retry-request") + 1]},
                message=dict(id="message-one", from_handle="term_test", to_handle="run:run_test", run_id="run_test"))
            if self.timeout:
                raise subprocess.TimeoutExpired("native-send", 1)
            return copy.deepcopy(self.receipt)
        if args[:2] == ["orchestration", "request-show"]:
            return dict(requestId=args[-1], method="orchestration.send", state="completed" if self.receipt else "absent",
                        receipt=copy.deepcopy(self.receipt))
        self.fail(args)

    def step(self, mode="enqueue", ref=None, result_ref=None, call=None):
        if mode == "claim" and self.observer_mock.side_effect is None:
            self.observer_mock.return_value["observed_at"] = now()
        return step(self.config_ref, ref or self.record_ref, mode=mode, call=call or self.query,
                    result_ref=result_ref)

    def bind_domain(self):
        self.domain_version += 1
        source = dict(schema_version=2, run_id="run_test", contract_sha256="a" * 64,
                      **self.record["checkpoint"])
        receipt = dict(ok=True, result=dict(consistent=True, decision=source["decision"],
                                           authority_sha256="b" * 64, context_sha256="c" * 64,
                                           contract_sha256=source["contract_sha256"]),
                       authority_check=dict(run_id="run_test", checkpoint_sha256=digest(canonical(source)),
                                            schema_version=1, grants_authority=False,
                                            authority_sha256="b" * 64, context_sha256="c" * 64,
                                            status="consistent", error_code=None))
        self.record["domain_check"] = dict(adapter="rsi-authorized-progress-v1",
            source=self.t.ref(f"bootstrap/source-{self.domain_version}.json", source),
            receipt=self.t.ref(f"bootstrap/receipt-{self.domain_version}.json", receipt))

    def rewrite_record(self, *, rebind=True):
        from coordinator_io import replace_json
        if rebind:
            self.bind_domain()
        replace_json(self.record_path, self.record)
        self.record_ref = file_ref(self.record_path)
        replace_json(self.t.f.bootstrap / "head.json", self.record_ref)

    def scheduler_stop(self):
        self.config.update(schema_version=2, scheduler=dict(
            terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"))
        self.config_ref = self.t.ref("scheduled-review-config.json", self.config)
        stop = dict(state="review_required", reason="tui_scheduler_no_acceptance_progress",
                    checkpoint=self.record_ref,
                    progress=dict(consecutive_without_acceptance_advance=3, limit=3,
                                  scope="declared_acceptance_only_not_semantic_verification"),
                    business_acceptance="not_evaluated")
        replace_json(self.state / "scheduler.json", dict(config=self.config_ref, stop=stop,
                                                          waits={}, turns={}))
        return stop

    def use_scheduler_sender(self):
        self.config.update(schema_version=2, scheduler=dict(
            terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"))
        self.config_ref = self.t.ref("scheduled-config.json", self.config)

    def operator_handoff_result(self, name="operator-result.json", evidence=None):
        proof = evidence or self.t.ref("bootstrap/operator-proof.json", {"operator": "done"})
        return self.t.ref("bootstrap/" + name, dict(
            action_id=self.record["checkpoint"]["next_action"]["id"], checkpoint=self.record_ref,
            status="executed", evidence=[proof]))

    def scheduler_review_clear_ref(self, stop, name="review-clear.json", **updates):
        clear = dict(schema_version=1, kind="scheduler-review-clear", config=self.config_ref,
                     stop=stop, checkpoint=stop["checkpoint"],
                     domain_check=read_json(stop["checkpoint"]["path"])["domain_check"],
                     decision="continue", reason="independent_authorized_progress_review",
                     reviewed_at=now())
        clear.update(updates)
        return self.t.ref("bootstrap/" + name, clear), clear

    def test_enqueue_deduplicated_and_claim_once(self):
        first = self.step()
        self.assertEqual(first["state"], "enqueued")
        self.assertFalse(first["execute_action"])
        self.assertEqual(first["business_processed"], "unknown")
        self.assertEqual(self.step()["delivery"], first["delivery"])
        self.assertEqual(len(self.sends), 1)
        self.assertNotIn("--from", self.sends[0])
        self.assertTrue(self.step("claim")["execute_action"])
        self.assertFalse(self.step("claim")["execute_action"])
        self.assertEqual(self.step()["state"], "already_claimed")
        self.assertFalse(any(a[:2] in (["terminal", "send"], ["orchestration", "check"],
                                      ["orchestration", "worker-start"]) for a in self.calls))

    def test_real_lock_busy_enqueue_claim_settle_and_retry_deduplication(self):
        def busy(mode, result=None):
            with bound_lock(self.state, self.config_ref, "tui-continuation"):
                before = {p.name: p.read_bytes() for p in self.state.iterdir()}
                calls = list(self.calls)
                reply = self.step(mode, result_ref=result)
                self.assertEqual(reply["reason"], "tui_continuation_lock_busy")
                self.assertEqual(reply["state"], "retryable")
                self.assertTrue(reply["retryable"])
                self.assertFalse(reply["execute_action"])
                self.assertFalse(reply["committed"])
                self.assertEqual(reply["retry_mode"], mode)
                self.assertEqual({p.name: p.read_bytes() for p in self.state.iterdir()}, before)
                self.assertEqual(self.calls, calls)
        busy("enqueue")
        sent = self.step()
        busy("claim")
        claimed = self.step("claim")
        self.assertTrue(claimed["execute_action"])
        self.assertEqual(claimed["request_id"], sent["request_id"])
        self.assertFalse(self.step("claim")["execute_action"])
        result = self.t.ref("bootstrap/result.json", dict(action_id="action-fix",
            checkpoint=self.record_ref, status="executed", evidence=[self.record_ref]))
        busy("settle", result)
        self.assertEqual(self.step("settle", result_ref=result)["state"], "settled")
        busy("settle", result)  # Uncommitted invocation does not mean a prior settlement is absent.
        self.assertEqual(self.step("settle", result_ref=result)["state"], "settled")
        self.assertFalse(self.step("claim")["execute_action"])
        entry = next(iter(read_json(self.state / "outbox.json")["actions"].values()))
        self.assertEqual(entry["request_id"], sent["request_id"])
        self.assertEqual(entry["result"], result)
        self.assertEqual(len(self.sends), 1)

    def test_cli_busy_is_temporary_failure_not_success_or_permanent_stop(self):
        args = ["claim", "--execute", "--config", self.config_ref["path"], "--config-sha256",
                self.config_ref["sha256"], "--checkpoint", self.record_ref["path"],
                "--checkpoint-sha256", self.record_ref["sha256"]]
        with bound_lock(self.state, self.config_ref, "tui-continuation"), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(args), 75)
        reply = json.loads(output.getvalue())
        self.assertEqual(reply["reason"], "tui_continuation_lock_busy")
        self.assertFalse(reply["execute_action"])
        self.assertFalse(reply["committed"])
        with patch("coordinator_tui_continue.fence", side_effect=BlockingIOError(errno.EAGAIN, "body")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(args), 2)
        self.assertNotIn("retryable", json.loads(output.getvalue()))

    def test_retry_after_busy_rechecks_head_and_owner(self):
        self.step()
        with bound_lock(self.state, self.config_ref, "tui-continuation"):
            self.assertTrue(self.step("claim")["retryable"])
        before = read_json(self.state / "outbox.json")
        self.generation += 1
        with self.assertRaises(ValueError):
            self.step("claim")
        self.generation -= 1
        from coordinator_io import replace_json
        replace_json(self.t.f.bootstrap / "head.json", {"path": "/superseded", "sha256": "f" * 64})
        with self.assertRaisesRegex(ValueError, "checkpoint_superseded"):
            self.step("claim")
        self.assertEqual(read_json(self.state / "outbox.json"), before)
        self.assertEqual(len(self.sends), 1)

    def test_send_timeout_reconciled_never_replayed(self):
        self.timeout = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.step()
        result = self.step()
        self.assertEqual(result["state"], "enqueued")
        self.assertEqual(len(self.sends), 1)
        self.assertTrue(any(a[:2] == ["orchestration", "request-show"] for a in self.calls))

    def test_absent_ambiguous_receipt_stops_no_resend(self):
        self.timeout = True
        with self.assertRaises(subprocess.TimeoutExpired):
            self.step()
        self.receipt = None
        with self.assertRaisesRegex(ValueError, "reconciliation"):
            self.step()
        self.assertEqual(len(self.sends), 1)

    def test_claim_requires_prior_enqueue(self):
        with self.assertRaisesRegex(ValueError, "not_enqueued"):
            self.step("claim")
        self.assertEqual(self.sends, [])

    def test_dead_shell_rejected_without_send(self):
        self.t.term.pop("agentIdentity")
        with self.assertRaisesRegex(ValueError, "agent_unverifiable"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_owner_generation_or_strict_identity_change_stops(self):
        for field, value in (("owner", "other"), ("generation", 2),
                             ("caller", {**self.caller, "caller": {**self.caller["caller"], "processIncarnation": "other"}})):
            original = getattr(self, field)
            setattr(self, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.step()
            setattr(self, field, original)
        self.assertEqual(self.sends, [])

    def runtime_status(self, runtime="runtime_restarted"):
        return subprocess.CompletedProcess([self.c["cli"]["path"], "status", "--json"], 0,
            stdout=json.dumps({"ok": True, "result": {"runtime": {"runtimeId": runtime,
                "state": "ready", "appVersion": "1.4.219",
                "capabilities": ["orchestration.strict-caller-check.v1"]}},
                "_meta": {"runtimeId": runtime}}), stderr="")

    def test_runtime_epoch_rebind_uses_verified_current_runtime_for_send(self):
        runtimes = []

        def query(cli, runtime, args):
            runtimes.append((runtime, tuple(args)))
            if runtime == "runtime_test" and args[:2] in (["orchestration", "strict-caller-check"],
                                                           ["orchestration", "request-show"]):
                raise ValueError("native query failed or runtime changed")
            self.assertEqual(runtime, "runtime_restarted")
            return self.query(cli, runtime, args)

        with patch("coordinator_tui_continue.subprocess.run", return_value=self.runtime_status()):
            result = step(self.config_ref, self.record_ref, mode="enqueue", call=query)
        self.assertEqual(result["state"], "enqueued")
        self.assertEqual(len(self.sends), 1)
        self.assertIn(("runtime_restarted", tuple(self.sends[0])), runtimes)
        self.assertEqual(self.observer_mock.call_args.kwargs["runtime"], "runtime_restarted")
        self.assertEqual(self.observer_mock.call_args.kwargs["caller_receipt_runtime"], "runtime_test")
        token = self.observer_mock.call_args.kwargs["accepted_runtime_rebind"]
        self.assertEqual(token["source_runtime"], "runtime_test")
        self.assertEqual(token["target_runtime"], "runtime_restarted")

    def test_runtime_epoch_rebind_reconciles_timeout_on_current_runtime_without_resend(self):
        self.timeout = True
        runtimes = []

        def query(cli, runtime, args):
            runtimes.append((runtime, tuple(args)))
            if runtime == "runtime_test" and args[:2] in (["orchestration", "strict-caller-check"],
                                                           ["orchestration", "request-show"]):
                raise ValueError("native query failed or runtime changed")
            self.assertEqual(runtime, "runtime_restarted")
            return self.query(cli, runtime, args)

        with patch("coordinator_tui_continue.subprocess.run", return_value=self.runtime_status()):
            with self.assertRaises(subprocess.TimeoutExpired):
                step(self.config_ref, self.record_ref, mode="enqueue", call=query)
            self.timeout = False
            result = step(self.config_ref, self.record_ref, mode="enqueue", call=query)
        self.assertEqual(result["state"], "enqueued")
        self.assertEqual(len(self.sends), 1)
        self.assertTrue(any(runtime == "runtime_restarted" and args[:2] == ("orchestration", "request-show")
                            for runtime, args in runtimes))

    def test_runtime_epoch_rebind_rejects_changed_live_caller(self):
        changed = copy.deepcopy(self.caller)
        changed["caller"]["processIncarnation"] = "pty:other"

        def query(cli, runtime, args):
            if runtime == "runtime_test" and args[:2] == ["orchestration", "strict-caller-check"]:
                raise ValueError("native query failed or runtime changed")
            if runtime == "runtime_restarted" and args[:2] == ["orchestration", "strict-caller-check"]:
                return copy.deepcopy(changed)
            return self.query(cli, runtime, args)

        with patch("coordinator_tui_continue.subprocess.run", return_value=self.runtime_status()), \
                self.assertRaisesRegex(ValueError, "tui_live_caller_changed"):
            self.step(call=query)
        self.assertEqual(self.sends, [])

    def test_new_provider_session_in_same_tui_stops(self):
        self.observer_mock.return_value = {"thread_id": "different"}
        with self.assertRaisesRegex(ValueError, "provider_session"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_ownership_change_during_observation_stops_before_send(self):
        def changed(**kwargs):
            self.generation += 1
            return {"thread_id": self.c["coordinator"]["session"]}
        self.observer_mock.side_effect = changed
        with self.assertRaisesRegex(ValueError, "run_owner_changed"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_corrupt_outbox_order_stops_without_send(self):
        self.step()
        from coordinator_io import replace_json
        state = read_json(self.state / "outbox.json")
        state["order"] = []
        replace_json(self.state / "outbox.json", state)
        with self.assertRaisesRegex(ValueError, "outbox_invalid"):
            self.step("claim")
        self.assertEqual(len(self.sends), 1)

    def test_operator_context_cannot_enqueue(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"), self.assertRaisesRegex(ValueError, "original_context"):
            self.step()
        self.assertEqual(self.calls, [])

    def test_mutated_acceptance_or_stale_pin_rejected(self):
        self.record["requirements"][0]["acceptance"] = "relaxed"
        self.rewrite_record()
        with self.assertRaisesRegex(ValueError, "original_acceptance"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_no_wakeup_for_wait_blocked_complete_or_operator(self):
        for statuses in (("waiting", "waiting"), ("blocked", "blocked"), ("met", "met")):
            _, self.record["checkpoint"] = loop.LoopTests().fixture(statuses=statuses)
            if statuses[0] == "waiting":
                self.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:d1"]
            self.rewrite_record()
            with self.subTest(statuses=statuses), self.assertRaisesRegex(ValueError, "no_continuation"):
                self.step()
        _, self.record["checkpoint"] = loop.LoopTests().fixture()
        self.record["checkpoint"]["next_action"]["owner"] = "outer-operator"
        self.rewrite_record()
        with self.assertRaisesRegex(ValueError, "no_continuation"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_operator_handoff_can_be_settled_by_scheduler_sender_without_native_send(self):
        self.use_scheduler_sender()
        self.record["checkpoint"]["next_action"]["owner"] = "outer-operator"
        self.rewrite_record()
        result_ref = self.operator_handoff_result()
        env = {"ORCA_TERMINAL_HANDLE": "term_sender", "ORCA_PANE_KEY": "sender-tab:sender-leaf"}
        with patch.dict(os.environ, env, clear=True):
            result = self.step("operator-settle", result_ref=result_ref)
            self.assertEqual(result["state"], "operator_settled")
            self.assertFalse(result["execute_action"])
            self.assertEqual(self.step("operator-settle", result_ref=result_ref)["state"], "operator_settled")
        self.assertEqual(self.sends, [])
        state = read_json(self.state / "outbox.json")
        entry = next(iter(state["actions"].values()))
        self.assertTrue(entry["attempted"])
        self.assertIsNotNone(entry["claimed_at"])
        self.assertEqual(entry["result"], result_ref)
        self.assertEqual(entry["delivery"], {"kind": "operator_handoff",
            "sender": self.config["scheduler"], "settled_at": entry["delivery"]["settled_at"]})

    def test_operator_handoff_settlement_requires_bound_operator_sender(self):
        self.use_scheduler_sender()
        self.record["checkpoint"]["next_action"]["owner"] = "outer-operator"
        self.rewrite_record()
        result_ref = self.operator_handoff_result()
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_test",
                                     "ORCA_PANE_KEY": "sender-tab:sender-leaf"}, clear=True), \
                self.assertRaisesRegex(ValueError, "own_operator_terminal"):
            self.step("operator-settle", result_ref=result_ref)
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_sender",
                                     "ORCA_PANE_KEY": "wrong:pane"}, clear=True), \
                self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
            self.step("operator-settle", result_ref=result_ref)
        self.assertFalse((self.state / "outbox.json").exists())
        self.assertEqual(self.sends, [])

    def test_operator_settle_rejects_non_operator_or_control_evidence(self):
        self.use_scheduler_sender()
        result_ref = self.operator_handoff_result()
        env = {"ORCA_TERMINAL_HANDLE": "term_sender", "ORCA_PANE_KEY": "sender-tab:sender-leaf"}
        with patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(ValueError, "no_operator_handoff"):
            self.step("operator-settle", result_ref=result_ref)
        self.record["checkpoint"]["next_action"]["owner"] = "outer-operator"
        self.rewrite_record()
        control = self.operator_handoff_result("operator-control-result.json", file_ref(Path(self.config["checkpoint_head"])))
        with patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(ValueError, "tui_result_control_file_reference"):
            self.step("operator-settle", result_ref=control)
        self.assertFalse((self.state / "outbox.json").exists())
        self.assertEqual(self.sends, [])

    def test_one_pending_action_and_reused_id_cannot_execute_twice(self):
        self.step()
        self.record["checkpoint"]["next_action"]["id"] = "different"
        self.rewrite_record()
        with self.assertRaisesRegex(ValueError, "pending_continuation"):
            self.step()
        self.record["checkpoint"]["next_action"]["id"] = "action-fix"
        self.record["checkpoint"]["next_action"]["validation"] = "other"
        self.rewrite_record()
        with self.assertRaisesRegex(ValueError, "reused_or_checkpoint"):
            self.step()
        self.assertEqual(len(self.sends), 1)

    def test_deadline_stops_while_preserving_outbox(self):
        self.step()
        with patch("coordinator_tui_continue.now", return_value=self.config["deadline"]), self.assertRaisesRegex(ValueError, "deadline"):
            self.step("claim")
        self.assertIsNone(next(iter(read_json(self.state / "outbox.json")["actions"].values()))["claimed_at"])

    def without_deadline(self):
        self.config.update(schema_version=2, deadline=None,
                           scheduler=dict(terminal="sender", incarnation="inc", workspace="ws"))
        self.config_ref = self.t.ref("continue-config.json", self.config)

    def test_no_whole_run_deadline_keeps_context_expiry_and_action_window(self):
        self.without_deadline()
        result = check(self.config_ref, action_seconds=60, call=self.query)
        self.assertEqual(result["freshness"]["valid_until"], result["freshness"]["context_expires_at"])
        self.assertTrue(result["action_allowed"])
        self.assertFalse(check(self.config_ref, action_seconds=900, call=self.query)["action_allowed"])
        self.observer_mock.return_value["observed_at"] = (timestamp(now()) - timedelta(seconds=901)).isoformat()
        with self.assertRaises(ContextFreshnessError):
            check(self.config_ref, call=self.query)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_no_deadline_still_rejects_changed_owner(self):
        self.without_deadline()
        self.owner = "different"
        with self.assertRaisesRegex(ValueError, "run_owner_changed"):
            check(self.config_ref, call=self.query)
        self.assertEqual(self.sends, [])

    def test_null_deadline_cannot_relax_an_already_bound_config(self):
        from coordinator_io import publish_new
        self.config.update(schema_version=2,
                           scheduler=dict(terminal="sender", incarnation="inc", workspace="ws"))
        original = self.t.ref("original-config.json", self.config)
        publish_new(self.state / "tui-continuation-binding.json", original)
        self.without_deadline()
        with self.assertRaisesRegex(ValueError, "config_changed"):
            check(self.config_ref, call=self.query)
        self.assertEqual(self.sends, [])

    def test_deadline_must_be_explicit_and_null_requires_schema2(self):
        for version, value in ((1, None), (2, ""), (2, False), (2, 0), (2, {}),
                               (2, "never"), (2, "2026-10-28T12:00:00")):
            config = dict(self.config, schema_version=version, deadline=value)
            if version == 2:
                config["scheduler"] = dict(terminal="sender", incarnation="inc", workspace="ws")
            with self.subTest(version=version, value=value), self.assertRaisesRegex(ValueError, "deadline_invalid"):
                validate_config(config)
        self.without_deadline()
        del self.config["deadline"]
        with self.assertRaisesRegex(ValueError, "config_invalid"):
            validate_config(self.config)

    def test_schema2_explicit_deadline_still_expires(self):
        self.without_deadline()
        self.config["deadline"] = now()
        with self.assertRaisesRegex(ValueError, "tui_continuation_deadline"):
            validate_config(self.config)

    def test_null_deadline_still_checks_historical_gate_time_order(self):
        self.without_deadline()
        gate = read_json(self.config["dispatch_gate"]["path"])
        gate["completed_at"] = (timestamp(now()) + timedelta(seconds=300)).isoformat()
        self.config["dispatch_gate"] = self.t.ref("future-gate.json", gate)
        with self.assertRaisesRegex(ValueError, "tui_continuation_deadline"):
            validate_config(self.config)

    def test_two_actions_need_settlement_and_keep_original_caller(self):
        self.step()
        self.step("claim")
        first_ref = self.record_ref
        _, self.record["checkpoint"] = loop.LoopTests().fixture(statuses=("met", "actionable"))
        self.bind_domain()
        second_ref = self.t.ref("bootstrap/second.json", self.record)
        from coordinator_io import replace_json
        replace_json(self.t.f.bootstrap / "head.json", second_ref)
        with self.assertRaisesRegex(ValueError, "pending_continuation"):
            self.step(ref=second_ref)
        result = dict(action_id="action-fix", checkpoint=first_ref, status="executed",
                      evidence=[self.t.ref("bootstrap/output.json", {"changed": True})])
        result_ref = self.t.ref("bootstrap/result.json", result)
        self.assertEqual(self.step("settle", result_ref=result_ref)["state"], "settled")
        self.assertEqual(self.step(ref=second_ref)["state"], "enqueued")
        self.assertTrue(self.step("claim", ref=second_ref)["execute_action"])
        second_result = self.t.ref("bootstrap/second-result.json", dict(action_id="action-review",
            checkpoint=second_ref, status="executed",
            evidence=[self.t.ref("bootstrap/review-output.json", {"reviewed": True})]))
        self.assertEqual(self.step("settle", ref=second_ref, result_ref=second_result)["state"], "settled")
        self.assertFalse(self.step("claim", ref=second_ref)["execute_action"])
        self.assertTrue(all(entry["result"] for entry in read_json(self.state / "outbox.json")["actions"].values()))
        self.assertEqual(len(self.sends), 2)

    def test_settle_rejects_control_evidence_before_commit_then_accepts_snapshot(self):
        from coordinator_io import pinned, read_bytes, replace_json
        from coordinator_tui_continue import validate_scheduler_progress, validate_transition
        self.step()
        self.step("claim")
        journal_path = self.state / "outbox.json"
        before = read_bytes(journal_path)
        scheduler = self.state / "scheduler.json"
        publish_new(scheduler, {"stop": None})
        for index, target in enumerate((journal_path, scheduler, Path(self.config["checkpoint_head"]),
                                        self.state / "tui-continuation-binding.json")):
            with self.subTest(target=target.name):
                result = self.t.ref(f"bootstrap/control-result-{index}.json", dict(action_id="action-fix",
                    checkpoint=self.record_ref, status="executed", evidence=[file_ref(target)]))
                with self.assertRaisesRegex(ValueError, "tui_result_control_file_reference"):
                    self.step("settle", result_ref=result)
                self.assertEqual(read_bytes(journal_path), before)
                self.assertFalse(self.step("claim")["execute_action"])
        # Freeze actual pre-settlement bytes, not a fresh hash of later journal contents.
        snapshot_path = self.t.f.bootstrap / "outbox-snapshot.json"
        publish_new(snapshot_path, before)
        snapshot = file_ref(snapshot_path)
        result = self.t.ref("bootstrap/snapshot-result.json", dict(action_id="action-fix",
            checkpoint=self.record_ref, status="executed", evidence=[snapshot]))
        self.assertEqual(self.step("settle", result_ref=result)["state"], "settled")
        self.assertEqual(pinned(snapshot), before)
        _, self.record["checkpoint"] = loop.LoopTests().fixture(statuses=("met", "actionable"))
        self.bind_domain()
        next_ref = self.t.ref("bootstrap/next-checkpoint.json", self.record)
        replace_json(Path(self.config["checkpoint_head"]), next_ref)
        state = read_json(journal_path)
        validate_transition(state, self.record)
        validate_scheduler_progress(state, self.record)
        self.assertEqual(self.step(ref=next_ref)["state"], "enqueued")
        self.assertEqual(pinned(snapshot), before)
        self.assertEqual(len(self.sends), 2)

    def test_result_document_cannot_live_in_control_state(self):
        self.step()
        self.step("claim")
        before = (self.state / "outbox.json").read_bytes()
        result_path = self.state / "result.json"
        publish_new(result_path, dict(action_id="action-fix", checkpoint=self.record_ref,
            status="executed", evidence=[self.record_ref]))
        with self.assertRaisesRegex(ValueError, "tui_result_control_file_reference"):
            self.step("settle", result_ref=file_ref(result_path))
        self.assertEqual((self.state / "outbox.json").read_bytes(), before)

    def test_cli_reports_local_pin_mismatch_without_paths_or_hashes(self):
        from coordinator_io import replace_json
        replace_json(Path(self.config_ref["path"]), {"private": "secret-value"})
        status, result = self.cli("check")
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "file_pin_changed")
        self.assertEqual(result["recovery"], "preserve_original_pins_and_receipts_no_repin_or_replay")
        self.assertNotIn(str(self.t.f.root), json.dumps(result))
        self.assertNotIn("secret", json.dumps(result))

    def test_missing_initialization_has_safe_specific_errors_without_writes(self):
        for field, code in (("state_root", "tui_continuation_state_not_initialized"),
                            ("checkpoint_head", "tui_checkpoint_head_not_initialized")):
            original = self.config[field]
            self.config[field] = str(self.t.f.bootstrap / ("missing-" + field))
            self.config_ref = self.t.ref("continue-config.json", self.config)
            status, result = self.cli("check")
            self.assertEqual((status, result["error"]), (2, code))
            self.assertFalse(os.path.exists(self.config[field]))
            self.assertEqual(list(self.state.iterdir()), [])
            self.config[field] = original

    def test_projection_change_without_domain_recheck_is_rejected(self):
        self.record["checkpoint"]["next_action"]["validation"] = "weaker"
        self.rewrite_record(rebind=False)
        with self.assertRaisesRegex(ValueError, "domain_projection_mismatch"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_source_mutation_or_foreign_run_cannot_reuse_receipt(self):
        from coordinator_io import replace_json
        source_ref = self.record["domain_check"]["source"]
        source = read_json(source_ref["path"])
        for change, code in (({"run_id": "run_other"}, "checkpoint_identity"),
                             ({"observed_at": now()}, "receipt_binding")):
            replace_json(self.t.f.bootstrap / "tampered-source.json", dict(source, **change))
            self.record["domain_check"]["source"] = file_ref(self.t.f.bootstrap / "tampered-source.json")
            self.rewrite_record(rebind=False)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, code):
                self.step()
        self.assertEqual(self.sends, [])

    def test_receipt_checkpoint_digest_must_be_canonical_not_raw_file_hash(self):
        from coordinator_io import replace_json
        domain = self.record["domain_check"]
        receipt = read_json(domain["receipt"]["path"])
        receipt["authority_check"]["checkpoint_sha256"] = domain["source"]["sha256"]
        replace_json(self.t.f.bootstrap / "wrong-digest.json", receipt)
        domain["receipt"] = file_ref(self.t.f.bootstrap / "wrong-digest.json")
        self.rewrite_record(rebind=False)
        with self.assertRaisesRegex(ValueError, "receipt_binding"):
            self.step()
        self.assertEqual(self.sends, [])

    def test_changed_domain_evidence_during_claim_does_not_commit(self):
        self.step()
        fresh = self.observer_mock.return_value
        def tamper(**kwargs):
            from coordinator_io import replace_json
            replace_json(Path(self.record["domain_check"]["receipt"]["path"]), {"ok": False})
            return fresh
        calls = 0
        def observe(**kwargs):
            nonlocal calls
            calls += 1
            return tamper() if calls == 2 else fresh
        self.observer_mock.side_effect = observe
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.step("claim")
        self.assertIsNone(next(iter(read_json(self.state / "outbox.json")["actions"].values()))["claimed_at"])

    def test_superseded_checkpoint_not_claimed_even_if_message_arrives(self):
        self.step()
        from coordinator_io import replace_json
        replace_json(self.t.f.bootstrap / "head.json", self.t.ref("bootstrap/new-checkpoint.json", {"decision": "complete"}))
        with self.assertRaisesRegex(ValueError, "checkpoint_superseded"):
            self.step("claim")
        self.assertEqual(len(self.sends), 1)

    def test_receipt_internal_authority_pins_and_schema_must_agree(self):
        from coordinator_io import replace_json
        domain = self.record["domain_check"]
        original = read_json(domain["receipt"]["path"])
        for key, value in (("schema_version", True), ("grants_authority", True),
                           ("authority_sha256", "d" * 64), ("context_sha256", "d" * 64)):
            receipt = copy.deepcopy(original)
            receipt["authority_check"][key] = value
            replace_json(self.t.f.bootstrap / "bad-receipt.json", receipt)
            domain["receipt"] = file_ref(self.t.f.bootstrap / "bad-receipt.json")
            self.rewrite_record(rebind=False)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "tui_domain_receipt"):
                self.step()
        self.assertEqual(self.sends, [])

    def test_final_fences_repin_projection_and_domain_for_all_mutations(self):
        from coordinator_io import replace_json
        for mode in ("enqueue", "claim", "settle"):
            for changed in ("projection", "receipt"):
                with self.subTest(mode=mode, changed=changed):
                    fixture = ContinuationTests()
                    fixture.setUp()
                    try:
                        if mode != "enqueue": fixture.step()
                        result = None
                        if mode == "settle":
                            fixture.step("claim")
                            result = fixture.t.ref("bootstrap/result.json", dict(action_id="action-fix",
                                checkpoint=fixture.record_ref, status="executed", evidence=[fixture.record_ref]))
                        calls = 0
                        fresh = fixture.observer_mock.return_value
                        def observe(**kwargs):
                            nonlocal calls
                            calls += 1
                            if calls == 2:
                                target = fixture.record_path if changed == "projection" else Path(
                                    fixture.record["domain_check"]["receipt"]["path"])
                                replace_json(target, {"tampered": True})
                            return fresh
                        fixture.observer_mock.side_effect = observe
                        before_sends = len(fixture.sends)
                        with fixture.assertRaisesRegex(ValueError, "file_pin_changed"):
                            fixture.step(mode, result_ref=result)
                        entry = next(iter(read_json(fixture.state / "outbox.json")["actions"].values()))
                        self.assertEqual(len(fixture.sends), before_sends)
                        self.assertIsNone(entry["result"])
                        if mode != "settle": self.assertIsNone(entry["claimed_at"])
                    finally:
                        fixture.doCleanups()

    def test_unknown_or_empty_action_result_cannot_advance(self):
        self.step()
        self.step("claim")
        for status, evidence in (("unknown", [self.record_ref]), ("executed", [])):
            result = self.t.ref("bootstrap/bad-result.json", dict(action_id="action-fix", checkpoint=self.record_ref,
                                                                 status=status, evidence=evidence))
            with self.assertRaisesRegex(ValueError, "executed_action_evidence"):
                self.step("settle", result_ref=result)

    def test_check_is_read_only_and_does_not_grant_an_action(self):
        result = check(self.config_ref, call=self.query)
        self.assertFalse(result["execute_action"])
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual(self.sends, [])
        self.assertIn("checkpoint_by", result["freshness"])

    def test_freshness_checkpoint_boundary_and_deadline_never_extended(self):
        observed = timestamp(now())
        evidence = {"observed_at": observed.isoformat()}
        deadline = (observed + timedelta(hours=1)).isoformat()
        for age, due in ((719, False), (720, True), (899, True)):
            with self.subTest(age=age), patch("coordinator_tui_continue.now", return_value=(observed + timedelta(seconds=age)).isoformat()):
                result = freshness(self.c, evidence, deadline)
                self.assertEqual(result["checkpoint_due"], due)
                self.assertEqual(result["context_age_seconds"], age)
                self.assertEqual(timestamp(result["checkpoint_by"]), observed + timedelta(seconds=720))
        early = (observed + timedelta(seconds=100)).isoformat()
        with patch("coordinator_tui_continue.now", return_value=observed.isoformat()):
            result = freshness(self.c, evidence, early)
        self.assertEqual(result["valid_until"], early)
        self.assertTrue(result["checkpoint_due"])

    def test_expiry_during_native_fence_stops_before_outbox(self):
        self.observer_mock.return_value["observed_at"] = (timestamp(now()) - timedelta(seconds=901)).isoformat()
        with self.assertRaises(ContextFreshnessError):
            self.step()
        self.assertFalse((self.state / "outbox.json").exists())
        self.assertEqual(self.sends, [])

    def test_presend_validation_failure_is_not_an_ambiguous_send(self):
        fresh = self.observer_mock.return_value
        self.observer_mock.side_effect = [fresh, ContextFreshnessError(901, 900)]
        with self.assertRaises(ContextFreshnessError):
            self.step()
        entry = next(iter(read_json(self.state / "outbox.json")["actions"].values()))
        self.assertFalse(entry["attempted"])
        self.assertEqual(self.sends, [])
        self.observer_mock.side_effect = None
        self.assertEqual(self.step()["state"], "enqueued")
        self.assertEqual(len(self.sends), 1)
        self.assertFalse(any(a[:2] == ["orchestration", "request-show"] for a in self.calls))

    def test_new_real_turn_revalidates_same_pins_after_stale_turn(self):
        # Real log reader + real hook/anchor parser, mocked native read receipts.
        self.observer.stop()
        from coordinator_io import replace_json
        self.c["workspace"]["path"] = str(self.t.f.cwd)
        self.c["role_skill"] = self.t.ref(self.t.f.cwd / "SKILL.md", "test role")
        replace_json(self.t.f.root / "contract.json", self.c)
        self.config["contract"] = self.contract_ref = file_ref(self.t.f.root / "contract.json")
        gate = read_json(self.config["dispatch_gate"]["path"])
        gate.update(contract_sha256=self.contract_ref["sha256"],
                    identity_sha256=digest(canonical(identity(self.c))))
        self.config["dispatch_gate"] = self.t.ref("gate.json", gate)
        self.config["deadline"] = (timestamp(now()) + timedelta(hours=1)).isoformat()
        self.config_ref = self.t.ref("continue-config.json", self.config)
        future = datetime.now(timezone.utc) + timedelta(seconds=901)
        frozen = unittest.mock.MagicMock(wraps=datetime)
        frozen.now.return_value = future
        self.t.entry.update(receivedAt=future.timestamp() * 1000,
                            evidenceObservedAt=future.timestamp() * 1000)
        self.t.write_state()
        original_pins = copy.deepcopy(self.config_ref)
        with patch("trae_tui.native", side_effect=self.t.query), patch("trae_tui.datetime", frozen), \
                patch("trae_coordinator.datetime", frozen), \
                patch("coordinator_tui_continue.now", return_value=future.isoformat()):
            with self.assertRaises(ContextFreshnessError):
                check(self.config_ref, call=self.query)
            # A fixture append models a provider-produced NEW real turn only.
            # Production code never writes/refreshes provider logs.
            self.t.f.context["timestamp"] = future.isoformat()
            with self.t.f.log.open("a") as stream:
                stream.write(json.dumps(self.t.f.context) + "\n")
            result = check(self.config_ref, call=self.query)
            self.assertEqual(result["freshness"]["context_observed_at"], future.isoformat())
            self.assertEqual(self.step()["state"], "enqueued")
            with self.assertRaisesRegex(ValueError, "new_real_turn_required"):
                self.step("claim")
            next_turn = future + timedelta(seconds=1)
            frozen.now.return_value = next_turn
            self.t.f.context["timestamp"] = next_turn.isoformat()
            with self.t.f.log.open("a") as stream:
                stream.write(json.dumps(self.t.f.context) + "\n")
            with patch("coordinator_tui_continue.now", return_value=next_turn.isoformat()):
                self.assertTrue(self.step("claim")["execute_action"])
                self.assertFalse(self.step("claim")["execute_action"])
        self.assertEqual(self.config_ref, original_pins)
        self.assertEqual(len(self.sends), 1)

    def cli(self, mode, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = main([mode, "--config", self.config_ref["path"],
                           "--config-sha256", self.config_ref["sha256"], *extra])
        return status, json.loads(out.getvalue())

    def test_cli_reports_freshness_and_redacts_unknown_failures(self):
        with patch("coordinator_tui_continue.check", side_effect=ContextFreshnessError(1284.063, 900)):
            status, result = self.cli("check")
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "session_context_stale")
        self.assertEqual(result["age_seconds"], 1284.063)
        for exc in (ValueError("secret-token"), ValueError("file_pin_changed"), OSError("private-path"),
                    subprocess.CalledProcessError(1, "secret-cmd", output="secret-output")):
            with patch("coordinator_tui_continue.check", side_effect=exc):
                _, result = self.cli("check")
            self.assertEqual(result["error"], "tui_continuation_stopped_preserve_receipts")
            self.assertNotIn("secret", json.dumps(result))

    def test_cli_check_disallows_mutation_arguments(self):
        with patch("coordinator_tui_continue.check") as checked:
            status, result = self.cli("check", "--execute")
        checked.assert_not_called()
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "tui_check_read_only_arguments_required")

    def test_cli_apply_scheduler_review_clear_is_pinned_and_idempotent(self):
        stop = self.scheduler_stop()
        clear_ref, _ = self.scheduler_review_clear_ref(stop)
        status, result = self.cli("apply-review-clear", "--execute",
                                  "--review-clear", clear_ref["path"],
                                  "--review-clear-sha256", clear_ref["sha256"])
        self.assertEqual(status, 0)
        self.assertEqual(result["state"], "scheduler_review_clear_applied")
        journal = read_json(self.state / "scheduler.json")
        self.assertEqual(journal["stop"], stop)
        self.assertEqual(journal["review_clear"], clear_ref)
        before = (self.state / "scheduler.json").read_bytes()
        status, result = self.cli("apply-review-clear", "--execute",
                                  "--review-clear", clear_ref["path"],
                                  "--review-clear-sha256", clear_ref["sha256"])
        self.assertEqual(status, 0)
        self.assertEqual(result["state"], "scheduler_review_clear_already_applied")
        self.assertEqual((self.state / "scheduler.json").read_bytes(), before)
        other_ref, _ = self.scheduler_review_clear_ref(stop, "review-clear-other.json")
        status, result = self.cli("apply-review-clear", "--execute",
                                  "--review-clear", other_ref["path"],
                                  "--review-clear-sha256", other_ref["sha256"])
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "tui_scheduler_review_clear_conflict")
        self.assertEqual((self.state / "scheduler.json").read_bytes(), before)

    def test_cli_apply_scheduler_review_clear_rejects_unbound_domain(self):
        stop = self.scheduler_stop()
        wrong = copy.deepcopy(read_json(stop["checkpoint"]["path"])["domain_check"])
        wrong["source"] = wrong["receipt"]
        clear_ref, _ = self.scheduler_review_clear_ref(stop, "review-clear-wrong-domain.json",
                                                       domain_check=wrong)
        status, result = self.cli("apply-review-clear", "--execute",
                                  "--review-clear", clear_ref["path"],
                                  "--review-clear-sha256", clear_ref["sha256"])
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "tui_scheduler_review_clear_binding_mismatch")
        self.assertNotIn("review_clear", read_json(self.state / "scheduler.json"))

    def test_check_rejects_changed_config_binding_without_writes(self):
        self.step()
        before = (self.state / "outbox.json").read_bytes()
        self.config["deadline"] = (timestamp(now()) + timedelta(hours=2)).isoformat()
        other = self.t.ref("changed-config.json", self.config)
        with self.assertRaisesRegex(ValueError, "config_changed"):
            check(other, call=self.query)
        self.assertEqual((self.state / "outbox.json").read_bytes(), before)
        self.assertEqual(len(self.sends), 1)

    def test_expiry_on_final_claim_and_settle_fences_does_not_commit(self):
        self.step()
        fresh = self.observer_mock.return_value
        expired = dict(fresh, observed_at=(timestamp(now()) - timedelta(seconds=901)).isoformat())
        self.observer_mock.side_effect = [fresh, expired]
        with self.assertRaises(ContextFreshnessError):
            self.step("claim")
        entry = next(iter(read_json(self.state / "outbox.json")["actions"].values()))
        self.assertIsNone(entry["claimed_at"])
        self.observer_mock.side_effect = None
        self.step("claim")
        result = self.t.ref("bootstrap/result.json", dict(action_id="action-fix", checkpoint=self.record_ref,
                           status="executed", evidence=[self.t.ref("bootstrap/proof.json", {"changed": True})]))
        self.observer_mock.side_effect = [fresh, expired]
        with self.assertRaises(ContextFreshnessError):
            self.step("settle", result_ref=result)
        entry = next(iter(read_json(self.state / "outbox.json")["actions"].values()))
        self.assertIsNotNone(entry["claimed_at"])
        self.assertIsNone(entry["result"])
        self.assertEqual(len(self.sends), 1)

    def test_check_rejects_retired_or_replaced_owner(self):
        self.owner = None
        with self.assertRaisesRegex(ValueError, "run_owner_changed"):
            check(self.config_ref, call=self.query)
        self.assertEqual(list(self.state.iterdir()), [])

    def test_future_context_remains_rejected(self):
        self.observer_mock.return_value["observed_at"] = (timestamp(now()) + timedelta(seconds=100)).isoformat()
        with self.assertRaises(ContextFreshnessError) as caught:
            check(self.config_ref, call=self.query)
        self.assertEqual(caught.exception.code, "session_context_in_future")
        self.assertEqual(self.sends, [])


if __name__ == "__main__":
    unittest.main()


class ContinuationFenceRoutingTests(unittest.TestCase):
    """The fence must route through the contract's own adapter, not a Trae default."""

    def contract(self, adapter):
        return {"adapter": adapter, "cli": {"path": "/bin/true"}, "runtime": "rt",
                "coordinator": {"terminal": "term_x", "incarnation": "inc", "session": "sid"},
                "run": {"id": "run_x", "generation": 1},
                "workspace": {"id": "wt", "path": "/tmp"},
                "observation": {"profile": "/tmp", "caller_receipt": {"path": "/tmp/c.json", "sha256": "0" * 64},
                                "log_root": "/tmp", "roots": ["/tmp"], "startup_anchor": None},
                "freshness": {"context_max_age_seconds": 900},
                "runtime_config": {"path": "/tmp/policy.json", "sha256": "1" * 64}}

    def run_fence(self, adapter):
        import coordinator_tui_continue as module
        import tui_adapter

        seen = {}

        def observer(**kwargs):
            seen.update(kwargs)
            return {"thread_id": "sid"}

        def call(cli, runtime, args):
            if args[:2] == ["terminal", "show"]:
                return {"terminal": {"incarnationId": "inc", "worktreeId": "wt",
                                     "agentIdentity": tui_adapter.provider(adapter),
                                     "connected": True, "orphaned": False}}
            if args[:2] == ["orchestration", "run-show"]:
                return {"coordinatorPolicy": "strict-v1",
                        "run": {"id": "run_x", "coordinator_handle": "term_x", "consumer_generation": 1}}
            return {"caller": {"paneKey": "p", "terminalHandle": "term_x"}}

        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_x"}), \
                patch.object(module.tui_adapter, "reader",
                             side_effect=lambda a: (observer, "trae_runtime_config"
                                                    if a == tui_adapter.TRAE_ADAPTER else "pi_policy")), \
                patch.object(module.tui_adapter, "input_value", return_value={"path": "/tmp/policy.json"}), \
                patch.object(module, "live_runtime_epoch", return_value=("rt", {"caller": {"paneKey": "p"}}, None)), \
                patch.object(module, "caller_result", return_value={"caller": {"paneKey": "p"}}), \
                patch.object(module, "pinned", return_value=b"{}"):
            module.fence_with_runtime(self.contract(adapter), call)
        return seen

    def test_a_pi_contract_gets_the_pi_policy_and_no_trae_arguments(self):
        import tui_adapter

        seen = self.run_fence(tui_adapter.PI_ADAPTER)
        self.assertEqual(seen["pi_policy"], {"path": "/tmp/policy.json"})
        self.assertNotIn("trae_runtime_config", seen)
        self.assertNotIn("accepted_runtime_rebind", seen)
        self.assertEqual(seen["caller_receipt_runtime"], "rt")
        self.assertEqual(seen["expected_thread"], "sid")

    def test_a_trae_contract_keeps_its_rebind_argument(self):
        import tui_adapter

        seen = self.run_fence(tui_adapter.TRAE_ADAPTER)
        self.assertIn("trae_runtime_config", seen)
        self.assertEqual(seen["accepted_runtime_rebind"], None)


class ContinuationAdapterTests(unittest.TestCase):
    """Any reviewed TUI adapter may continue its own Run; anything else is named."""

    def test_the_adapter_seam_covers_both_providers_and_refuses_the_rest(self):
        import tui_adapter

        for adapter in (TUI_ADAPTER, tui_adapter.PI_ADAPTER):
            with self.subTest(adapter=adapter):
                self.assertTrue(tui_adapter.is_tui(adapter))
                self.assertIsNotNone(tui_adapter.provider(adapter))
                observer, key = tui_adapter.reader(adapter)
                self.assertTrue(callable(observer) and isinstance(key, str))
        for adapter in (tui_adapter.EXEC_ADAPTER, None, "unknown-adapter"):
            with self.subTest(adapter=adapter):
                self.assertFalse(tui_adapter.is_tui(adapter))
