"""Pi Co-ordinator observation: policy, transcript, hook and anchor semantics.

No Agent, socket or live runtime is used. The fake native layer answers only the
three read-only queries the observer makes, so the real `runtime_binding` capture
and the real Pi transcript reader run against ordinary files.
"""

import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, now, publish_new, timestamp
from coordinator_strict_request import observed_coordinator
from coordinator_startup import identity, validate
from pi_tui import observe
import pi_policy
import pi_transcript
import tui_adapter
from operators import test_operator_startup_identity as operator_startup

LAUNCH_TOKEN = "pi-test-only-launch-token"
LAUNCH_HASH = digest(canonical(LAUNCH_TOKEN))


class PiPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-policy-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.value = dict(schema_version=1, scope="swarm_coordinator_only", provider="pi",
                          model={"provider": "anthropic", "id": "claude-sonnet"},
                          thinking_level="high")

    def published(self, name, value):
        target = self.root / name
        publish_new(target, value)
        return target

    def test_valid_policy_reports_only_attestable_settings(self):
        self.assertEqual(pi_policy.read(str(self.published("policy.json", self.value))),
                         {"model_provider": "anthropic", "model": "claude-sonnet",
                          "thinking_level": "high"})

    def test_policy_shape_is_exact_and_fail_closed(self):
        cases = [dict(self.value, extra=1), {k: v for k, v in self.value.items() if k != "scope"},
                 dict(self.value, schema_version=True), dict(self.value, schema_version=2),
                 dict(self.value, provider="trae"), dict(self.value, thinking_level=""),
                 dict(self.value, model={"provider": "anthropic"}),
                 dict(self.value, model={"provider": "anthropic", "id": "x", "extra": 1})]
        for index, value in enumerate(cases):
            with self.subTest(case=index):
                path = self.published(f"bad-{index}.json", value)
                with self.assertRaises(ValueError):
                    pi_policy.read(str(path))

    def test_policy_must_be_a_complete_canonical_file(self):
        target = self.root / "spaces.json"
        target.write_text("   \n")
        with self.assertRaisesRegex(ValueError, "pi_runtime_policy_truncated"):
            pi_policy.read(str(target))
        link = self.root / "linked.json"
        link.symlink_to(self.published("policy.json", self.value))
        with self.assertRaisesRegex(ValueError, "pi_runtime_policy_path_invalid"):
            pi_policy.read(str(link))


class PiTuiFixture(unittest.TestCase):
    RUNTIME_ID = "runtime_pi"
    WORKSPACE_ID = "workspace_pi"
    TERMINAL = "term_pi"
    INCARNATION = "inc_pi"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-tui-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.cwd = self.root / "work"
        self.cwd.mkdir()
        self.profile = self.root / "profile"
        (self.profile / "agent-hooks").mkdir(parents=True, mode=0o700)
        self.sid = str(uuid.uuid4())
        self.ms = datetime.now(timezone.utc).timestamp() * 1000
        self.policy = dict(schema_version=1, scope="swarm_coordinator_only", provider="pi",
                           model={"provider": "anthropic", "id": "claude-sonnet"},
                           thinking_level="high")
        self.policy_path = self.root / "pi-policy.json"
        publish_new(self.policy_path, self.policy)
        self.policy_ref = file_ref(self.policy_path)
        self.log = self.root / "pi-session.jsonl"
        self.write_log()
        self.write_state()
        self.caller_ref = self.ref("caller.json", self.caller())
        self.calls = []

    def caller(self):
        authority = dict(terminalHandle=self.TERMINAL, paneKey="tab:leaf",
                         processIncarnation="pty:" + self.INCARNATION,
                         hostScope={"kind": "local", "hostId": "host"}, launchTokenHash=LAUNCH_HASH)
        return dict(coordinatorPolicy="strict-v1", effectsApplied=False, checkedAt=now(),
                    caller={**{k: v for k, v in authority.items() if k != "launchTokenHash"},
                            "authorityFingerprint": digest(canonical(authority))})

    def ref(self, name, value):
        target = self.root / name
        publish_new(target, value)
        return file_ref(target)

    def write_log(self, *, model="claude-sonnet", provider="anthropic", thinking="high",
                  extra=(), stale_seconds=0):
        stamp = ((datetime.now(timezone.utc) - timedelta(seconds=stale_seconds))
                 .isoformat()) if stale_seconds else now()
        records = [dict(type="session", id=self.sid, cwd=str(self.cwd), timestamp=stamp,
                        version=3, parentId=None),
                   dict(type="message", id="turn0001", parentId=None, timestamp=stamp,
                        message=dict(role="assistant", model=model, provider=provider,
                                     thinkingLevel=thinking, content=[]))]
        records.extend(extra)
        self.log.write_text("".join(json.dumps(record) + "\n" for record in records))

    def write_state(self, *, entry=True):
        discovery = dict(runtimeId=self.RUNTIME_ID, pid=42, startedAt=self.ms - 10000)
        (self.profile / "orca-runtime.json").write_text(json.dumps(discovery))
        (self.profile / "orca-runtime.json").chmod(0o600)
        entries = {}
        if entry:
            entries["tab:leaf"] = dict(
                worktreeId=self.WORKSPACE_ID, tabId="tab", source="pi",
                payload={"agentType": "pi"}, launchTokenHash=LAUNCH_HASH,
                receivedAt=self.ms, evidenceObservedAt=self.ms,
                providerSession={"key": "session_id", "id": self.sid,
                                 "transcriptPath": str(self.log)})
        hooks = self.profile / "agent-hooks" / "last-status.json"
        hooks.write_text(json.dumps({"version": 2, "entries": entries}))
        hooks.chmod(0o600)

    def write_hook_row(self, event, state):
        """Rewrite this pane's row with a hook event/state; the store stays valid."""
        hooks = self.profile / "agent-hooks" / "last-status.json"
        value = json.loads(hooks.read_text())
        row = dict(value["entries"]["tab:leaf"])
        row.update(hookEventName=event, payload={"agentType": "pi", "state": state},
                   turnStartedAt=self.ms - 5000, receivedAt=self.ms,
                   evidenceObservedAt=self.ms)
        value["entries"]["tab:leaf"] = row
        hooks.write_text(json.dumps(value))
        return row

    def query(self, cli, runtime, args):
        self.calls.append(args)
        if args == ["status"]:
            return dict(runtime={"appVersion": "1.4.219", "state": "ready"},
                        target={"kind": "local"}, app={"running": True, "pid": 42})
        if args[:2] == ["terminal", "show"]:
            return {"terminal": dict(handle=self.TERMINAL, worktreeId=self.WORKSPACE_ID,
                                     tabId="tab", leafId="leaf", ptyId="pty",
                                     incarnationId=self.INCARNATION, executionHostId="local",
                                     agentIdentity="pi", connected=True, orphaned=False)}
        if args[:2] == ["worktree", "show"]:
            return {"worktree": {"id": self.WORKSPACE_ID, "path": str(self.cwd)}}
        self.fail(args)

    def observe(self, **extra):
        args = dict(cli=sys.executable, runtime=self.RUNTIME_ID, terminal=self.TERMINAL,
                    incarnation=self.INCARNATION, workspace=self.WORKSPACE_ID,
                    cwd=str(self.cwd), profile=str(self.profile), log_root=str(self.root),
                    roots=[str(self.root / "work")], caller_receipt=self.caller_ref,
                    pi_policy=self.policy_ref, expected_thread=self.sid,
                    context_max_age_seconds=900, startup_anchor=None)
        args.update(extra)
        with patch("trae_tui.native", side_effect=self.query):
            return observe(**args)


class PiTuiTests(PiTuiFixture):
    def test_startup_anchor_binds_pane_session_cwd_and_reviewed_policy(self):
        result = self.observe()
        self.assertEqual(result["adapter"], "pi-tui-runtime-v1")
        self.assertEqual(result["kind"], "pi_tui_startup_anchor")
        self.assertEqual(result["thread_id"], self.sid)
        self.assertEqual(result["session_id"], self.sid)
        self.assertEqual(result["effective"], {"model_provider": "anthropic",
                                               "model": "claude-sonnet",
                                               "thinking_level": "high", "cwd": str(self.cwd)})
        self.assertEqual(result["policy"], {"model_provider": "anthropic",
                                            "model": "claude-sonnet", "thinking_level": "high"})
        self.assertFalse(result["execution_authorized"])
        self.assertTrue(result["requires_live_caller_check"])
        self.assertNotIn("pi-test-only-launch-token", json.dumps(result))
        self.assertEqual(result["binding"]["session_id"], self.sid)

    def test_reobservation_requires_the_same_anchor_prefix_and_hook(self):
        first = self.observe()
        anchor = self.ref("anchor.json", first)
        with self.log.open("a") as stream:
            stream.write(json.dumps(dict(type="message", id="turn0002", parentId="turn0001",
                                         timestamp=now(), message=dict(
                                             role="assistant", model="claude-sonnet",
                                             provider="anthropic", thinkingLevel="high",
                                             content=[]))) + "\n")
        self.write_state()
        second = self.observe(startup_anchor=anchor)
        self.assertEqual(second["kind"], "pi_tui_session_observation")
        self.assertGreater(second["prefix_bytes"], first["prefix_bytes"])
        # A truncated history or a replaced file is not the anchored session.
        self.write_log()
        with self.assertRaisesRegex(ValueError, "tui_log_replaced_or_truncated|tui_log_history_changed"):
            self.observe(startup_anchor=anchor)

    def test_policy_session_and_cwd_mismatches_are_refused(self):
        cases = [dict(model="other-model"), dict(thinking="low"), dict(provider="other")]
        for index, change in enumerate(cases):
            with self.subTest(case=index):
                self.write_log(**change)
                self.write_state()
                with self.assertRaisesRegex(ValueError, "actual session settings mismatch"):
                    self.observe()
        self.write_log()
        self.write_state()
        changed = dict(self.policy, model={"provider": "anthropic", "id": "other-model"})
        publish_new(self.root / "pi-policy-2.json", changed)
        with self.assertRaisesRegex(ValueError, "actual session settings mismatch"):
            self.observe(pi_policy=file_ref(self.root / "pi-policy-2.json"))
        with self.assertRaisesRegex(ValueError, "tui_session_changed"):
            self.observe(expected_thread=str(uuid.uuid4()))

    def test_freshness_is_anchored_to_the_accepted_settings_record(self):
        # Append a fresh non-assistant record: the accepted assistant settings are
        # old, so the gate must stay stale instead of following the newest line.
        self.write_log(stale_seconds=4000)
        with self.log.open("a") as stream:
            stream.write(json.dumps(dict(type="message", id="turn0002",
                                         parentId="turn0001", timestamp=now(),
                                         message=dict(role="user", content=[]))) + "\n")
        from trae_coordinator import ContextFreshnessError
        with self.assertRaises(ContextFreshnessError) as caught:
            self.observe(context_max_age_seconds=900)
        self.assertEqual(caught.exception.code, "session_context_stale")
        transcript = pi_transcript.read(self.log)
        self.assertEqual(transcript["settings_record_id"], "turn0001")
        self.assertGreater(timestamp(transcript["activity_at"]), timestamp(transcript["observed_at"]))
        # The appended user message starts the current turn, so the turn anchor
        # moves even though the accepted settings (and their freshness) do not.
        self.assertEqual(timestamp(transcript["turn_started_at"]),
                         timestamp(transcript["activity_at"]))

    def test_a_completed_turn_requires_the_harness_end_record(self):
        """`completed_turn` is a recorded agent_end/done, never an idle pane."""
        self.write_log()
        entry = self.write_hook_row("tool_execution_end", "working")
        # "Not completed yet" is a wait, exactly like the Trae reader (None), not a stop.
        self.assertIsNone(self.observe(completed_turn=True))
        entry = self.write_hook_row("agent_end", "done")
        observation = self.observe(completed_turn=True)
        self.assertEqual(observation["kind"], "pi_tui_completed_turn_observation")
        self.assertLessEqual(timestamp(observation["completed_turn"]["context_at"]),
                             timestamp(observation["completed_turn"]["completed_at"]))
        self.assertLessEqual(timestamp(observation["completed_turn"]["context_at"]),
                             timestamp(observation["observed_at"]))

    def test_a_second_chain_start_cannot_carry_the_accepted_settings(self):
        self.write_log()
        with self.log.open("a") as stream:
            stream.write(json.dumps(dict(type="message", id="turn0002", parentId=None,
                                         timestamp=now(), message=dict(
                                             role="assistant", model="claude-sonnet",
                                             provider="anthropic", thinkingLevel="high",
                                             content=[]))) + "\n")
        with self.assertRaisesRegex(ValueError, "pi_session_chain_broken"):
            self.observe()

    def test_policy_must_stay_the_pinned_reviewed_bytes(self):
        # A bare path is refused: the policy is the reviewed expectation, so it
        # must arrive as the pinned Ref, not as a file the caller re-reads.
        with self.assertRaisesRegex(ValueError, "pi_runtime_policy_pin_required"):
            self.observe(pi_policy=str(self.policy_path))
        # The reviewer's scenario: replace the pinned bytes during observation.
        original = pi_policy.read_ref
        def replaced(ref_value):
            Path(ref_value["path"]).write_text(json.dumps(self.policy, indent=1) + "\n")
            return original(ref_value)
        with patch("pi_policy.read_ref", side_effect=replaced):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                self.observe()
        # A different reviewed policy is a mismatch, not a silent acceptance.
        publish_new(self.root / "other-policy.json", dict(self.policy, thinking_level="low"))
        with self.assertRaisesRegex(ValueError, "actual session settings mismatch"):
            self.observe(pi_policy=file_ref(self.root / "other-policy.json"))

    def test_stale_and_missing_evidence_are_typed(self):
        self.write_log(stale_seconds=4000)
        from trae_coordinator import ContextFreshnessError
        with self.assertRaises(ContextFreshnessError) as caught:
            self.observe(context_max_age_seconds=900)
        self.assertEqual(caught.exception.code, "session_context_stale")
        self.write_log()
        self.write_state(entry=False)
        with self.assertRaisesRegex(ValueError, "tui_runtime_state_unverifiable"):
            self.observe()

    def test_anchor_cannot_carry_a_different_reviewed_policy(self):
        first = self.observe()
        anchor = self.ref("anchor.json", dict(first, policy={"model_provider": "anthropic",
                                                             "model": "claude-sonnet",
                                                             "thinking_level": "low"}))
        with self.assertRaisesRegex(ValueError, "pi_runtime_policy_changed"):
            self.observe(startup_anchor=anchor)


class PiStartupContractTests(operator_startup.OperatorStartupTests):
    """The strict session gate on a Pi Coordinator contract, operator evidence kept real."""

    def pi_contract(self):
        self.pi_policy_path = self.t.f.root / "pi-policy.json"
        publish_new(self.pi_policy_path, dict(
            schema_version=1, scope="swarm_coordinator_only", provider="pi",
            model={"provider": "anthropic", "id": "claude-sonnet"}, thinking_level="high"))
        self.pi_sid = str(uuid.uuid4())
        self.s.contract.update(adapter="pi-tui-runtime-v1",
                               runtime_config=file_ref(self.pi_policy_path))
        self.s.contract["coordinator"]["session"] = self.pi_sid
        self.pi_observation = None

        def observe_pi(**kwargs):
            self.assertNotIn("trae_runtime_config", kwargs)
            self.assertEqual(kwargs["pi_policy"], file_ref(self.pi_policy_path))
            self.assertEqual(kwargs["expected_thread"], self.pi_sid)
            return copy.deepcopy(self.pi_observation)

        self.pi_observation = dict(schema_version=1, adapter="pi-tui-runtime-v1",
                                   kind="pi_tui_startup_anchor", thread_id=self.pi_sid,
                                   session_id=self.pi_sid, observed_at=now(),
                                   effective={"model": "claude-sonnet", "cwd": "x"},
                                   trust="runtime-state-and-log-not-live-process-attested")
        for patcher in (patch("pi_tui.observe", side_effect=observe_pi),
                        patch("trae_tui.observe", side_effect=AssertionError("trae reader used"))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_pi_coordinator_session_gate_uses_the_pi_reader_and_policy(self):
        self.pi_contract()
        receipt = self.s.gate()
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["binding"]["adapter"], "pi-tui-runtime-v1")
        self.assertEqual(receipt["binding"]["tui_binding"]["caller_receipt"],
                         self.s.contract["observation"]["caller_receipt"])
        self.assertEqual(receipt["session_evidence_sha256"],
                         digest(canonical(self.pi_observation)))
        self.assertFalse(receipt["execution_authorized"])

    def test_pi_contract_refuses_a_trae_execution_config(self):
        self.pi_contract()
        self.s.contract["runtime_config"] = file_ref(self.t.f.runtime)
        with self.assertRaisesRegex(ValueError, "pi_runtime_policy_invalid"):
            self.s.gate()

    def test_pi_contract_refuses_a_stale_context_at_the_gate(self):
        self.pi_contract()
        self.pi_observation["observed_at"] = (
            timestamp(now()) - timedelta(seconds=4000)).isoformat()
        with self.assertRaisesRegex(ValueError, "session_context_expired_during_gate"):
            self.s.gate()


class PiObservationConsumerTests(PiTuiFixture):
    def test_observed_coordinator_accepts_pi_kinds_and_rejects_a_foreign_adapter(self):
        observation = self.observe()
        ref = self.ref("pi-observation.json", observation)
        initial = self.caller()
        value = dict(runtime=self.RUNTIME_ID, workspace={"id": self.WORKSPACE_ID, "path": str(self.cwd)},
                     caller_receipt=self.caller_ref)
        result = observed_coordinator(dict(value, session_observation=ref), initial)
        self.assertEqual(result["session"], self.sid)
        forged = self.ref("pi-observation-forged.json", dict(observation, adapter="trae-tui-runtime-v1"))
        with self.assertRaisesRegex(ValueError, "strict_config_observation_binding_mismatch"):
            observed_coordinator(dict(value, session_observation=forged), initial)

    def test_validate_exposes_the_pi_tui_binding(self):
        contract = {"adapter": "pi-tui-runtime-v1"}
        self.assertEqual(tui_adapter.policy_key(contract["adapter"]), "pi_policy")
        self.assertIsNone(tui_adapter.kind_adapter("trae_startup_anchor"))


if __name__ == "__main__":
    unittest.main()
