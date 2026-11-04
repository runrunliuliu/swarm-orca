"""Always-running transport/failure tests; checker replies are explicit fixtures.

These do not prove RSI permission semantics. See test_operator_authority for the
separate integration layer with an explicitly selected real RSI checkout.
"""

import copy
import errno
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch

from coordinator_authority_bundle import ADAPTER, GENERATE, PROGRESS, PROTOCOL, verify_bundle
from coordinator_io import canonical, digest, file_ref, now, parse, pinned, publish_new, read_json, replace_json
from coordinator_tui_checkpoint import validate_record
from coordinator_tui_continue import load
from operator_authority import check, reconcile
import test_coordinator_tui_prepare as preparing


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.p = preparing.PrepareTests()
        self.p.setUp()
        self.addCleanup(self.p.doCleanups)
        self.root = self.p.f.t.f.bootstrap
        self.checker = self.root / "fixture-checker"
        (self.checker / "rsi").mkdir(parents=True)
        for name in ("__init__", "progress", "authority", "__main__"):
            (self.checker / "rsi" / (name + ".py")).write_text("# fixture, never a real authority checker\n")
        source = self.root / "original.txt"
        source.write_text("TEST FIXTURE ONLY")
        self.authority = dict(schema_version=1, run_id="run_test", scope_id="scope", events=[dict(
            id="e1", actor="user", source=dict(path=source.name, sha256=digest(source.read_bytes()),
            excerpt=source.read_text()), patch={"permissions.local_edit": "granted"})])
        self.authority_ref = self.write("authority.json", self.authority)
        self.spec = dict(schema_version=1, mode=GENERATE, directory=str(self.root / "generate"),
            read_roots=[str(self.root)], write_roots=[str(self.root)], source_root=str(self.root),
            run_id="run_test", scope_id="scope", inputs={"authority": self.authority_ref},
            checker={"root": str(self.checker), "files": {
                str(p.relative_to(self.checker)): digest(p.read_bytes()) for p in self.checker.rglob("*.py")}})
        Path(self.spec["directory"]).mkdir(mode=0o700)
        self.input = self.write("generate-input.json", self.spec)

    def write(self, name, value):
        target = self.root / name
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        return file_ref(target)

    def reply(self, *args, **kwargs):
        argv = parse(kwargs["input"])["argv"]
        def option(name):
            return argv[argv.index("--" + name) + 1]
        if argv[0] == "resolve-authority":
            result = dict(handoff=dict(schema_version=1, run_id=option("run-id"), scope_id=option("scope-id"),
                authority_sha256=option("authority-sha256"), fields={"x": "unknown"}, origins={"x": None}),
                grants_authority=False, validation_scope="pinned_authority_declarations_and_source_bytes")
            envelope = dict(ok=True, result=result)
        elif argv[0] == "check-authority-handoff":
            envelope = dict(ok=True, result=dict(consistent=True, grants_authority=False))
        else:
            source = read_json(argv[argv.index("--handoff") + 2])
            envelope = dict(ok=True, result=dict(consistent=True, decision=source["decision"],
                authority_sha256=option("authority-sha256"), context_sha256=option("context-sha256"),
                contract_sha256=option("contract-sha256")), authority_check=dict(schema_version=1,
                status="consistent", error_code=None, grants_authority=False, run_id=option("run-id"),
                scope_id=option("scope-id"), authority_sha256=option("authority-sha256"),
                context_sha256=option("context-sha256"), checkpoint_sha256=digest(canonical(source))))
        return subprocess.CompletedProcess(args[0], 0, canonical(envelope), b"")

    def generate(self):
        with patch("operator_authority.subprocess.run", side_effect=self.reply):
            result = check(self.input)
        self.assertTrue(result["ok"], result)
        return result

    def progress(self, generated, *, name="progress", context_ref=None):
        contract = dict(schema_version=1, run_id="run_test", objective_ref="fixture://objective",
            authorization_ref="fixture://authority", requirements=self.p.f.record["requirements"])
        contract_ref = self.write("business-contract.json", contract)
        context = dict(schema_version=1, run_id="run_test", scope_id="scope",
            authority_sha256=digest(canonical(self.authority)), contract_sha256=digest(canonical(contract)), paths=[])
        context_ref = context_ref or self.write("context.json", context)
        source = read_json(self.p.inputs["source"]["path"])
        source["contract_sha256"] = digest(canonical(contract))
        source_ref = self.write(name + "-checkpoint.json", source)
        inputs = dict(authority=self.authority_ref, handoff=generated["handoff"], contract=contract_ref,
            context=context_ref, checkpoint=source_ref, gates=self.write("gates.json", {}))
        spec = dict(self.spec, schema_version=2, mode=PROGRESS, inputs=inputs,
                    generation=generated["completion"], directory=str(self.root / name))
        Path(spec["directory"]).mkdir(mode=0o700)
        spec_ref = self.write(name + "-input.json", spec)
        with patch("operator_authority.subprocess.run", side_effect=self.reply):
            result = check(spec_ref)
        self.assertTrue(result["ok"], result)
        binding = dict(protocol=PROTOCOL, generation=generated["completion"], scope_id="scope",
                       context=context_ref, contract=contract_ref)
        self.p.inputs.update(authority_binding=binding, completion=result["completion"],
                             source=source_ref, receipt=result["receipt"])
        return result, spec

    def test_generation_progress_prepare_and_direct_load(self):
        generated = self.generate()
        self.assertIsNone(parse(pinned(generated["handoff"]))["origins"]["x"])
        result, spec = self.progress(generated)
        prepared = self.p.prepare()
        config, contract, _ = load(prepared["config"])
        self.assertNotIn("turn_protocol", config)
        record = parse(pinned(prepared["checkpoint"]))
        self.assertEqual(record["domain_check"]["adapter"], ADAPTER)
        validate_record(record, config, contract)
        # Archived evidence stays readable even if original checker files move.
        (self.checker / "rsi" / "authority.py").unlink()
        load(prepared["config"])
        validate_record(record, config, contract)

    def test_both_protocols_can_be_enabled_independently(self):
        self.progress(self.generate())
        self.p.inputs["turn_protocol"] = "workflow-v2"
        result = self.p.prepare()
        config, _, _ = load(result["config"])
        self.assertEqual(config["turn_protocol"], "workflow-v2")
        self.assertEqual(config["authority_binding"]["protocol"], PROTOCOL)

    def test_strict_resolver_rejections(self):
        base = parse(self.reply([], input=canonical({"argv": ["resolve-authority", "--run-id", "run_test",
            "--scope-id", "scope", "--authority-sha256", digest(canonical(self.authority))]})).stdout)
        cases = [b"bad json", b'{"ok":true,"ok":true}', canonical(dict(ok=True, handoff={})),
                 canonical(dict(ok=False, result=base["result"])), canonical(dict(base, extra=True))]
        for value in (None, [], "handoff", {}, True):
            cases.append(canonical(dict(ok=True, result=dict(base["result"], handoff=value))))
        for key, value in (("schema_version", True), ("run_id", "other"), ("scope_id", "other"),
                           ("authority_sha256", "a" * 64), ("fields", {}), ("origins", []),
                           ("origins", {"different": None}), ("extra", 1)):
            changed = copy.deepcopy(base)
            changed["result"]["handoff"][key] = value
            cases.append(canonical(changed))
        for key in ("fields", "origins", "authority_sha256"):
            changed = copy.deepcopy(base)
            del changed["result"]["handoff"][key]
            cases.append(canonical(changed))
        for index, raw in enumerate(cases):
            with self.subTest(index=index):
                directory = self.root / f"bad-{index}"
                directory.mkdir(mode=0o700)
                ref = self.write(f"bad-{index}.json", dict(self.spec, directory=str(directory)))
                with patch("operator_authority.subprocess.run", return_value=subprocess.CompletedProcess([], 0, raw, b"")) as run:
                    self.assertFalse(check(ref)["ok"])
                self.assertEqual(run.call_count, 1)
                self.assertFalse((directory / "completed.json").exists())
                self.assertFalse((directory / "handoff-authority.json").exists())

    def test_checker_rejection_and_nonzero_resolver(self):
        for mode in ("resolve-authority", "check-authority-handoff"):
            directory = self.root / mode
            directory.mkdir(mode=0o700)
            ref = self.write(mode + ".json", dict(self.spec, directory=str(directory)))
            def rejected(*args, **kwargs):
                if parse(kwargs["input"])["argv"][0] == mode:
                    return subprocess.CompletedProcess([], 2, b"", b"authority_handoff_conflict")
                return self.reply(*args, **kwargs)
            with patch("operator_authority.subprocess.run", side_effect=rejected):
                self.assertFalse(check(ref)["ok"])
            self.assertFalse((directory / "completed.json").exists())
            self.assertFalse((directory / "handoff-authority.json").exists())

    def test_drift_before_commit(self):
        def drift(*args, **kwargs):
            result = self.reply(*args, **kwargs)
            if parse(kwargs["input"])["argv"][0] == "check-authority-handoff":
                (self.root / "original.txt").write_text("changed")
            return result
        with patch("operator_authority.subprocess.run", side_effect=drift):
            self.assertFalse(check(self.input)["ok"])
        self.assertEqual(reconcile(self.input)["state"], "incomplete")

    def test_checker_addition_and_input_drift_are_not_repinned(self):
        for name in ("checker", "input", "candidate"):
            with self.subTest(name=name):
                directory = self.root / ("drift-" + name)
                directory.mkdir(mode=0o700)
                ref = self.write("drift-" + name + ".json", dict(self.spec, directory=str(directory)))
                def drift(*args, **kwargs):
                    result = self.reply(*args, **kwargs)
                    if parse(kwargs["input"])["argv"][0] == "check-authority-handoff":
                        if name == "checker":
                            (self.checker / "rsi" / "extra.py").write_text("# drift")
                        elif name == "input":
                            Path(ref["path"]).write_text("{}")
                        else:
                            (directory / "handoff-candidate.json").write_text("null")
                    return result
                with patch("operator_authority.subprocess.run", side_effect=drift):
                    self.assertFalse(check(ref)["ok"])
                self.assertFalse((directory / "completed.json").exists())
                if name == "checker":
                    (self.checker / "rsi" / "extra.py").unlink()

    def test_wrong_progress_diagnostic_never_commits(self):
        generated = self.generate()
        _, spec = self.progress(generated)
        directory = self.root / "diagnostic-mismatch"
        directory.mkdir(mode=0o700)
        ref = self.write("diagnostic-mismatch.json", dict(spec, directory=str(directory)))
        def wrong(*args, **kwargs):
            proc = self.reply(*args, **kwargs)
            envelope = parse(proc.stdout)
            envelope["authority_check"]["scope_id"] = "other"
            proc.stdout = canonical(envelope)
            return proc
        with patch("operator_authority.subprocess.run", side_effect=wrong):
            result = check(ref)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "authority_progress_receipt_mismatch")
        self.assertEqual(reconcile(ref)["state"], "incomplete")

    def test_manifest_cannot_claim_another_checked_handoff(self):
        generated = self.generate()
        completion = Path(generated["completion"]["path"])
        bundle = parse(pinned(generated["completion"]))
        invocation_ref = bundle["calls"][1]["invocation"]
        invocation = parse(pinned(invocation_ref))
        invocation["argv"][invocation["argv"].index("--handoff") + 1] = generated["handoff"]["path"]
        replace_json(Path(invocation_ref["path"]), invocation)
        bundle["calls"][1]["invocation"] = file_ref(invocation_ref["path"])
        replace_json(completion, bundle)
        with self.assertRaisesRegex(ValueError, "invocation_mismatch"):
            verify_bundle(file_ref(completion), [str(self.root)])

    def test_crash_before_commit_preserves_nonconsumable_files(self):
        def crash(target, value):
            if target.name == "completed.json":
                raise KeyboardInterrupt
            publish_new(target, value)
        with patch("operator_authority.publish_new", side_effect=crash), \
             patch("operator_authority.subprocess.run", side_effect=self.reply), self.assertRaises(KeyboardInterrupt):
            check(self.input)
        self.assertTrue((Path(self.spec["directory"]) / "handoff-authority.json").exists())
        self.assertEqual(reconcile(self.input)["state"], "incomplete")
        with self.assertRaisesRegex(ValueError, "attempt_not_empty"):
            check(self.input)

    def test_fsync_failure_after_commit_reconciles_without_reexecution(self):
        def fault(target, value):
            if target.name == "completed.json":
                with patch("coordinator_io.fsync_dir", side_effect=OSError(errno.EIO, "fsync")):
                    publish_new(target, value)
            else:
                publish_new(target, value)
        with patch("operator_authority.publish_new", side_effect=fault), \
             patch("operator_authority.subprocess.run", side_effect=self.reply):
            result = check(self.input)
        self.assertEqual(result["state"], "publication_unknown")
        with patch("operator_authority.subprocess.run") as run:
            self.assertEqual(reconcile(self.input)["state"], "committed")
        run.assert_not_called()
        self.assertFalse((Path(self.spec["directory"]) / "failure.json").exists())

    def test_crash_after_commit_read_only_reconciliation(self):
        def crash(target, value):
            publish_new(target, value)
            if target.name == "completed.json":
                raise KeyboardInterrupt
        with patch("operator_authority.publish_new", side_effect=crash), \
             patch("operator_authority.subprocess.run", side_effect=self.reply), self.assertRaises(KeyboardInterrupt):
            check(self.input)
        self.assertTrue(reconcile(self.input)["ok"])

    def test_unwritable_failure_evidence_is_best_effort(self):
        def fault(target, value):
            if target.name != "resolve-intent.json":
                raise PermissionError(errno.EACCES, "fixture")
            publish_new(target, value)
        with patch("operator_authority.publish_new", side_effect=fault):
            result = check(self.input)
        self.assertFalse(result["ok"])
        self.assertNotIn("failure", result)

    def test_concurrent_claim_loser_never_publishes_failure(self):
        barrier = threading.Barrier(2)
        def race(target, value):
            if target.name == "resolve-intent.json":
                barrier.wait(timeout=10)
            publish_new(target, value)
        outcomes = []
        def invoke():
            try:
                outcomes.append(check(self.input))
            except FileExistsError:
                outcomes.append("lost")
        with patch("operator_authority.publish_new", side_effect=race), \
             patch("operator_authority.subprocess.run", side_effect=self.reply) as run:
            threads = [threading.Thread(target=invoke) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(outcomes.count("lost"), 1)
        self.assertTrue(next(item for item in outcomes if isinstance(item, dict))["ok"], outcomes)
        self.assertEqual(run.call_count, 2)
        self.assertFalse((Path(self.spec["directory"]) / "failure.json").exists())

    def test_progress_requires_matching_generated_authority_before_execution(self):
        generated = self.generate()
        _, spec = self.progress(generated)
        spec["directory"] = str(self.root / "wrong-progress")
        Path(spec["directory"]).mkdir(mode=0o700)
        spec["inputs"]["handoff"] = self.write("manual-handoff.json", parse(pinned(generated["handoff"])))
        ref = self.write("wrong-progress.json", spec)
        with patch("operator_authority.subprocess.run") as run, self.assertRaisesRegex(ValueError, "generation_mismatch"):
            check(ref)
        run.assert_not_called()
        self.assertEqual(list(Path(spec["directory"]).iterdir()), [])

    def test_config_load_and_later_checkpoint_reject_downgrade(self):
        self.progress(self.generate())
        prepared = self.p.prepare()
        config, contract, _ = load(prepared["config"])
        record = parse(pinned(prepared["checkpoint"]))
        legacy = copy.deepcopy(record)
        legacy["domain_check"].pop("completion")
        legacy["domain_check"]["adapter"] = "rsi-authorized-progress-v1"
        with self.assertRaisesRegex(ValueError, "domain_check_required"):
            validate_record(legacy, config, contract)
        for value in (None, dict(config["authority_binding"], protocol="unknown")):
            changed = dict(config, authority_binding=value)
            ref = self.write("invalid-config.json", changed)
            with self.assertRaisesRegex(ValueError, "authority_binding_invalid"):
                load(ref)
        removed = dict(config)
        removed.pop("authority_binding")
        with self.assertRaisesRegex(ValueError, "domain_check_required"):
            validate_record(record, removed, contract)

    def test_missing_completion_or_tampered_output_rejected(self):
        generated = self.generate()
        self.progress(generated)
        manifest = Path(generated["completion"]["path"])
        raw = manifest.read_bytes()
        manifest.unlink()
        with self.assertRaises(FileNotFoundError):
            self.p.prepare()
        self.assertFalse(self.p.output.exists())
        manifest.write_bytes(raw)
        Path(generated["handoff"]["path"]).write_text("null")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.p.prepare()
        self.assertFalse(self.p.output.exists())

    def test_two_valid_progress_bundles_cannot_be_mixed(self):
        generated = self.generate()
        first, _ = self.progress(generated)
        first_inputs = copy.deepcopy(self.p.inputs)
        context = read_json(self.p.inputs["authority_binding"]["context"]["path"])
        context["paths"] = [{"id": "different", "permissions": ["local_edit"]}]
        second, _ = self.progress(generated, name="second", context_ref=self.write("other-context.json", context))
        verify_bundle(first["completion"], [str(self.root)])
        verify_bundle(second["completion"], [str(self.root)])
        self.p.inputs["authority_binding"] = first_inputs["authority_binding"]
        with self.assertRaisesRegex(ValueError, "progress_binding_mismatch"):
            self.p.prepare()
        self.assertFalse(self.p.output.exists())

    def test_later_valid_checkpoint_cannot_switch_authority_context(self):
        generated = self.generate()
        self.progress(generated)
        prepared = self.p.prepare()
        config, contract, _ = load(prepared["config"])
        record = parse(pinned(prepared["checkpoint"]))
        context = read_json(config["authority_binding"]["context"]["path"])
        context["paths"] = [{"id": "later-path", "permissions": ["local_edit"]}]
        self.progress(generated, name="later", context_ref=self.write("later-context.json", context))
        record["domain_check"].update(source=self.p.inputs["source"], receipt=self.p.inputs["receipt"],
                                      completion=self.p.inputs["completion"])
        with self.assertRaisesRegex(ValueError, "progress_binding_mismatch"):
            validate_record(record, config, contract)

    def test_matching_new_checkpoint_works_with_same_binding(self):
        generated = self.generate()
        self.progress(generated)
        prepared = self.p.prepare()
        config, contract, _ = load(prepared["config"])
        record = parse(pinned(prepared["checkpoint"]))
        self.progress(generated, name="next")
        record["domain_check"].update(source=self.p.inputs["source"], receipt=self.p.inputs["receipt"],
                                      completion=self.p.inputs["completion"])
        validate_record(record, config, contract)


if __name__ == "__main__":
    unittest.main()
