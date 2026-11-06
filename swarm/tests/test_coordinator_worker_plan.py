"""Offline launch planning; no real Orca or model process is started."""

import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_launch import main
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import PROFILES
import offline_env


class WorkerPlanTests(unittest.TestCase):
    def setUp(self):
        # These assertions describe the bundled fixture, so a private Operator override
        # in the caller's environment must not change which file the plan pins.
        self.addCleanup(offline_env.cleared().stop)

    def request(self, **updates):
        return dict(schema_version=2, cli="/verified/orca-server-cli", run="run_test",
                    task="task_test", model="gpt-5.5", profiles_sha256=file_ref(PROFILES)["sha256"],
                    placement={"kind": "existing", "worktree": "id:repo::/worker space"},
                    **updates)

    def test_existing_workspace_never_emits_creation_flags(self):
        for target in ("id:repo::/worker space", "id:folder-workspace"):
            for on in (None, "verified-remote"):
                request = self.request()
                request["placement"]["worktree"] = target
                if on:
                    request["on"] = on
                before = copy.deepcopy(request)
                plan = build_plan(request)
                self.assertEqual(request, before)
                self.assertIn(target, plan["argv"])
                for flag in ("name", "repo", "base-branch", "display-name", "comment", "setup"):
                    self.assertNotIn("--" + flag, plan["argv"])
                self.assertEqual(shlex.split(plan["command"]), plan["argv"])
                self.assertFalse(plan["effectsApplied"])
                self.assertFalse(plan["runtime_verified"])

    def test_observed_wave_label_is_rejected_not_dropped_or_reinterpreted(self):
        for field in ("name", "repo", "base_branch", "display_name", "comment", "setup"):
            for value in ("wave1-review", "", None, False):
                request = self.request()
                request["placement"][field] = value
                with self.subTest(field=field, value=value), self.assertRaisesRegex(
                        ValueError, "existing.*creation fields"):
                    build_plan(request)
        with self.assertRaisesRegex(ValueError, "unknown request fields"):
            build_plan(self.request(name="wave1-review"))

    def test_inline_task_title_is_not_a_worktree_name(self):
        request = self.request(task_title="wave1-review")
        del request["task"]
        request["spec"] = "Review this worker's code; $(never-execute)\n中文"
        plan = build_plan(request)
        self.assertIn("--task-title", plan["argv"])
        self.assertNotIn("--name", plan["argv"])
        self.assertEqual(shlex.split(plan["command"]), plan["argv"])
        request["spec"] = "--literal-leading-dashes"
        self.assertIn("--spec=--literal-leading-dashes", build_plan(request)["argv"])

    def test_new_worktrees_keep_explicit_creation_options(self):
        for kind in ("new-child", "new-top-level"):
            request = self.request()
            request["placement"] = dict(kind=kind, name="wave1-implementation", repo="id:repo",
                base_branch="approved-sha", display_name="Wave 1", comment="separate worktree",
                setup="skip")
            argv = build_plan(request)["argv"]
            for flag, value in (("worktree", kind), ("name", "wave1-implementation"),
                                ("repo", "id:repo"), ("base-branch", "approved-sha"),
                                ("display-name", "Wave 1"), ("comment", "separate worktree"),
                                ("setup", "skip")):
                self.assertEqual(argv[argv.index("--" + flag) + 1], value)
        del request["placement"]["setup"]
        self.assertNotIn("--setup", build_plan(request)["argv"])
        del request["placement"]["name"]
        with self.assertRaisesRegex(ValueError, "name"):
            build_plan(request)

    def test_placement_and_remote_constraints_fail_closed(self):
        for placement in ({"kind": "current"}, {"kind": "existing", "worktree": "current"},
                          {"kind": "existing", "worktree": "name:review"},
                          {"kind": "new-child", "name": "worker", "worktree": "id:old"},
                          {"kind": "new-top-level", "name": "worker"}):
            request = self.request()
            request["placement"] = placement
            with self.subTest(placement=placement), self.assertRaises(ValueError):
                build_plan(request)
        request = self.request(on="verified-remote")
        request["placement"] = dict(kind="new-child", name="worker")
        with self.assertRaisesRegex(ValueError, "remote new-child"):
            build_plan(request)
        request["placement"] = dict(kind="new-top-level", name="worker", repo="id:repo")
        self.assertIn("verified-remote", build_plan(request)["argv"])

    def test_terminal_reuse_preserves_target_without_launch_overrides(self):
        request = self.request(terminal="term_existing")
        for field in ("model", "profiles_sha256"):
            del request[field]
        self.assertIn("term_existing", build_plan(request)["argv"])
        for field in ("agent", "model", "effort", "backend_variant", "writable_roots", "profiles_sha256"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                build_plan(dict(request, **{field: "unsupported"}))

    def test_invalid_or_unknown_input_does_not_silently_change_intent(self):
        for changes in ({"schema_version": True}, {"cli": "orca"}, {"run": ""},
                        {"spec": "also supplied"}, {"task_title": "ignored title"},
                        {"effort": None}, {"model": "contains\0nul"}, {"timeout_ms": True},
                        {"timeout_ms": 0}, {"writable_roots": []}, {"extra_args": ["--name", "bad"]}):
            request = dict(self.request(), **changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                build_plan(request)

    def test_launch_dependencies_are_validated_and_preserved(self):
        request = self.request()
        del request["model"]
        with self.assertRaisesRegex(ValueError, "invalid model"):
            build_plan(request)
        request = self.request(retry_of="dispatch_failed", timeout_ms=45000)
        argv = build_plan(request)["argv"]
        self.assertIn("dispatch_failed", argv)
        self.assertIn("45000", argv)
        del request["task"]
        request.update(spec="new task", task_title="review", deps=["task_parent"], parent="task_parent")
        with self.assertRaisesRegex(ValueError, "retry_of requires task"):
            build_plan(request)
        del request["retry_of"]
        argv = build_plan(request)["argv"]
        self.assertEqual(json.loads(argv[argv.index("--deps") + 1]), ["task_parent"])

    def test_cli_rejects_duplicate_keys_and_creation_fields_with_no_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "request.json"
            request = self.request()
            request["placement"]["name"] = "wave1-review"
            for raw, message in ((json.dumps(request), "existing placement rejects"),
                                 ('{"schema_version":2,"schema_version":2}', "duplicate_json_key")):
                path.write_text(raw)
                with patch("subprocess.Popen") as spawn, redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(main(["worker-plan", "--request", str(path),
                                           "--request-sha256", file_ref(path)["sha256"]]), 2)
                    result = json.loads(output.getvalue())
                    self.assertIn(message, result["error"])
                    self.assertNotIn("argv", result)
                    spawn.assert_not_called()

    def test_writable_roots_remain_an_explicit_existing_trae_option(self):
        roots = ["/approved/worker evidence"]
        request = self.request(writable_roots=roots)
        argv = build_plan(request)["argv"]
        self.assertEqual(json.loads(argv[argv.index("--writable-roots") + 1]), roots)
        for changes in ({"agent": "codex"}, {"on": "remote"},
                        {"placement": {"kind": "new-child", "name": "worker"}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                build_plan(dict(request, **changes))

    def test_write_isolation_requires_private_workspace_and_exact_write_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace = root / "review"
            source = root / "source"
            workspace.mkdir()
            source.mkdir()
            isolation = {"workspace_root": str(workspace), "read_only_roots": [str(source)]}
            request = self.request(writable_roots=[str(workspace)], write_isolation=isolation)
            argv = build_plan(request)["argv"]
            self.assertEqual(json.loads(argv[argv.index("--writable-roots") + 1]),
                             [str(workspace)])
            self.assertNotIn("--write-isolation", argv)
            for changed in ([str(source)], [str(workspace), str(source)]):
                with self.subTest(writable_roots=changed), self.assertRaisesRegex(
                        ValueError, "only writable_root"):
                    build_plan(dict(request, writable_roots=changed))

    def test_write_isolation_rejects_overlap_noncanonical_and_unsafe_placement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace = root / "review"
            source = root / "source"
            nested = source / "nested"
            workspace.mkdir()
            nested.mkdir(parents=True)
            base = self.request(writable_roots=[str(workspace)], write_isolation={
                "workspace_root": str(workspace), "read_only_roots": [str(source)]})
            variants = []
            overlap = copy.deepcopy(base)
            overlap["write_isolation"]["workspace_root"] = str(nested)
            overlap["writable_roots"] = [str(nested)]
            variants.append(overlap)
            duplicate = copy.deepcopy(base)
            duplicate["write_isolation"]["read_only_roots"] = [str(source), str(source)]
            variants.append(duplicate)
            missing = copy.deepcopy(base)
            missing["write_isolation"]["workspace_root"] = str(root / "missing")
            missing["writable_roots"] = [str(root / "missing")]
            variants.append(missing)
            workspace_link = root / "review-link"
            workspace_link.symlink_to(workspace, target_is_directory=True)
            linked = copy.deepcopy(base)
            linked["write_isolation"]["workspace_root"] = str(workspace_link)
            linked["writable_roots"] = [str(workspace_link)]
            variants.append(linked)
            noncanonical = copy.deepcopy(base)
            noncanonical["write_isolation"]["read_only_roots"] = [
                str(source / ".." / source.name)]
            variants.append(noncanonical)
            variants.append(dict(base, on="remote"))
            for request in variants:
                with self.subTest(request=request), self.assertRaises(ValueError):
                    build_plan(request)

    def test_cli_routes_pinned_request_without_subprocess_or_file_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "request.json"
            path.write_text(json.dumps(self.request()))
            ref = file_ref(path)
            args = ["worker-plan", "--request", str(path), "--request-sha256", ref["sha256"]]
            with patch("subprocess.Popen") as spawn, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(args), 0)
                self.assertEqual(json.loads(output.getvalue())["argv"][0], "/verified/orca-server-cli")
                spawn.assert_not_called()
            self.assertEqual(list(path.parent.iterdir()), [path])
            path.write_text(json.dumps(self.request(name="changed")))
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(args), 2)
                self.assertEqual(json.loads(output.getvalue())["error"], "file_pin_changed")

    def test_model_only_resolves_fixed_profiles_without_mutating_request(self):
        for model, effort, backend in (("DeepSeek-V4.1-Flash", None, "max"),
                                       ("gpt-5.6-sol", "high", "max"),
                                       ("gpt-5.5", "high", "max"),
                                       ("gpt-5.4", "xhigh", "standard")):
            request = dict(self.request(), model=model)
            before = copy.deepcopy(request)
            plan = build_plan(request)
            argv = plan["argv"]
            self.assertEqual(argv[argv.index("--agent") + 1], "trae")
            self.assertEqual(argv[argv.index("--model") + 1], model)
            self.assertEqual(argv[argv.index("--backend-variant") + 1], backend)
            if effort:
                self.assertEqual(argv[argv.index("--effort") + 1], effort)
            else:
                self.assertNotIn("--effort", argv)
            self.assertEqual(plan["resolved_profile"]["config"], file_ref(PROFILES))
            self.assertEqual(request, before)

    def test_pi_profile_passes_only_the_pinned_model_selector(self):
        request = dict(self.request(), model="example-pi-model")
        before = copy.deepcopy(request)
        plan = build_plan(request)
        argv = plan["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "pi")
        self.assertEqual(argv[argv.index("--model") + 1], "example-pi-model")
        # Trae launch settings must not be invented for Pi.
        self.assertNotIn("--effort", argv)
        self.assertNotIn("--backend-variant", argv)
        self.assertEqual(argv[-1], "--json")
        self.assertEqual(plan["resolved_profile"]["agent"], "pi")
        self.assertEqual(plan["resolved_profile"]["config"], file_ref(PROFILES))
        self.assertEqual(request, before)

    def test_pi_profiles_reject_trae_launch_settings_and_unknown_agents(self):
        original = json.loads(PROFILES.read_text())
        with tempfile.TemporaryDirectory() as directory:
            profile_path = Path(directory).resolve() / "profiles.json"
            for changes, error in (({"effort": "high"}, "invalid_pi_profile_settings"),
                                   ({"effort": "max"}, "invalid_pi_profile_settings"),
                                   ({"backend_variant": "max"}, "invalid_pi_profile_settings"),
                                   ({"backend_variant": "standard"}, "invalid_pi_profile_settings"),
                                   ({"agent": "codex"}, "invalid_worker_profile_settings"),
                                   ({"blocked_reason": "pi_unverified"}, "worker_profile_blocked")):
                changed = copy.deepcopy(original)
                changed["profiles"]["example-pi-model"].update(changes)
                profile_path.write_text(json.dumps(changed))
                with patch("coordinator_worker_profiles.PROFILES", profile_path):
                    with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, error):
                        build_plan(dict(self.request(), model="example-pi-model",
                                        profiles_sha256=file_ref(profile_path)["sha256"]))

    def test_codex_ark_profile_pins_only_the_agent_and_never_invents_a_model_flag(self):
        # Orca has no worker launch-preference catalog for codex-ark: --model/--effort/
        # --backend-variant are refused, so the wrapper config owns the model and only the
        # agent is passed. The declared identity stays visible in resolved_profile.
        request = dict(self.request(), model="codex-ark/example-ark-model")
        before = copy.deepcopy(request)
        plan = build_plan(request)
        argv = plan["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "codex-ark")
        for flag in ("--model", "--effort", "--backend-variant"):
            self.assertNotIn(flag, argv)
        self.assertEqual(argv[-1], "--json")
        self.assertEqual(plan["resolved_profile"]["agent"], "codex-ark")
        self.assertEqual(plan["resolved_profile"]["model"], "codex-ark/example-ark-model")
        self.assertEqual(plan["resolved_profile"]["model_source"], "agent_config")
        self.assertEqual(plan["resolved_profile"]["config"], file_ref(PROFILES))
        self.assertEqual(request, before)

    def test_codex_ark_profile_rejects_launch_settings_unscoped_keys_and_blocks(self):
        original = json.loads(PROFILES.read_text())
        with tempfile.TemporaryDirectory() as directory:
            profile_path = Path(directory).resolve() / "profiles.json"
            variants = []
            for changes, error in (({"effort": "high"}, "invalid_codex_ark_profile_settings"),
                                   ({"backend_variant": "max"}, "invalid_codex_ark_profile_settings"),
                                   ({"blocked_reason": "ark_worker_unverified"},
                                    "worker_profile_blocked")):
                changed = copy.deepcopy(original)
                changed["profiles"]["codex-ark/example-ark-model"].update(changes)
                variants.append((changed, error))
            # A declared Ark model identity must not double as another agent's model id.
            unscoped = copy.deepcopy(original)
            unscoped["profiles"]["example-ark-model"] = unscoped["profiles"].pop(
                "codex-ark/example-ark-model")
            variants.append((unscoped, "invalid_codex_ark_profile_key"))
            for catalog, error in variants:
                profile_path.write_text(json.dumps(catalog))
                with patch("coordinator_worker_profiles.PROFILES", profile_path):
                    with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                        build_plan(dict(self.request(), model="codex-ark/example-ark-model",
                                        profiles_sha256=file_ref(profile_path)["sha256"]))

    def test_even_matching_or_null_launch_overrides_are_rejected(self):
        for field, value in (("agent", "trae"), ("effort", "high"), ("effort", "xhigh"),
                             ("backend_variant", "max"), ("backend_variant", "standard")):
            for setting in (value, None, ""):
                with self.subTest(field=field, value=setting), self.assertRaisesRegex(
                        ValueError, "fixed_choose_model_only"):
                    build_plan(dict(self.request(), **{field: setting}))

    def test_incomplete_and_unknown_profiles_fail_before_launch(self):
        with patch("subprocess.Popen") as spawn:
            for model, error in (("example-blocked-model", "effort_and_standard"),
                                 ("GPT-5.5", "not_in_fixed_profiles"),
                                 ("other", "not_in_fixed_profiles")):
                with self.subTest(model=model), self.assertRaisesRegex(ValueError, error):
                    build_plan(dict(self.request(), model=model))
            spawn.assert_not_called()

    def test_legacy_request_is_not_silently_reinterpreted_or_a_bypass(self):
        with self.assertRaisesRegex(ValueError, "legacy_worker_request_requires_fixed_profile_migration"):
            build_plan(dict(self.request(), schema_version=1, agent="trae", effort="xhigh"))

    def test_missing_changed_or_alternate_profile_pin_fails_closed(self):
        for sha in (None, "", "0" * 64, False):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                build_plan(dict(self.request(), profiles_sha256=sha))
        with self.assertRaisesRegex(ValueError, "unknown request fields"):
            build_plan(dict(self.request(), profiles_path="/tmp/my-own-profile.json"))
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory).resolve() / "missing-profile.json"
            with patch("coordinator_worker_profiles.PROFILES", missing):
                with self.assertRaisesRegex(ValueError, "worker_profiles_unreadable"):
                    build_plan(self.request())

    def test_malformed_catalog_and_unverified_backend_adapter_fail_closed(self):
        original = json.loads(PROFILES.read_text())
        with tempfile.TemporaryDirectory() as directory:
            profile_path = Path(directory).resolve() / "profiles.json"
            variants = [dict(original, scope="swarm_coordinator_only"),
                        dict(original, schema_version=True), dict(original, profiles=[])]
            for changes in ({"effort": "max"}, {"agent": "codex"}, {"backend_variant": None},
                            {"extra_args": []}, {"blocked_reason": False}):
                changed = copy.deepcopy(original)
                changed["profiles"]["gpt-5.5"].update(changes)
                variants.append(changed)
            changed = copy.deepcopy(original)
            changed["profiles"]["gpt-5.5"]["backend_variant"] = "standard"
            variants.append(changed)
            for catalog in variants:
                profile_path.write_text(json.dumps(catalog))
                with patch("coordinator_worker_profiles.PROFILES", profile_path):
                    with self.subTest(catalog=catalog), self.assertRaises(ValueError):
                        build_plan(dict(self.request(), profiles_sha256=file_ref(profile_path)["sha256"]))
            profile_path.write_text('{"schema_version":1,"schema_version":1}')
            with patch("coordinator_worker_profiles.PROFILES", profile_path):
                with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
                    build_plan(dict(self.request(), profiles_sha256=file_ref(profile_path)["sha256"]))


if __name__ == "__main__":
    unittest.main()
