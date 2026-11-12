"""Offline source observations; no native seal, recovery or live acceptance."""

import copy
from datetime import timedelta
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import (LockBusy, canonical, digest, directory_lock, file_ref, now, publish_new,
                            read_json, replace_json, timestamp)
from coordinator_tui_scheduler import WaitNotReady
from terminal_idle_wait import IdleWaitResult
from progress_watch import StopObservation, decode_response
import operator_continuity_source as source
import operator_monitor_deploy as deploy
import operators.test_operator_monitor_recovery as recovery_fixture


class SourceObservationTests(unittest.TestCase):
    def setUp(self):
        self.r = recovery_fixture.RecoveryTests()
        self.r.setUp()
        self.addCleanup(self.r.doCleanups)
        self.f, self.m = self.r.f, self.r.m
        # The source observer never initializes a missing workflow lock.
        with directory_lock(self.f.state, "tui-workflow"):
            pass
        self.operator = self.f.c["operator"]
        self.actor = dict(terminalHandle=self.operator["terminal"], paneKey="prepare-tab:prepare-leaf",
                          processIncarnation="prepare-pty:" + self.operator["incarnation"],
                          hostScope={"kind": "local", "hostId": "host"}, authorityFingerprint="b" * 64)
        self.caller_calls = []
        payload = canonical(dict(kind="coordinator_tui_continue_v1", config=self.f.config_ref,
            checkpoint=self.f.record_ref, action_id=self.f.record["checkpoint"]["next_action"]["id"])).decode()
        self.m.messages[0]["payload"] = payload
        for receipt in self.m.receipts.values():
            receipt["message"]["payload"] = payload

    def call(self, args, runtime, timeout=20):
        if args == ["terminal", "show", "--terminal", self.operator["terminal"]]:
            return dict(terminal=dict(handle=self.operator["terminal"], incarnationId=self.operator["incarnation"],
                agentIdentity=self.operator["provider"], connected=True, orphaned=False,
                tabId="prepare-tab", leafId="prepare-leaf"))
        return self.r.call(args, runtime, timeout)

    def caller(self, cli, runtime, args):
        self.assertEqual(cli, self.f.c["cli"]["path"])
        self.assertEqual(runtime, self.f.c["runtime"])
        self.assertEqual(args, ["orchestration", "strict-caller-check"])
        self.caller_calls.append(args)
        return dict(coordinatorPolicy="strict-v1", effectsApplied=False, checkedAt=now(), caller=copy.deepcopy(self.actor))

    def observe(self, **kwargs):
        return source.observe_source(self.r.d.ref, call=kwargs.pop("call", self.call),
            caller_call=kwargs.pop("caller_call", self.caller),
            observe_turn=kwargs.pop("observe_turn", lambda *_: copy.deepcopy(self.r.s.ended)), **kwargs)

    def state_files(self):
        return {str(p): file_ref(p) for root in (self.f.state, self.m.state_root, self.r.output)
                for p in root.rglob("*") if p.is_file()}

    def test_success_is_deterministic_read_only_not_a_seal(self):
        before = self.state_files()
        a, b = self.observe(), self.observe()
        self.assertEqual(a["observation_canonical_sha256"], b["observation_canonical_sha256"])
        self.assertEqual(a["observation"], b["observation"])
        self.assertFalse(a["execution_authorized"])
        self.assertFalse(a["server_continuity_verified"])
        self.assertFalse(a["reusable_as_seal"])
        self.assertFalse(a["locks_held_after_return"])
        self.assertEqual(a["observation"]["scope"]["projection"]["coverage"], "deployment_direct_refs_only")
        self.assertEqual(self.state_files(), before)
        self.assertEqual(self.r.mutations, [])
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(len(self.caller_calls), 8)

    def seal(self, output):
        return source.seal_source(self.r.d.ref, str(output), expires_at_ms=123456789,
            call=self.call, caller_call=self.caller, observe_turn=lambda *_: copy.deepcopy(self.r.s.ended))

    def native_maintenance(self, cli, runtime, request, **_):
        self.assertEqual(cli, self.f.c["cli"])
        self.assertEqual(runtime, self.f.c["runtime"])
        for root, name in ((self.m.state_root, "monitor"), (self.f.state, "tui-continuation"),
                           (self.f.state, "tui-workflow")):
            with self.assertRaises(LockBusy), directory_lock(root, name, create=False):
                self.fail("released before native freeze")
        if request["phase"] == "prepare":
            value = dict(proposal=request["proposal"], proposalCanonicalSha256=request["proposalCanonicalSha256"],
                         runId=request["runId"])
            return dict(preparation=value, preparationCanonicalSha256=digest(canonical(value)))
        self.assertEqual(request["phase"], "seal")
        value = dict(runId=self.f.c["run"]["id"], sourceRuntimeId=runtime)
        return dict(seal=value, sealCanonicalSha256=digest(canonical(value)))

    def test_seal_holds_original_locks_through_native_calls_and_publishes_pins(self):
        output = self.r.output.parent / "native-seal"
        output.mkdir(mode=0o700)
        with patch("operator_continuity_route.maintenance_call", side_effect=self.native_maintenance) as call:
            result = self.seal(output)
        self.assertEqual([c.args[2]["phase"] for c in call.call_args_list], ["prepare", "seal"])
        self.assertEqual(result["state"], "sealed_awaiting_independent_review")
        for key in ("source", "preparation", "seal"):
            self.assertEqual(result[key], file_ref(output / (key + ".json")))
        with patch("operator_continuity_route.maintenance_call") as call:
            with self.assertRaisesRegex(ValueError, "fresh_output"):
                self.seal(output)
            call.assert_not_called()
        self.assertEqual(self.r.mutations, [])
        self.observe()

    def test_seal_failure_preserves_source_and_preparation_without_retrying(self):
        output = self.r.output.parent / "failed-native-seal"
        output.mkdir(mode=0o700)
        def failed(cli, runtime, request, **kwargs):
            result = self.native_maintenance(cli, runtime, request, **kwargs)
            if request["phase"] == "seal":
                raise PermissionError("runtime_access_denied")
            return result
        with patch("operator_continuity_route.maintenance_call", side_effect=failed) as call:
            with self.assertRaisesRegex(PermissionError, "runtime_access_denied"):
                self.seal(output)
        self.assertEqual(call.call_count, 2)
        self.assertEqual({p.name for p in output.iterdir()}, {"source.json", "preparation.json"})
        self.observe()

    def test_projection_has_direct_refs_and_separate_code_without_expanding_json(self):
        a = self.observe()["observation"]
        scope = a["scope"]["projection"]
        refs = scope["evidence_refs"]
        for ref in (self.r.d.ref, self.f.contract_ref, self.f.config_ref, self.f.record_ref,
                    self.f.record["domain_check"]["source"], self.f.record["domain_check"]["receipt"],
                    self.f.config["acceptance"], self.f.config["dispatch_gate"]):
            self.assertIn(ref, refs)
        self.assertEqual(len(refs), len({ref["path"] for ref in refs}))
        self.assertEqual(scope["code_refs"], [self.f.c["cli"], *self.r.d.plan["sources"]])
        self.assertEqual(len(a["locks"]), 3)

    def test_missing_lock_stays_missing_and_makes_no_native_calls(self):
        target = self.f.state / "tui-workflow.lock"
        target.unlink()  # Temporary fixture only.
        before = self.state_files()
        with self.assertRaises(FileNotFoundError):
            self.observe()
        self.assertEqual(before, self.state_files())
        self.assertEqual(self.caller_calls, [])

    def test_each_original_lock_excludes_preparation(self):
        for root, name in ((self.m.state_root, "monitor"), (self.f.state, "tui-continuation"),
                           (self.f.state, "tui-workflow")):
            with self.subTest(lock=name), directory_lock(root, name, create=False):
                with self.assertRaises(LockBusy):
                    self.observe()
        self.assertEqual(self.caller_calls, [])
        self.observe()  # All partial acquisitions were released.

    def test_observations_hold_all_locks_until_return(self):
        def ended(*_):
            for root, name in ((self.m.state_root, "monitor"), (self.f.state, "tui-continuation"),
                               (self.f.state, "tui-workflow")):
                with self.assertRaises(LockBusy), directory_lock(root, name, create=False):
                    self.fail("released too early")
            return copy.deepcopy(self.r.s.ended)
        self.observe(observe_turn=ended)

    def test_borrowed_environment_cannot_replace_native_caller(self):
        self.actor["terminalHandle"] = "foreign"
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE=self.operator["terminal"]):
            with self.assertRaisesRegex(ValueError, "wrong_caller"):
                self.observe()
        self.assertEqual(self.r.mutations, [])

    def test_caller_expiry_and_native_denial_never_fallback_to_terminal_show(self):
        def stale(*args):
            value = self.caller(*args)
            value["checkedAt"] = (timestamp(now()) - timedelta(seconds=1)).isoformat()
            return value
        with self.assertRaisesRegex(ValueError, "caller_not_fresh"):
            self.observe(caller_call=stale)
        with self.assertRaises(PermissionError):
            self.observe(caller_call=lambda *_: (_ for _ in ()).throw(PermissionError("denied")))

    def test_caller_or_operator_changes_are_refused(self):
        def changed(*args):
            value = self.caller(*args)
            if len(self.caller_calls) > 1:
                value["caller"]["authorityFingerprint"] = "c" * 64
            return value
        with self.assertRaisesRegex(ValueError, "caller_changed"):
            self.observe(caller_call=changed)
        def terminal(args, *rest):
            value = self.call(args, *rest)
            if args[-1] == self.operator["terminal"]:
                value["terminal"]["incarnationId"] = "replaced"
            return value
        with self.assertRaisesRegex(ValueError, "operator_changed"):
            self.observe(call=terminal)

    def test_runtime_mismatch_is_not_accepted_even_with_identical_rows(self):
        def restarted(args, runtime, timeout=20):
            return decode_response(canonical(dict(ok=True, result=self.call(args, runtime, timeout),
                _meta=dict(runtimeId="replacement-runtime"))), 0, runtime)
        with self.assertRaisesRegex(StopObservation, "runtime_mismatch"):
            self.observe(call=restarted)

    def test_busy_timeout_interaction_and_missing_completed_turn_fail_closed(self):
        for state in ("pending", "interaction_required"):
            def wait(*_):
                raise WaitNotReady(IdleWaitResult(state, "fixture"))
            with self.subTest(state=state), self.assertRaises(WaitNotReady):
                self.observe(observe_turn=wait)
        with self.assertRaisesRegex(ValueError, "completed_turn_required"):
            self.observe(observe_turn=lambda *_: None)

    def test_busy_to_idle_turn_change_does_not_count_as_stable(self):
        count = 0
        def turn(*_):
            nonlocal count
            count += 1
            value = copy.deepcopy(self.r.s.ended)
            value["completed_turn"]["turn_id"] += str(count)
            return value
        with self.assertRaisesRegex(ValueError, "native_state_changed"):
            self.observe(observe_turn=turn)

    def test_default_completed_observer_requires_typed_native_wait(self):
        waits = []
        def call(args, *rest):
            if args[:2] == ["terminal", "wait"]:
                waits.append(args)
                return IdleWaitResult("ready")
            return self.call(args, *rest)
        with patch("trae_tui.observe", return_value=copy.deepcopy(self.r.s.ended)) as observer:
            source.observe_source(self.r.d.ref, call=call, caller_call=self.caller)
            self.assertEqual(observer.call_count, 2)
            self.assertTrue(observer.call_args.kwargs["completed_turn"])
        self.assertEqual(len(waits), 2)
        self.assertTrue(all(args[3] == self.f.c["coordinator"]["terminal"] for args in waits))

    def test_sender_pane_change_during_wait_is_refused(self):
        def turn(*_):
            self.m.operator_terminal["leafId"] = "replacement-leaf"
            return copy.deepcopy(self.r.s.ended)
        with self.assertRaisesRegex(ValueError, "sender_changed"):
            self.observe(observe_turn=turn)

    def test_pending_message_acked_between_observations_is_refused(self):
        count = 0
        def turn(*_):
            nonlocal count
            count += 1
            if count == 2:
                self.m.messages[0]["read"] = 1
            return copy.deepcopy(self.r.s.ended)
        with self.assertRaisesRegex(ValueError, "exact_pending"):
            self.observe(observe_turn=turn)
        self.assertEqual(self.r.mutations, [])

    def test_permission_error_releases_locks_without_publication(self):
        before = self.state_files()
        def denied(*_):
            raise PermissionError("runtime_access_denied")
        with self.assertRaises(PermissionError):
            self.observe(call=denied)
        self.assertEqual(self.state_files(), before)
        self.observe()

    def test_missing_unknown_wrong_request_and_payload_refused(self):
        for mode in ("missing", "pending", "wrong_method", "wrong_id", "payload"):
            def bad(args, *rest):
                value = copy.deepcopy(self.call(args, *rest))
                if args[:2] == ["orchestration", "request-show"]:
                    if mode == "missing":
                        return {}
                    if mode == "pending":
                        value["state"] = "pending"
                    if mode == "wrong_method":
                        value["method"] = "orchestration.check"
                    if mode == "wrong_id":
                        value["receipt"]["message"]["id"] = "foreign"
                    if mode == "payload":
                        value["receipt"]["message"]["payload"] = "{}"
                return value
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, "source_request"):
                self.observe(call=bad)

    def test_acked_or_additional_pending_message_is_not_reconciled(self):
        self.m.messages[0]["read"] = 1
        with self.assertRaisesRegex(ValueError, "exact_pending"):
            self.observe()
        self.m.messages[0]["read"] = 0
        self.m.messages.append({**self.m.messages[0], "id": "independent-fact"})
        with self.assertRaisesRegex(ValueError, "exact_pending"):
            self.observe()
        self.assertEqual(self.r.mutations, [])

    def test_acked_history_is_not_misread_as_pending(self):
        self.m.messages[:0] = [{**self.m.messages[0], "id": str(n), "read": 1} for n in range(1100)]
        self.observe()
        self.assertTrue(all("--pending" in args for args in self.m.calls if args[:2] == ["orchestration", "inbox"]))

    def test_head_evidence_and_code_drift_refused(self):
        for target in (self.f.config["checkpoint_head"], self.f.record["domain_check"]["receipt"]["path"]):
            path = Path(target)
            previous = read_json(path)
            def drift(*_):
                replace_json(path, {"changed": True})
                return copy.deepcopy(self.r.s.ended)
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.observe(observe_turn=drift)
            replace_json(path, previous)
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "source_changed"):
                self.observe()

    def test_claim_and_stop_arriving_during_observation_refused(self):
        def claimed(*_):
            value = read_json(self.f.state / "outbox.json")
            next(iter(value["actions"].values()))["claimed_at"] = now()
            replace_json(self.f.state / "outbox.json", value)
            return copy.deepcopy(self.r.s.ended)
        with self.assertRaisesRegex(ValueError, "unclaimed"):
            self.observe(observe_turn=claimed)
        publish_new(self.m.state_root / "STOP", b"operator stop")
        with self.assertRaisesRegex(ValueError, "manual_stop"):
            self.observe()

    def test_changed_lock_inode_is_rejected_at_exit(self):
        def replaced(*_):
            replace_json(self.f.state / "tui-workflow.lock", {})
            return copy.deepcopy(self.r.s.ended)
        with self.assertRaisesRegex(ValueError, "files_changed|existing_lock_changed"):
            self.observe(observe_turn=replaced)
        self.assertEqual(self.r.mutations, [])

    def test_final_same_content_lock_replacement_is_still_rejected(self):
        calls = 0
        original = source.deployment_scope
        target = self.f.state / "tui-workflow.lock"
        def replace_after_last_scope(*args):
            nonlocal calls
            calls += 1
            value = original(*args)
            if calls == 3:
                saved = target.read_bytes()
                temporary = self.f.state / "replacement-lock"
                publish_new(temporary, saved)
                os.replace(temporary, target)
            return value
        with patch.object(source, "deployment_scope", side_effect=replace_after_last_scope):
            with self.assertRaisesRegex(ValueError, "existing_lock_changed"):
                self.observe()


if __name__ == "__main__":
    unittest.main()
