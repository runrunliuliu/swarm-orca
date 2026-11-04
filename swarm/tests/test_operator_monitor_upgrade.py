"""Offline source-only upgrade faults; fake runtime is not live acceptance."""

from contextlib import redirect_stdout
from pathlib import Path
import io
import unittest
from unittest.mock import patch

import copy
from datetime import timedelta

from coordinator_io import (bound_lock, canonical, digest, file_ref, now, parse, pinned, publish_new, read_json,
                            replace_json, timestamp)
from coordinator_tui_continue import apply_review_clear
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_continuity_route as route
from operator_continuity_deployment import runtime_chain
import operator_monitor_upgrade as upgrade
import test_operator_monitor_deploy as deployment


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.d = deployment.NativeDeploymentTests()
        self.d.setUp()
        self.addCleanup(self.d.doCleanups)
        self.m, self.f = self.d.m, self.d.f
        self.assertEqual(self.d.execute(), 0)
        self.d.s.execute()
        self.output = self.m.root / "upgrade"
        self.output.mkdir(mode=0o700)
        self.reviewer = dict(terminal="reviewer", incarnation="review-inc", workspace="review-ws")
        self.source_patch = patch.object(deploy, "sources", return_value=[*deploy.sources(),
            self.f.t.ref("source-revision.json", {"revision": "offline"})])
        self.source_patch.start()
        self.addCleanup(self.source_patch.stop)

    def call(self, args, runtime, timeout=20):
        if args[:2] == ["terminal", "show"] and args[-1] == "reviewer":
            return dict(terminal=dict(handle="reviewer", incarnationId="review-inc", worktreeId="review-ws",
                connected=True, orphaned=False, agentIdentity="trae"))
        return self.m.fake(args, runtime, timeout)

    def prepare(self, plan_ref=None):
        self.proposal = upgrade.prepare(plan_ref or self.d.ref, str(self.output), call=self.call)
        self.data = read_json(self.proposal["path"])
        publish_new(self.output / "review.json", dict(schema_version=1, proposal=self.proposal,
            approved=True, reviewer=self.reviewer, evidence=[self.proposal], reason="Offline independent review"))
        self.review = file_ref(self.output / "review.json")

    def apply(self):
        return upgrade.apply(self.proposal, self.review, call=self.call)

    def reviewed_scheduler_stop(self):
        journal = self.f.state / "scheduler.json"
        state = read_json(journal)
        stop = dict(state="review_required", reason="tui_scheduler_no_acceptance_progress",
                    checkpoint=self.f.record_ref,
                    progress=dict(consecutive_without_acceptance_advance=3, limit=3,
                                  scope="declared_acceptance_only_not_semantic_verification"),
                    business_acceptance="not_evaluated")
        state["stop"] = stop
        replace_json(journal, state)
        clear_ref, clear = self.f.scheduler_review_clear_ref(stop)
        applied = apply_review_clear(self.f.config_ref, clear_ref)
        self.assertEqual(applied["state"], "scheduler_review_clear_applied")
        return stop, clear_ref, clear, read_json(journal)

    def publish_old_source_stop(self, reason="tui_scheduler_journal_invalid"):
        stop = {"at": now(), "reason": reason}
        publish_new(self.m.state_root / "monitor-stop.json", stop)
        status_path = self.m.state_root / "status.json"
        replace_json(status_path, {"observed_at": now(), "state": "stopped",
                                   "reason": "inspect_monitor_stop_and_outbox"})
        status = read_json(self.m.state_root / "deployment-status.json")
        replace_json(self.m.state_root / "deployment-status.json",
                     {**status, "status": file_ref(status_path), "observed_at": now()})
        return stop

    def publish_source_revision_stop(self, plan_ref, *, publish_latch=True,
                                     reason="file_pin_changed", first_tick_at="keep"):
        plan = read_json(plan_ref["path"])
        latch = self.m.state_root / ("recovery-stop-" + plan["recovery"]["permit"]["sha256"] + ".json")
        if publish_latch:
            publish_new(latch, {"at": now(), "reason": reason})
        status_path = self.m.state_root / "status.json"
        replace_json(status_path, {"observed_at": now(), "state": "stopped",
                                   "reason": "inspect_monitor_stop_and_outbox"})
        status = read_json(self.m.state_root / "deployment-status.json")
        if first_tick_at != "keep":
            status["first_tick_at"] = first_tick_at
        replace_json(self.m.state_root / "deployment-status.json",
                     {**status, "schema_version": 3, "plan": plan_ref,
                      "status": file_ref(status_path), "observed_at": now()})
        return file_ref(latch) if publish_latch else None

    def reviewed_historical_unsent_head(self):
        for index in range(2):
            self.d.s.new_turn(action_id="upgrade-history-prep-" + str(index))
            self.assertEqual(self.d.s.tick()["state"], "continuation_enqueued")
            self.d.s.execute()
        self.d.s.new_turn(action_id="upgrade-history-unsent")
        stop = self.d.s.tick()
        self.assertEqual(stop["reason"], "tui_scheduler_no_acceptance_progress")
        clear_ref, clear = self.f.scheduler_review_clear_ref(stop)
        applied = apply_review_clear(self.f.config_ref, clear_ref)
        self.assertEqual(applied["state"], "scheduler_review_clear_applied")
        after_clear = read_json(self.f.state / "scheduler.json")
        later = copy.deepcopy(self.d.s.ended)
        later["completed_turn"] = dict(turn_id="upgrade-later-turn",
            context_at=(timestamp(now()) + timedelta(seconds=1)).isoformat(),
            completed_at=(timestamp(now()) + timedelta(seconds=2)).isoformat(),
            prefix_bytes=444, prefix_sha256="c" * 64)
        self.d.s.ended = later
        return stop, clear_ref, clear, after_clear

    def change_sources(self, revision):
        deploy.sources.return_value = [*deploy.sources(),
            self.f.t.ref("source-revision-" + revision + ".json", {"revision": revision})]

    def next_output(self, name):
        self.output = self.m.root / name
        self.output.mkdir(mode=0o700)

    def source_upgrade_transition(self, plan_ref):
        plan, config, cref, continuation, contract, roots = upgrade.current(plan_ref)
        snapshot = upgrade.checkpoint(plan_ref, plan, config, cref, continuation, contract, roots)
        source = self.f.c["runtime"]
        target = source + "-successor"
        return target, self.f.t.ref("transition-source-upgrade.json", dict(schema_version=1,
            kind="planned-restart-monitor-transition", old_plan=plan_ref,
            source_runtime=runtime_chain(plan_ref)[-1], target_runtime=target,
            server_id="fixture-server", seal=self.f.t.ref("seal-source-upgrade.json", {"fixture_only": True}),
            binding=self.m.binding, snapshot=snapshot))

    def reviewed_schema3_source_upgrade_plan(self):
        self.reviewed_scheduler_stop()
        self.publish_old_source_stop()
        self.prepare()
        first_ref = self.apply()
        self.publish_source_revision_stop(first_ref)
        self.change_sources("cross-runtime-source")
        self.next_output("upgrade-cross-runtime-source")
        return first_ref

    def test_source_only_no_state_writes_and_publish_last(self):
        before = upgrade.inventory([self.m.state_root, self.f.state, self.d.output])
        self.prepare()
        self.assertFalse((self.output / "deployment.json").exists())
        ref = self.apply()
        self.assertEqual(self.apply(), ref)
        plan, config = deploy.validate(ref)
        self.assertEqual(plan, {**self.d.plan, "sources": deploy.sources()})
        self.assertEqual(config.ref, self.d.config.ref)
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state, self.d.output]))
        self.assertEqual(len(self.m.messages), 1)  # Fixture's original tick only.
        with self.assertRaisesRegex(ValueError, "source_changed"):
            deploy.validate(self.d.ref)

    def test_review_evidence_allows_metadata_but_still_requires_pin(self):
        self.prepare()
        review = read_json(self.review["path"])
        review["evidence"] = [{"kind": "proposal", **self.proposal, "checked": "hash matched"}]
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        deploy.validate(self.apply())

    def test_review_evidence_metadata_without_pin_refuses(self):
        self.prepare()
        review = read_json(self.review["path"])
        review["evidence"] = [{"kind": "proposal", "path": self.proposal["path"],
                               "checked": "sha omitted"}]
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        with self.assertRaisesRegex(ValueError, "invalid_file_pin"):
            self.apply()
        self.assertFalse((self.output / "deployment.json").exists())

    def test_stop_and_unsettled_refuse_before_publication(self):
        for root in (self.m.state_root, self.f.state):
            for name in ("STOP", "monitor-stop.json"):
                with self.subTest(root=root, name=name):
                    publish_new(root / name, {})
                    with self.assertRaisesRegex(ValueError, "persistent_stop"):
                        upgrade.prepare(self.d.ref, str(self.output), call=self.call)
                    (root / name).unlink()
        journal = self.f.state / "outbox.json"
        state = read_json(journal)
        next(iter(state["actions"].values()))["result"] = None
        replace_json(journal, state)
        with self.assertRaisesRegex(ValueError, "unsettled_action"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.assertFalse((self.output / "proposal.json").exists())

    def test_scheduler_review_stop_never_reset(self):
        journal = self.f.state / "scheduler.json"
        state = read_json(journal)
        state["stop"] = {"reason": "review_required"}
        replace_json(journal, state)
        with self.assertRaisesRegex(ValueError, "scheduler_review_required"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.assertEqual(read_json(journal), state)

    def test_cleared_scheduler_review_stop_allows_source_only_upgrade_without_reset(self):
        journal = self.f.state / "scheduler.json"
        state = read_json(journal)
        stop = dict(state="review_required", reason="tui_scheduler_no_acceptance_progress",
                    checkpoint=self.f.record_ref,
                    progress=dict(consecutive_without_acceptance_advance=3, limit=3,
                                  scope="declared_acceptance_only_not_semantic_verification"),
                    business_acceptance="not_evaluated")
        state["stop"] = stop
        replace_json(journal, state)
        with self.assertRaisesRegex(ValueError, "scheduler_review_required"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.assertEqual(read_json(journal), state)

        clear_ref, clear = self.f.scheduler_review_clear_ref(stop)
        applied = apply_review_clear(self.f.config_ref, clear_ref)
        self.assertEqual(applied["state"], "scheduler_review_clear_applied")
        after_clear = read_json(journal)
        self.assertEqual(after_clear["stop"], stop)
        self.assertEqual(after_clear["review_clear"], clear_ref)

        self.prepare()
        self.assertEqual(read_json(self.proposal["path"])["snapshot"]["head"],
                         file_ref(Path(self.f.config["checkpoint_head"])))
        ref = self.apply()
        deploy.validate(ref)
        self.assertEqual(read_json(journal), after_clear)
        self.assertEqual(clear["stop"], stop)

    def test_live_old_source_monitor_stop_gets_schema3_upgrade_without_reset(self):
        stop, clear_ref, clear, after_clear = self.reviewed_scheduler_stop()
        monitor_stop = self.publish_old_source_stop()
        old_stop_ref = file_ref(self.m.state_root / "monitor-stop.json")

        self.prepare()
        proposal = read_json(self.proposal["path"])
        self.assertEqual(proposal["snapshot"]["monitor_stop"], old_stop_ref)
        self.assertEqual(proposal["snapshot"]["scheduler_review_clear"],
                         {"receipt": clear_ref, "review": clear})
        ref = self.apply()
        plan, config = deploy.validate(ref)
        self.assertEqual(plan["schema_version"], 3)
        self.assertEqual(plan["recovery"]["kind"], "monitor-source-only-upgrade")
        self.assertEqual(plan["recovery"]["stop"], old_stop_ref)
        self.assertFalse(monitor.persistently_stopped(config))
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json"), monitor_stop)
        self.assertEqual(file_ref(self.m.state_root / "monitor-stop.json"), old_stop_ref)
        self.assertEqual(read_json(self.f.state / "scheduler.json"), after_clear)
        self.assertEqual(clear["stop"], stop)

    def test_chain_source_upgrade_from_schema3_latch_without_state_reset(self):
        stop, clear_ref, clear, after_clear = self.reviewed_scheduler_stop()
        monitor_stop = self.publish_old_source_stop()
        old_stop_ref = file_ref(self.m.state_root / "monitor-stop.json")
        self.prepare()
        old_review_source_path = self.output / "reviewed-source-pin.json"
        publish_new(old_review_source_path, {"revision": "reviewed-before-chain"})
        old_review_source_ref = file_ref(old_review_source_path)
        old_review = read_json(self.review["path"])
        old_review["evidence"] = [self.proposal, old_review_source_ref]
        replace_json(Path(self.review["path"]), old_review)
        self.review = file_ref(self.review["path"])
        first_ref = self.apply()
        prior_latch = self.publish_source_revision_stop(first_ref)
        before = upgrade.inventory([self.m.state_root, self.f.state, self.d.output])

        replace_json(old_review_source_path, {"revision": "changed-after-review"})
        self.change_sources("offline-2")
        self.next_output("upgrade2")
        self.prepare(first_ref)
        proposal = read_json(self.proposal["path"])
        self.assertEqual(proposal["old_plan"], first_ref)
        self.assertEqual(proposal["snapshot"]["monitor_stop"], old_stop_ref)
        self.assertEqual(proposal["snapshot"]["source_revision_stop"], prior_latch)
        self.assertEqual(proposal["snapshot"]["scheduler_review_clear"],
                         {"receipt": clear_ref, "review": clear})
        second_ref = self.apply()
        plan, config = deploy.validate(second_ref)
        self.assertEqual(plan["schema_version"], 3)
        self.assertEqual(plan["recovery"]["kind"], "monitor-source-only-upgrade")
        self.assertEqual(plan["recovery"]["stop"], old_stop_ref)
        self.assertNotEqual(plan["recovery"]["permit"], read_json(first_ref["path"])["recovery"]["permit"])
        self.assertFalse(monitor.persistently_stopped(config))
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json"), monitor_stop)
        self.assertEqual(file_ref(self.m.state_root / "monitor-stop.json"), old_stop_ref)
        self.assertEqual(file_ref(prior_latch["path"]), prior_latch)
        self.assertEqual(read_json(self.f.state / "scheduler.json"), after_clear)
        self.assertEqual(clear["stop"], stop)
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state, self.d.output]))

    def test_source_upgrade_cli_uses_explicit_planned_transition(self):
        first_ref = self.reviewed_schema3_source_upgrade_plan()
        target, transition = self.source_upgrade_transition(first_ref)
        phases = []

        def server(value, phase, evidence):
            self.assertEqual(value, route.validate(transition))
            phases.append(phase)
            return dict(transition_canonical_sha256=digest(canonical(value)), phase=phase)

        def routed_call(args, runtime, timeout=20):
            self.assertEqual(runtime, target)
            return self.call(args, self.f.c["runtime"], timeout)

        prepare_out = io.StringIO()
        with patch.object(route, "server_boundary", side_effect=server), \
                patch.object(upgrade.monitor, "native", side_effect=routed_call), \
                redirect_stdout(prepare_out):
            upgrade.main(["prepare", "--plan", first_ref["path"], "--plan-sha256", first_ref["sha256"],
                          "--output-dir", str(self.output),
                          "--transition", transition["path"], "--transition-sha256", transition["sha256"]])
        prepared = parse(prepare_out.getvalue())
        proposal = prepared["proposal"]
        self.assertEqual(read_json(proposal["path"])["transition"], transition)
        publish_new(self.output / "review.json", dict(schema_version=1, proposal=proposal,
            approved=True, reviewer=self.reviewer, evidence=[proposal], reason="Offline transition review"))
        review = file_ref(self.output / "review.json")

        apply_out = io.StringIO()
        with patch.object(route, "server_boundary", side_effect=server), \
                patch.object(upgrade.monitor, "native", side_effect=routed_call), \
                redirect_stdout(apply_out):
            upgrade.main(["apply", "--proposal", proposal["path"], "--proposal-sha256", proposal["sha256"],
                          "--review", review["path"], "--review-sha256", review["sha256"], "--execute"])
        applied = parse(apply_out.getvalue())
        plan_ref = applied["plan"]
        plan, config = deploy.validate(plan_ref)
        self.assertEqual(plan["recovery"]["transition"], transition)
        self.assertEqual(runtime_chain(plan_ref), [self.f.c["runtime"], target])
        self.assertFalse(monitor.persistently_stopped(config))
        self.assertEqual(phases, ["prepare", "apply"])

    def test_source_upgrade_transition_without_active_scope_refuses_before_publication(self):
        first_ref = self.reviewed_schema3_source_upgrade_plan()
        target, transition = self.source_upgrade_transition(first_ref)

        def routed_call(args, runtime, timeout=20):
            self.assertEqual(runtime, target)
            return self.call(args, self.f.c["runtime"], timeout)

        with self.assertRaisesRegex(ValueError, "explicit_entry_required"):
            upgrade.prepare(first_ref, str(self.output), call=routed_call, transition_ref=transition)
        self.assertFalse((self.output / "proposal.json").exists())

    def test_first_tick_before_historical_observation_latch_allows_source_upgrade(self):
        stop, clear_ref, clear, after_clear = self.reviewed_historical_unsent_head()
        monitor_stop = self.publish_old_source_stop()
        old_stop_ref = file_ref(self.m.state_root / "monitor-stop.json")
        self.prepare()
        first_ref = self.apply()
        prior_latch = self.publish_source_revision_stop(first_ref,
            reason="tui_checkpoint_not_from_completed_turn", first_tick_at=None)
        before_outbox = (self.f.state / "outbox.json").read_bytes()

        self.change_sources("historical-recovery")
        self.next_output("upgrade-historical-recovery")
        self.prepare(first_ref)
        proposal = read_json(self.proposal["path"])
        historical = proposal["snapshot"]["historical_observation"]
        self.assertEqual(proposal["snapshot"]["source_revision_stop"], prior_latch)
        self.assertEqual(historical["state"], "awaiting_fresh_checkpoint")
        self.assertEqual(historical["scheduler_review_clear"], {"receipt": clear_ref, "review": clear})
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before_outbox)
        second_ref = self.apply()
        plan, config = deploy.validate(second_ref)
        self.assertEqual(plan["schema_version"], 3)
        self.assertFalse(monitor.persistently_stopped(config))
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json"), monitor_stop)
        self.assertEqual(file_ref(self.m.state_root / "monitor-stop.json"), old_stop_ref)
        self.assertEqual(file_ref(prior_latch["path"]), prior_latch)
        self.assertEqual(read_json(self.f.state / "scheduler.json"), after_clear)
        self.assertEqual(clear["stop"], stop)

    def test_historical_first_tick_recovery_refuses_missing_binding_or_wrong_latch(self):
        self.reviewed_historical_unsent_head()
        self.publish_old_source_stop()
        self.prepare()
        first_ref = self.apply()
        self.publish_source_revision_stop(first_ref,
            reason="tui_checkpoint_not_from_completed_turn", first_tick_at=None)

        journal = read_json(self.f.state / "scheduler.json")
        saved_turns = journal["turns"]
        journal["turns"] = {}
        replace_json(self.f.state / "scheduler.json", journal)
        self.change_sources("missing-history")
        self.next_output("upgrade-missing-history")
        with self.assertRaisesRegex(ValueError, "historical_turn_binding_missing"):
            self.prepare(first_ref)
        journal["turns"] = saved_turns
        replace_json(self.f.state / "scheduler.json", journal)

        self.change_sources("wrong-latch-first-tick")
        self.next_output("upgrade-wrong-latch-first-tick")
        latch = self.m.state_root / ("recovery-stop-" + read_json(first_ref["path"])["recovery"]["permit"]["sha256"] + ".json")
        replace_json(latch, {"at": now(), "reason": "file_pin_changed"})
        with self.assertRaisesRegex(ValueError, "requires_exited_monitor"):
            self.prepare(first_ref)

    def test_schema3_stopped_without_source_revision_latch_refuses(self):
        self.reviewed_scheduler_stop()
        self.publish_old_source_stop()
        self.prepare()
        first_ref = self.apply()
        self.publish_source_revision_stop(first_ref, publish_latch=False)

        self.change_sources("offline-2")
        self.next_output("upgrade2")
        with self.assertRaisesRegex(ValueError, "clean_exit"):
            self.prepare(first_ref)
        self.assertFalse((self.output / "proposal.json").exists())

    def test_old_source_stop_requires_scheduler_review_clear(self):
        self.publish_old_source_stop()
        with self.assertRaisesRegex(ValueError, "scheduler_review_required"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.assertFalse((self.output / "proposal.json").exists())

    def test_wrong_old_source_stop_and_changed_stop_refuse(self):
        self.reviewed_scheduler_stop()
        self.publish_old_source_stop("other_failure")
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.assertFalse((self.output / "proposal.json").exists())

        (self.m.state_root / "monitor-stop.json").unlink()
        self.publish_old_source_stop()
        self.prepare()
        ref = self.apply()
        replace_json(self.m.state_root / "monitor-stop.json",
                     {"at": now(), "reason": "tui_scheduler_journal_invalid"})
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            deploy.validate(ref)

    def test_running_or_pre_first_tick_or_dirty_exit_refuse(self):
        target = self.m.state_root / "deployment-status.json"
        saved = read_json(target)
        for k, v in (("phase", "monitoring"), ("first_tick_at", None),
                     ("verification_mode", "host-process"), ("status", {})):
            replace_json(target, {**saved, k: v})
            with self.assertRaises(ValueError):
                upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        replace_json(target, saved)
        replace_json(self.m.state_root / "status.json", {"state": "stopped"})
        saved["status"] = file_ref(self.m.state_root / "status.json")
        replace_json(target, saved)
        with self.assertRaisesRegex(ValueError, "clean_exit"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)

    def test_original_locks_block_prepare_and_apply(self):
        with bound_lock(self.m.state_root, self.d.config.ref, "monitor"):
            with self.assertRaises(BlockingIOError):
                upgrade.prepare(self.d.ref, str(self.output), call=self.call)
        self.prepare()
        with bound_lock(self.f.state, self.f.config_ref, "tui-continuation"):
            with self.assertRaises(BlockingIOError):
                self.apply()

    def test_drift_after_review_and_during_native_check_refuse(self):
        self.prepare()
        def race(args, runtime, timeout):
            result = self.call(args, runtime, timeout)
            if args[-1] == "reviewer":
                publish_new(self.f.state / "new-state.json", {})
            return result
        with self.assertRaisesRegex(ValueError, "state_changed"):
            upgrade.apply(self.proposal, self.review, call=race)
        self.assertFalse((self.output / "deployment.json").exists())
        with self.assertRaisesRegex(ValueError, "state_changed"):
            self.apply()

    def test_missing_review_and_nonindependent_reviewer_refuse(self):
        self.prepare()
        saved = read_json(self.review["path"])
        for delta, error in (({"approved": False}, "external_review_required"),
                             ({"reviewer": self.d.plan["sender"]}, "independent_reviewer_required")):
            replace_json(Path(self.review["path"]), {**saved, **delta})
            self.review = file_ref(self.review["path"])
            with self.assertRaisesRegex(ValueError, error):
                self.apply()
        self.assertFalse((self.output / "deployment.json").exists())

    def test_reviewer_native_identity_and_run_generation_refuse(self):
        self.prepare()
        def bad(args, runtime, timeout):
            value = self.call(args, runtime, timeout)
            if args[-1] == "reviewer":
                value["terminal"]["incarnationId"] = "replacement"
            return value
        with self.assertRaisesRegex(ValueError, "reviewer_unverifiable"):
            upgrade.apply(self.proposal, self.review, call=bad)
        self.m.run["consumer_generation"] += 1
        with self.assertRaisesRegex(ValueError, "run_changed"):
            self.apply()

    def test_crash_before_plan_resumes_without_state_migration(self):
        self.prepare()
        publish = upgrade.publish_new
        def crash(target, value):
            publish(target, value)
            if target.name == "reviewed.json":
                raise RuntimeError("crash")
        with patch.object(upgrade, "publish_new", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                self.apply()
        self.assertFalse((self.output / "deployment.json").exists())
        deploy.validate(self.apply())

    def test_source_drift_and_changed_scope_refuse(self):
        self.prepare()
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "revision_changed_scope"):
                self.apply()
        self.data["new_plan"]["sender"]["terminal"] = "changed"
        replace_json(Path(self.proposal["path"]), self.data)
        self.proposal = file_ref(self.proposal["path"])
        review = read_json(self.review["path"])
        review.update(proposal=self.proposal, evidence=[self.proposal])
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        with self.assertRaisesRegex(ValueError, "revision_changed_scope"):
            self.apply()

    def test_symlink_state_refused(self):
        (self.f.state / "state-link").symlink_to(self.m.state_root / "status.json")
        with self.assertRaisesRegex(ValueError, "state_symlink"):
            upgrade.prepare(self.d.ref, str(self.output), call=self.call)

    def test_idempotent_after_progress_but_not_after_publication_corruption(self):
        self.prepare()
        ref = self.apply()
        publish_new(self.f.state / "later-observation.json", {})
        self.assertEqual(self.apply(), ref)
        replace_json(self.output / "reviewed.json", {})
        with self.assertRaisesRegex(ValueError, "publication_changed"):
            self.apply()


if __name__ == "__main__":
    unittest.main()
