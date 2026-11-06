"""Deterministic file/native-export fixtures; no real execution or identity proof."""

import copy
import io
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_domain import SOFTWARE
from coordinator_io import canonical, digest, file_ref, now, read_json
from coordinator_startup import identity
import software_development as software
import test_coordinator_tui_continue as continuation


class SoftwareFixture:
    """Add a real scoped file tree and archived evidence to a shared TUI fixture."""

    def __init__(self, f):
        self.f, self.counter = f, 0
        self.workspace = Path(f.c["workspace"]["path"])
        self.archive = f.t.f.bootstrap / "software"
        self.archive.mkdir()
        source = Path(software.__file__).parent / "skills/software-development"
        target = self.workspace / "swarm/skills/software-development"
        (target / "references").mkdir(parents=True)
        for name in ("SKILL.md", "references/coordinator.md", "references/implementation.md", "references/review.md"):
            (target / name).write_bytes((source / name).read_bytes())
        (self.workspace / "src").mkdir()
        self.code = self.workspace / "src/main.py"
        self.code.write_text("value = 1\n")
        acceptance = copy.deepcopy({"requirements": f.record["requirements"]})
        for row in acceptance["requirements"]:
            row["verification"] = "test"
        self.acceptance = self.put(acceptance)
        self.raw = self.put({"tool_record": "offline fixture, not a real tool run"})
        repository = dict(root=str(self.workspace), worktree=str(self.workspace), branch="fixture", base_commit="a" * 40)
        scope = dict(read_roots=[str(self.workspace), str(f.t.f.bootstrap)], write_roots=[str(self.workspace / "src")],
                     exclude_paths=[str(self.workspace / ".git")], operations=["modify", "create", "delete", "test", "review"])
        self.task = dict(schema_version=1, task_id="software-fixture", objective="fixture software task",
                         acceptance=self.acceptance, repository=repository, scope=scope,
                         policy=dict(max_workers=1, token_budget=None, cost_budget=None, deadline=f.config["deadline"],
                                     retry_limit=0, stop_conditions=["unresolved native outcome"]))
        files = [dict(path=r["path"], content=self.archive_bytes(Path(r["path"]).read_bytes()),
                      tracked=True, dirty=False, owner="external", diff=None) for r in software.snapshot(self.task)]
        inventory = dict(repository=repository, files=[dict(path=r["path"], sha256=r["content"]["sha256"],
                    tracked=r["tracked"], dirty=r["dirty"]) for r in files])
        self.baseline = dict(repository=repository, files=files, inventory_records=[self.put(inventory)])
        self.task["baseline"] = self.put(self.baseline)
        self.binding = dict(schema_version=1, adapter=SOFTWARE, checker=file_ref(Path(software.__file__).resolve()),
                            materials={key: file_ref(target / ("SKILL.md" if key == "skill" else f"references/{key}.md"))
                                       for key in software.MATERIALS})
        self.binding["reads"] = {role: self.put(dict(actor=f.c[role], materials=[self.binding["materials"]["skill"],
                    self.binding["materials"]["coordinator"]], source_records=[self.raw])) for role in ("operator", "coordinator")}
        self.bind_task()
        self.source = dict(schema_version=1, adapter=SOFTWARE, task_id=self.task["task_id"], runtime=f.c["runtime"],
                           run_id=f.c["run"]["id"], generation=f.c["run"]["generation"],
                           contract_sha256=self.binding["contract"]["sha256"], observed_at=now(),
                           **copy.deepcopy(f.record["checkpoint"]), snapshot=self.freeze(), changes=[],
                           actions=[], validations=[], reviews=[], audit=None, pending_operations=[])
        self.source["requirements"] = [dict(row, **{k: f.record["checkpoint"]["requirements"][i][k]
                    for k in ("status", "evidence", "path_review_ref")}) for i, row in enumerate(acceptance["requirements"])]

    def archive_bytes(self, data):
        self.counter += 1
        target = self.archive / f"evidence-{self.counter}"
        target.write_bytes(data)
        return file_ref(target)

    def put(self, value):
        return self.archive_bytes(canonical(value))

    def bind_task(self):
        review = dict(actor=self.f.c["operator"], approved=True,
                      inputs={k: v for k, v in self.task.items() if k not in ("schema_version", "authority_review")},
                      source_records=[self.raw])
        self.task["authority_review"] = self.put(review)
        self.binding["contract"] = self.put(self.task)
        self.f.c["domain_binding"] = copy.deepcopy(self.binding)
        self.f.c["handoff"] = self.put(dict(domain_binding=self.binding, objective=self.task["objective"]))
        self.f.config.update(schema_version=2, domain_binding=copy.deepcopy(self.binding), acceptance=self.acceptance,
                             scheduler=dict(terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"))
        self.f.config["contract"] = self.f.t.ref("software-contract.json", self.f.c)
        gate = read_json(self.f.config["dispatch_gate"]["path"])
        gate.update(contract_sha256=self.f.config["contract"]["sha256"], identity_sha256=digest(canonical(identity(self.f.c))))
        self.f.config["dispatch_gate"] = self.put(gate)
        self.f.config_ref = self.f.t.ref("software-config.json", self.f.config)

    def freeze(self):
        return [dict(row, content=self.archive_bytes(Path(row["path"]).read_bytes())) for row in software.snapshot(self.task)]

    def check(self, *, current=True):
        return software.check(self.binding, self.f.c, self.put(self.source), current=current)

    def publish(self):
        self.source["observed_at"] = now()
        ref = self.put(self.source)
        receipt = self.put(software.check(self.binding, self.f.c, ref, current=True))
        self.f.record.update(requirements=read_json(self.acceptance["path"])["requirements"],
                             checkpoint={k: self.source[k] for k in software.FIELDS},
                             domain_check=dict(adapter=SOFTWARE, source=ref, receipt=receipt))
        self.f.record_path = self.archive / f"checkpoint-{self.counter}.json"
        self.f.rewrite_record(rebind=False)
        return self.f.record_ref

    def complete(self, *, only_first=False):
        sh = digest(canonical([{k: r[k] for k in ("path", "sha256")} for r in self.source["snapshot"]]))
        ids = [r["id"] for r in self.source["requirements"]]
        common = dict(task_id=self.task["task_id"], run=self.f.c["run"], runtime=self.f.c["runtime"],
                      requirements=ids, snapshot_sha256=sh, source_records=[self.raw])
        actions = []
        for role, actor in (("implementation", "worker-fixture"), ("review", "reviewer-fixture")):
            native = dict(runtime=self.f.c["runtime"], run=self.f.c["run"], action_id="action-" + role,
                          task=dict(id="task-" + role, run_id=self.f.c["run"]["id"]),
                          dispatch=dict(id="dispatch-" + role, task_id="task-" + role, worker_handle=actor))
            materials = [self.binding["materials"]["skill"], self.binding["materials"][role]]
            actions.append(self.put(dict(common, id=role, actor=actor, action_id=native["action_id"],
                native_task=native["task"]["id"], dispatch=native["dispatch"]["id"], source_records=[self.put(native)],
                inputs=[self.raw], outputs=[self.raw], materials=materials,
                read_evidence=self.put(dict(actor=actor, materials=materials, source_records=[self.raw])))))
        self.source["actions"] = actions
        self.source["validations"] = [self.put(dict(common, id="test", actor="worker-fixture", action="implementation",
            method="test", command="python -m unittest", cwd=str(self.workspace), started_at=now(), ended_at=now(),
            exit_code=0, passed=True, reports=[self.raw], tool="fixture-runner"))]
        self.source["reviews"] = [self.put(dict(common, id="approved-review", actor="reviewer-fixture", action="review",
            decision="approved", findings=[], resolves=[], reviewed_at=now()))]
        for kind in ("validations", "reviews"):
            row = read_json(self.source[kind][0]["path"])
            row["source_records"] = [self.put(dict(kind=kind, record={k: v for k, v in row.items() if k != "source_records"}))]
            self.source[kind] = [self.put(row)]
        for row in self.source["requirements"][:1 if only_first else None]:
            row.update(status="met", evidence=[dict(kind=SOFTWARE, ref=k) for k in ("test", "approved-review")])
        self.source["paths"] = [r for r in self.source["paths"] if only_first and r["requirement_id"] == ids[1]]
        if only_first:
            self.source["next_action"].update(id="second-action", path_ids=[self.source["paths"][0]["id"]])
        else:
            self.source.update(decision="complete", next_action=None, barriers=[])
        self.source["audit"] = self.put(dict(actor=self.f.c["operator"], snapshot_sha256=sh,
            evidence=actions + self.source["validations"] + self.source["reviews"], verified=True, source_records=[self.raw]))
        self.source["observed_at"] = now()


class SoftwareTests(unittest.TestCase):
    def setUp(self):
        self.f = continuation.ContinuationTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.s = SoftwareFixture(self.f)

    def mutate_evidence(self, kind, **updates):
        row = read_json(self.s.source[kind][0]["path"])
        row.update(updates)
        row["source_records"] = [self.s.put(dict(kind=kind, record={k: v for k, v in row.items() if k != "source_records"}))]
        self.s.source[kind][0] = self.s.put(row)

    def audit(self):
        row = read_json(self.s.source["audit"]["path"])
        row["evidence"] = sum((self.s.source[k] for k in ("actions", "validations", "reviews")), [])
        self.s.source["audit"] = self.s.put(row)

    def rebind_baseline(self):
        self.s.baseline["inventory_records"] = [self.s.put(dict(repository=self.s.task["repository"], files=[
            dict(path=r["path"], sha256=r["content"]["sha256"] if r["content"] else None,
                 tracked=r["tracked"], dirty=r["dirty"]) for r in self.s.baseline["files"]]))]
        self.s.task["baseline"] = self.s.put(self.s.baseline)
        self.s.bind_task()
        self.s.source["contract_sha256"] = self.s.binding["contract"]["sha256"]

    def test_scan_error_fails_closed(self):
        def walk(*args, **kwargs):
            kwargs["onerror"](PermissionError("unreadable directory"))
            return iter(())
        with patch("software_development.os.walk", side_effect=walk):
            with self.assertRaises(PermissionError):
                self.s.check()

    def test_snapshot_content_must_be_archived_and_pinned(self):
        row = next(r for r in self.s.source["snapshot"] if r["path"] == str(self.s.code))
        archive = row["content"]
        row["content"] = file_ref(self.s.code)
        with self.assertRaisesRegex(ValueError, "content_archive_required"):
            self.s.check()
        row["content"] = archive
        Path(archive["path"]).write_text("drift")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.s.check()

    def test_initial_deleted_and_owned_dirty_files(self):
        row = next(r for r in self.s.baseline["files"] if r["path"] == str(self.s.code))
        row.update(content=None, dirty=True, diff=self.s.raw)
        self.s.code.unlink()
        self.rebind_baseline()
        self.s.source["snapshot"] = self.s.freeze()
        self.assertTrue(self.s.check()["consistent"])
        self.s.code.write_text("restored = True\n")
        self.s.source["snapshot"] = self.s.freeze()
        self.s.source["changes"] = [dict(path=str(self.s.code), operation="create", before=None,
                                          after=digest(self.s.code.read_bytes()))]
        with self.assertRaisesRegex(ValueError, "dirty_protected"):
            self.s.check()
        row["owner"] = self.s.task["task_id"]
        self.rebind_baseline()
        self.assertTrue(self.s.check()["consistent"])

    def test_baseline_inventory_cannot_omit_untracked_row(self):
        row = next(r for r in self.s.baseline["files"] if r["path"] == str(self.s.code))
        row.update(tracked=False, dirty=True)
        self.rebind_baseline()
        inventory = read_json(self.s.baseline["inventory_records"][0]["path"])
        inventory["files"] = [r for r in inventory["files"] if r["path"] != str(self.s.code)]
        self.s.baseline["inventory_records"] = [self.s.put(inventory)]
        self.s.task["baseline"] = self.s.put(self.s.baseline)
        with self.assertRaisesRegex(ValueError, "inventory_mismatch"):
            software.validate_task(self.s.task, self.f.c)

    def test_change_outside_write_roots(self):
        (self.s.workspace / "outside.py").write_text("not authorized\n")
        self.s.source["snapshot"] = self.s.freeze()
        with self.assertRaisesRegex(ValueError, "change_outside_scope"):
            self.s.check()

    def test_manual_method_and_operation_policy(self):
        acceptance = read_json(self.s.acceptance["path"])
        for row in acceptance["requirements"]:
            row.update(verification="manual", manual_method="inspect output against original checklist")
        self.s.acceptance = self.s.put(acceptance)
        self.s.task["acceptance"] = self.s.acceptance
        self.s.bind_task()
        self.s.source["contract_sha256"] = self.s.binding["contract"]["sha256"]
        for row in self.s.source["requirements"]:
            row.update(verification="manual", manual_method=acceptance["requirements"][0]["manual_method"])
        self.s.complete()
        self.mutate_evidence("validations", method="manual", command="different checklist")
        with self.assertRaisesRegex(ValueError, "validation_required"):
            self.s.check()
        self.mutate_evidence("validations", command=acceptance["requirements"][0]["manual_method"])
        self.audit()
        self.assertTrue(self.s.check()["consistent"])
        self.s.task["scope"]["operations"].remove("test")
        self.s.bind_task()
        self.s.source["contract_sha256"] = self.s.binding["contract"]["sha256"]
        with self.assertRaisesRegex(ValueError, "operation_not_allowed"):
            self.s.check()

    def test_independent_reviewer_cannot_share_implementer_identity(self):
        self.s.complete()
        ref = self.s.source["actions"][1]
        action = read_json(ref["path"])
        action["actor"] = "worker-fixture"
        native = read_json(action["source_records"][0]["path"])
        native["dispatch"]["worker_handle"] = action["actor"]
        action["source_records"] = [self.s.put(native)]
        reads = read_json(action["read_evidence"]["path"])
        reads["actor"] = action["actor"]
        action["read_evidence"] = self.s.put(reads)
        self.s.source["actions"][1] = self.s.put(action)
        self.mutate_evidence("reviews", actor=action["actor"])
        with self.assertRaisesRegex(ValueError, "independent_review"):
            self.s.check()

    def test_rejection_requires_explicit_resolved_review(self):
        self.s.complete()
        approved = self.s.source["reviews"][0]
        self.mutate_evidence("reviews", id="rejected", decision="changes_requested", findings=["fix bug"])
        rejected = self.s.source["reviews"][0]
        self.s.source["reviews"] = [approved, rejected]
        with self.assertRaisesRegex(ValueError, "independent_review"):
            self.s.check()
        self.mutate_evidence("reviews", resolves=["rejected"])
        self.audit()
        self.assertTrue(self.s.check()["consistent"])

    def test_future_timestamp_and_native_link_refused(self):
        self.s.source["observed_at"] = "2999-01-01T00:00:00+00:00"
        with self.assertRaisesRegex(ValueError, "future_observation"):
            self.s.check()
        self.s.complete()
        row = read_json(self.s.source["actions"][0]["path"])
        row["source_records"] = [self.s.raw]
        self.s.source["actions"][0] = self.s.put(row)
        with self.assertRaisesRegex(ValueError, "native_link_mismatch"):
            self.s.check()

    def test_checker_does_not_execute_recorded_commands(self):
        self.s.complete()
        marker = self.s.archive / "must-not-exist"
        self.mutate_evidence("validations", command=f"touch {marker}")
        self.audit()
        self.assertTrue(self.s.check()["consistent"])
        self.assertFalse(marker.exists())

    def test_linked_wait_and_no_path_blocked_review(self):
        original = copy.deepcopy(self.s.source)
        self.s.complete()
        self.s.source.update({k: original[k] for k in software.FIELDS})
        self.s.source["audit"] = None
        for row in self.s.source["requirements"]:
            row["status"] = "waiting"
        for row in self.s.source["paths"]:
            row.update(status="waiting", barrier_id="dependency")
        self.s.source["barriers"] = [dict(id="dependency", path_ids=[r["id"] for r in self.s.source["paths"]],
                                          evidence_refs=["implementation"], condition="worker completes")]
        self.s.source["decision"] = "wait"
        self.s.source["next_action"].update(kind="wait", prerequisites=["orca-dispatch:dispatch-implementation"])
        self.assertEqual(self.s.check()["next_gate"], "dependency_wait")
        self.s.source["next_action"]["prerequisites"] = ["orca-dispatch:invented"]
        with self.assertRaisesRegex(ValueError, "wait_native_evidence"):
            self.s.check()
        self.s.source.update(decision="blocked", paths=[], barriers=[], next_action=None)
        for row in self.s.source["requirements"]:
            row.update(status="blocked", path_review_ref="approved-review")
        self.assertEqual(self.s.check()["next_gate"], "alternatives_review")
        self.s.source["requirements"][0]["path_review_ref"] = "test"
        with self.assertRaisesRegex(ValueError, "path_review_required"):
            self.s.check()

    def test_initial_and_complete(self):
        self.assertEqual(self.s.check()["decision"], "continue")
        self.s.complete()
        result = self.s.check()
        self.assertEqual(result["next_gate"], "acceptance_review")
        self.assertFalse(result["grants_authority"])
        self.assertNotIn("authority_check", result)

    def test_generation_and_requirement_refusal(self):
        self.s.source["generation"] = True
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            self.s.check()
        self.s.source["generation"] = 1
        self.s.source["requirements"].pop()
        with self.assertRaisesRegex(ValueError, "requirements_changed"):
            self.s.check()

    def test_evidence_generation_and_export_types_are_strict(self):
        self.s.complete()
        self.mutate_evidence("validations", run=dict(self.f.c["run"], generation=True))
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            self.s.check()
        self.s.complete()
        row = read_json(self.s.source["validations"][0]["path"])
        exported = read_json(row["source_records"][0]["path"])
        exported["record"]["passed"] = 1
        row["source_records"] = [self.s.put(exported)]
        self.s.source["validations"][0] = self.s.put(row)
        with self.assertRaisesRegex(ValueError, "execution_record_mismatch"):
            self.s.check()

    def test_false_complete_and_wait_refusal(self):
        self.s.source["decision"] = "complete"
        with self.assertRaisesRegex(ValueError, "conflicts"):
            self.s.check()
        self.s.source["decision"] = "wait"
        with self.assertRaisesRegex(ValueError, "conflicts"):
            self.s.check()

    def test_snapshot_drift_and_immutable_history(self):
        self.s.code.write_text("value = 2\n")
        with self.assertRaisesRegex(ValueError, "snapshot_changed"):
            self.s.check()
        self.assertTrue(self.s.check(current=False)["consistent"])

    def test_untracked_missing_from_snapshot(self):
        (self.s.code.parent / "untracked.py").write_text("new = True\n")
        with self.assertRaisesRegex(ValueError, "snapshot_changed"):
            self.s.check()

    def test_symlink_refused(self):
        (self.s.code.parent / "escape").symlink_to(self.s.archive, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.s.check()

    def test_dirty_external_file_protected(self):
        row = next(r for r in self.s.baseline["files"] if r["path"] == str(self.s.code))
        row.update(dirty=True, diff=self.s.raw)
        inventory = read_json(self.s.baseline["inventory_records"][0]["path"])
        next(r for r in inventory["files"] if r["path"] == str(self.s.code))["dirty"] = True
        self.s.baseline["inventory_records"] = [self.s.put(inventory)]
        self.s.task["baseline"] = self.s.put(self.s.baseline)
        self.s.bind_task()
        self.s.source["contract_sha256"] = self.s.binding["contract"]["sha256"]
        self.s.code.write_text("value = 2\n")
        self.s.source["snapshot"] = self.s.freeze()
        with self.assertRaisesRegex(ValueError, "dirty_protected"):
            self.s.check()

    def test_out_of_scope_read_is_not_opened(self):
        outsider = self.f.t.ref("outside.json", {"private": "do not open"})
        self.s.complete()
        self.mutate_evidence("validations", reports=[outsider])
        with patch("coordinator_io.read_bytes", wraps=__import__("coordinator_io").read_bytes) as reader:
            with self.assertRaisesRegex(ValueError, "outside_scope"):
                self.s.check()
            self.assertNotIn(outsider["path"], [str(c.args[0]) for c in reader.call_args_list])

    def test_failed_test_missing_logs_stale_and_unrelated_evidence(self):
        for updates, error in ((dict(exit_code=1), "validation_required"),
                               (dict(reports=[]), "source_records_required"),
                               (dict(snapshot_sha256="f" * 64), "action_link_mismatch"),
                               (dict(task_id="other"), "binding_mismatch")):
            with self.subTest(updates=updates):
                self.s.complete()
                self.mutate_evidence("validations", **updates)
                with self.assertRaisesRegex(ValueError, error):
                    self.s.check()

    def test_rejection_requires_rereview(self):
        self.s.complete()
        self.mutate_evidence("reviews", decision="changes_requested", findings=["bug"])
        with self.assertRaisesRegex(ValueError, "validation_required"):
            self.s.check()

    def test_missing_audit_and_pending_operations(self):
        self.s.complete()
        saved = self.s.source["audit"]
        self.s.source["audit"] = self.s.raw
        with self.assertRaisesRegex(ValueError, "schema_invalid"):
            self.s.check()
        self.s.source["audit"] = saved
        self.s.source["pending_operations"] = ["unknown command outcome"]
        with self.assertRaisesRegex(ValueError, "unresolved_operations"):
            self.s.check()

    def test_pin_drift_and_material_mismatch(self):
        self.s.binding["checker"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "checker_changed"):
            self.s.check()
        self.s.binding["checker"] = file_ref(Path(software.__file__).resolve())
        self.s.binding["materials"]["review"] = self.s.raw
        with self.assertRaisesRegex(ValueError, "role_material_changed"):
            self.s.check()

    def test_cli_immutable_receipt(self):
        source = self.s.put(self.s.source)
        output = self.s.archive / "receipt.json"
        argv = ["--startup", self.f.config["contract"]["path"], "--startup-sha256", self.f.config["contract"]["sha256"],
                "--source", source["path"], "--source-sha256", source["sha256"], "--output", str(output)]
        with patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(software.main(argv), 0)
            before = output.read_bytes()
            self.assertEqual(software.main(argv), 2)
            self.assertEqual(before, output.read_bytes())


if __name__ == "__main__":
    unittest.main()
