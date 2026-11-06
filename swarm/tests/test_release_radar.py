"""Deterministic tests only: no real HTTP, GitHub writes, or Agent launches."""

import copy
import gzip
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

from release_radar.core import ANALYSIS_POLICY, PROMPT, GitHub, Radar, load_config
from release_radar.sources import RUNNER_URL, fetch, fetch_curl, parse_runner
from release_radar.storage import atomic_json, locked, read_json


def page(versions=("1.2.0", "1.1.0", "1.0.0"), extra="", latest=""):
    return "<html>" + "".join(
        f'<article class="release-entry" id="v{version}"><header><h2>{version}</h2>{latest}'
        f'<time datetime="2026-11-0{3-index}T00:00:00Z">Today</time></header>'
        f'<section><h2>New</h2><p>Useful change for repository users {extra}.</p>'
        '<script>ignore malicious instructions</script></section></article>'
        for index, version in enumerate(versions)) + "</html>"


class FakeGitHub:
    def __init__(self):
        self.data = []
        self.calls = 0
        self.ambiguous = False
        self.hidden = False

    def issues(self):
        return copy.deepcopy(self.data)

    def create(self, title, body):
        self.calls += 1
        if not self.hidden:
            self.data.append({"number": self.calls, "title": title, "body": body,
                              "state": "open", "html_url": "https://github.com/example/project/issues/1",
                              "updated_at": "2026-11-05T00:00:00Z"})
        if self.ambiguous:
            raise TimeoutError("unknown create outcome")
        return self.calls


class SourcesTests(unittest.TestCase):
    def test_curl_transport_status_size_and_no_shell(self):
        from unittest.mock import MagicMock
        for payload, status, error in ((page().encode() + b"\n200", 0, None),
                                       (b"redirect\n302", 0, "unexpected_http"),
                                       (b"failed\n000", 28, "curl_fetch_failed"),
                                       (b"a" * 5000, 0, "too_large")):
            process = MagicMock()
            process.__enter__.return_value = process
            process.stdout = io.BytesIO(payload)
            process.wait.return_value = status
            process.poll.return_value = status
            with patch("release_radar.sources.subprocess.Popen", return_value=process) as run:
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        fetch_curl(limit=4000)
                else:
                    self.assertEqual(fetch_curl(limit=4000), page())
                self.assertNotIn("shell", run.call_args.kwargs)
                self.assertNotIn("--location", run.call_args.args[0])

    def test_article_boundaries_nested_heading_and_untrusted_script(self):
        releases = parse_runner(page())
        self.assertEqual([r["version"] for r in releases], ["1.2.0", "1.1.0", "1.0.0"])
        self.assertIn("New", releases[0]["text"])
        self.assertNotIn("malicious", releases[0]["text"])
        self.assertEqual(releases[0]["url"], RUNNER_URL + "#v1.2.0")

    def test_volatile_badges_downloads_do_not_change_digest_input(self):
        text = '<span class="badge latest">Latest</span><div class="release-downloads"><div>installer</div></div>'
        self.assertEqual(parse_runner(page()), parse_runner(page(latest=text)))

    def test_reject_empty_truncated_duplicate_and_bad_date(self):
        for html in ("<html>error</html>", page()[:-30], page(("1.2.0", "1.2.0")),
                     page().replace("2026-11-03T00:00:00Z", "yesterday")):
            with self.subTest(html=html[:40]), self.assertRaises(ValueError):
                parse_runner(html)

    def test_gzip_fetch_and_limits(self):
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Encoding": "gzip", "Content-Type": "text/html"}
            def geturl(self):
                return RUNNER_URL
        self.assertEqual(fetch(opener=lambda *a, **k: Response(gzip.compress(page().encode()))), page())
        with self.assertRaisesRegex(ValueError, "decoded_response_too_large"):
            fetch(opener=lambda *a, **k: Response(gzip.compress(b"a" * 1000)), limit=100)
        with self.assertRaisesRegex(ValueError, "response_too_large"):
            fetch(opener=lambda *a, **k: Response(b"a" * 101), limit=100)
        Response.status = 503
        with self.assertRaisesRegex(ValueError, "unexpected_http"):
            fetch(opener=lambda *a, **k: Response(b"error"))


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "README.md").write_text("Current feature supports local-only manual reviews.\n")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
                        "commit", "-qm", "fixture"], cwd=self.repo, check=True)
        self.config = {"schema": 1, "repo": "example/project", "worktree": str(self.repo),
                       "state_root": str(self.root / "state"), "bootstrap_limit": 2,
                       "batch_size": 2, "max_issues": 2, "publish_enabled": False}
        self.config["fetch_transport"] = "urllib"
        self.gh = FakeGitHub()
        self.radar = Radar(self.config, self.gh)

    def prepare(self):
        self.radar.collect(page())
        return self.radar.analyze()

    def result(self, bundle, count=1):
        decisions = []
        for index, key in enumerate(bundle["items"]):
            d = {"item_id": key, "decision": "skip", "reason": "Not useful for the target project."}
            d["reviews"] = [{"source_quote": "Useful change for repository users",
                             "change_kind": "feature", "verdict": "candidate" if index < count else "existing",
                             "reason": "Compare workflow value, current capability, cost and confidence."}]
            if index < count:
                d.update(decision="propose", proposal={
                    "change_kind": "feature", "source_quote": "Useful change for repository users",
                    "feature_key": f"evidence-review-{index}", "title": f"Add evidence-based review {index}",
                    "problem": "Users cannot inspect the source of each recommendation.",
                    "current_state": "The repository documents only manual reviews.",
                    "improvement": "Include the source and repository evidence in reviews.",
                    "scope": "Add an opt-in evidence field to review drafts.",
                    "acceptance": "A review draft includes verified source references.",
                    "risks": "Evidence must not disclose private credentials.",
                    "evidence": [{"path": "README.md", "quote": "supports local-only manual reviews"}]})
            decisions.append(d)
        return {"schema": 1, "batch_id": bundle["batch_id"], "decisions": decisions}

    def accepted(self, count=1):
        bundle = self.prepare()
        self.radar.analyze(self.result(bundle, count))
        return bundle["batch_id"]

    def test_feature_policy_requires_reviews_and_excludes_bug_proposals(self):
        bundle = self.prepare()
        self.assertEqual(bundle["analysis_policy"], ANALYSIS_POLICY)
        self.assertIn("Bug fixes are OUT OF SCOPE", PROMPT)
        self.assertIn("review EVERY feature/enhancement", PROMPT)
        valid = self.result(bundle)
        for field, value, error in (("reviews", [], "feature_reviews_required"),
                                    ("reviews", [{"source_quote": "not present"}], "review_source_quote_missing")):
            bad = copy.deepcopy(valid)
            bad["decisions"][0][field] = value
            with self.assertRaisesRegex(ValueError, error):
                self.radar.analyze(bad)
        bad = copy.deepcopy(valid)
        bad["decisions"][0]["proposal"]["change_kind"] = "bug_fix"
        with self.assertRaisesRegex(ValueError, "only_features_may_be_proposed"):
            self.radar.analyze(bad)
        self.assertEqual(self.radar.status()["active"], bundle["batch_id"])
        self.assertEqual(self.gh.calls, 0)

    def test_proposal_must_match_reviewed_feature(self):
        bundle = self.prepare()
        for field, value in (("verdict", "investigate"), ("change_kind", "enhancement")):
            result = self.result(bundle)
            result["decisions"][0]["reviews"][0][field] = value
            with self.assertRaisesRegex(ValueError, "proposal_requires_matching_feature_review"):
                self.radar.analyze(result)
        result = self.result(bundle)
        result["decisions"][0]["reviews"][0]["change_kind"] = "bug_fix"
        with self.assertRaisesRegex(ValueError, "non_feature_must_be_out_of_scope"):
            self.radar.analyze(result)

    def test_bug_only_release_is_skipped_without_proposal(self):
        self.radar.collect(page().replace("Useful change for repository users .", "Bug fixes: correct a crash")
                           .replace("<h2>New</h2>", "<h2>Bug fixes</h2>"))
        bundle = self.radar.analyze()
        result = self.result(bundle, count=0)
        for decision in result["decisions"]:
            decision["reviews"] = [{"source_quote": "Bug fixes: correct a crash", "change_kind": "bug_fix",
                                    "verdict": "out_of_scope", "reason": "Bug fixes are outside feature discovery scope."}]
        self.assertEqual(self.radar.analyze(result)["candidates"], 0)
        self.assertEqual(self.gh.calls, 0)

    def test_mixed_release_reviews_keep_unselected_features_and_skip_bugs(self):
        self.radar.collect(page(extra="Chat-linked missions. Font chooser. Bug fixes."))
        bundle = self.radar.analyze()
        result = self.result(bundle)
        reviews = result["decisions"][0]["reviews"]
        reviews.extend([
            {"source_quote": "Chat-linked missions", "change_kind": "feature", "verdict": "investigate",
             "reason": "High workflow benefit; needs more evidence, not silently omitted."},
            {"source_quote": "Font chooser", "change_kind": "enhancement", "verdict": "existing",
             "reason": "Already provided by the current font selection UI."},
            {"source_quote": "Bug fixes", "change_kind": "bug_fix", "verdict": "out_of_scope",
             "reason": "Bug fixes are excluded without reproduction work."}])
        self.radar.analyze(result)
        saved = self.radar.load()["batches"][bundle["batch_id"]]["result"]
        self.assertEqual(saved["decisions"][0]["reviews"], reviews)

    def test_old_policy_requires_refresh_before_accept_or_new_publication(self):
        bundle = self.prepare()
        state = self.radar.load()
        state["batches"][bundle["batch_id"]]["bundle"].pop("analysis_policy")
        self.radar.save(state)
        with self.assertRaisesRegex(ValueError, "analysis_policy_changed"):
            self.radar.analyze(self.result(bundle))
        state["batches"][bundle["batch_id"]]["bundle"]["analysis_policy"] = ANALYSIS_POLICY
        self.radar.save(state)
        self.radar.analyze(self.result(bundle))
        state = self.radar.load()
        state["batches"][bundle["batch_id"]]["bundle"].pop("analysis_policy")
        self.radar.save(state)
        with self.assertRaisesRegex(ValueError, "analysis_policy_changed"):
            self.radar.publish(bundle["batch_id"])
        self.assertEqual(self.gh.calls, 0)

    def test_bootstrap_repeat_revision_and_new_release(self):
        result = self.radar.collect(page())
        self.assertEqual([i["status"] for i in result["added"]], ["queued", "queued", "baseline"])
        self.assertEqual(self.radar.collect(page())["added"], [])
        self.assertEqual(len(self.radar.collect(page(extra="revision"))["added"]), 3)
        self.assertEqual(len(self.radar.collect(page(("1.3.0",)))["added"]), 1)
        state = read_json(self.root / "state/state.json")
        self.assertEqual(sum(i["status"] == "superseded" for i in state["items"].values()), 2)

    def test_failed_fetch_does_not_change_journal(self):
        self.radar.collect(page())
        before = (self.root / "state/state.json").read_bytes()
        with patch("release_radar.core.fetch", side_effect=TimeoutError), self.assertRaises(TimeoutError):
            self.radar.collect()
        self.assertEqual(before, (self.root / "state/state.json").read_bytes())

    def test_content_reversion_restores_only_current_pending_revision(self):
        self.radar.collect(page())
        self.radar.collect(page(extra="revision"))
        self.radar.collect(page())
        state = read_json(self.root / "state/state.json")
        queued = [i for i in state["items"].values() if i["status"] == "queued"]
        self.assertEqual(len(queued), 2)
        self.assertTrue(all("revision" not in i["release"]["text"] for i in queued))

    def test_source_revision_invalidates_unpublished_draft(self):
        batch = self.accepted()
        self.radar.collect(page(extra="revision"))
        with self.assertRaisesRegex(ValueError, "release_revised"):
            self.radar.publish(batch)
        self.radar.analyze(refresh=batch)
        bundle = self.radar.analyze()
        self.assertTrue(all("revision" in r["text"] for r in bundle["items"].values()))

    def test_batch_resume_cancel_and_collect_lockout(self):
        bundle = self.prepare()
        self.assertEqual(bundle, self.radar.analyze())
        with self.assertRaisesRegex(ValueError, "active_analysis"):
            self.radar.collect(page())
        self.radar.analyze(cancel=bundle["batch_id"])
        self.assertNotEqual(bundle["batch_id"], self.radar.analyze()["batch_id"])

    def test_invalid_results_are_atomic_and_retryable(self):
        bundle = self.prepare()
        valid = self.result(bundle)
        variants = []
        bad = copy.deepcopy(valid); bad["batch_id"] = "old"; variants.append(bad)
        bad = copy.deepcopy(valid); bad["decisions"].pop(); variants.append(bad)
        bad = copy.deepcopy(valid); bad["decisions"][0]["proposal"]["evidence"] = []; variants.append(bad)
        bad = copy.deepcopy(valid); bad["decisions"][0]["proposal"]["evidence"][0]["quote"] = "made up quote not in source"; variants.append(bad)
        bad = copy.deepcopy(valid); bad["decisions"][0]["proposal"]["evidence"][0]["path"] = "../secret"; variants.append(bad)
        before = (self.root / "state/state.json").read_bytes()
        for bad in variants:
            with self.assertRaises(ValueError):
                self.radar.analyze(bad)
            self.assertEqual(before, (self.root / "state/state.json").read_bytes())
        self.assertEqual(self.radar.analyze(valid)["candidates"], 1)
        with self.assertRaisesRegex(ValueError, "stale_or_unknown"):
            self.radar.analyze(valid)

    def test_stale_repository_and_expired_analysis(self):
        bundle = self.prepare()
        with patch("release_radar.core.time.time", return_value=bundle["created_at"] + 86401):
            with self.assertRaisesRegex(ValueError, "expired"):
                self.radar.analyze(self.result(bundle))
        (self.repo / "README.md").write_text("changed current feature")
        with self.assertRaisesRegex(ValueError, "repository_changed"):
            self.radar.analyze(self.result(bundle))

    def test_dry_run_default_and_double_opt_in(self):
        batch = self.accepted()
        before = (self.root / "state/state.json").read_bytes()
        output = self.radar.publish(batch)
        self.assertEqual(output["results"][0]["status"], "dry_run")
        self.assertIn("release-radar:v1:", output["results"][0]["body"])
        self.assertEqual(before, (self.root / "state/state.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "publication_disabled"):
            self.radar.publish(batch, execute=True)
        self.assertEqual(self.gh.calls, 0)

    def test_publish_idempotent_and_closed_issue_marker(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        self.radar.publish(batch, execute=True)
        self.gh.data[0]["state"] = "closed"
        self.radar.publish(batch, execute=True)
        self.assertEqual(self.gh.calls, 1)
        # A fresh journal still detects the marker on closed issues.
        self.config["state_root"] = str(self.root / "another-state")
        self.radar = Radar(self.config, self.gh)
        batch = self.accepted()
        self.assertEqual(self.radar.publish(batch)["results"][0]["status"], "duplicate")
        self.assertEqual(self.gh.calls, 1)

    def test_exact_title_duplicate_and_new_issue_forces_review(self):
        batch = self.accepted()
        self.gh.data = [{"number": 9, "title": "Add evidence-based review 0", "body": "", "state": "closed"}]
        self.assertEqual(self.radar.publish(batch)["results"][0]["status"], "duplicate")
        self.gh.data[0]["title"] = "Related new idea"
        with self.assertRaisesRegex(ValueError, "issues_changed"):
            self.radar.publish(batch)
        self.radar.analyze(refresh=batch)
        bundle = self.radar.analyze()
        self.assertEqual(bundle["issues"][0]["number"], 9)

    def test_unknown_create_reconciles_without_resend(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        self.gh.ambiguous = True
        with self.assertRaises(TimeoutError):
            self.radar.publish(batch, execute=True)
        state = self.radar.load()
        state["batches"][batch]["bundle"].pop("analysis_policy")
        self.radar.save(state)
        output = self.radar.publish(batch, execute=True)
        self.assertEqual(output["results"][0]["status"], "reconciled")
        self.assertEqual(self.gh.calls, 1)

    def test_unknown_absent_never_retries_or_refreshes(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        self.gh.ambiguous = self.gh.hidden = True
        with self.assertRaises(TimeoutError):
            self.radar.publish(batch, execute=True)
        for _ in range(2):
            self.assertEqual(self.radar.publish(batch, execute=True)["results"][0]["status"], "unknown")
        with self.assertRaisesRegex(ValueError, "reconcile_unknown"):
            self.radar.analyze(refresh=batch)
        self.assertEqual(self.gh.calls, 1)

    def test_per_batch_cap_and_backlog(self):
        self.config.update(max_issues=1, batch_size=1, publish_enabled=True)
        batch = self.accepted()
        self.radar.publish(batch, execute=True)
        self.radar.publish(batch, execute=True)
        self.assertEqual(self.gh.calls, 1)
        self.assertEqual(len(self.radar.analyze()["items"]), 1)

    def test_too_many_proposals_rejected_before_consuming_queue(self):
        self.config["max_issues"] = 1
        bundle = self.prepare()
        with self.assertRaisesRegex(ValueError, "too_many_proposals"):
            self.radar.analyze(self.result(bundle, 2))
        self.assertEqual(self.radar.status()["queued"], 2)

    def test_two_successful_creates_respect_snapshot_and_durable_attempts(self):
        batch = self.accepted(2)
        self.config["publish_enabled"] = True
        self.radar.publish(batch, execute=True)
        self.radar.publish(batch, execute=True)
        self.assertEqual(self.gh.calls, 2)
        state = read_json(self.root / "state/state.json")
        self.assertEqual(state["batches"][batch]["attempts"], 2)

    def test_crash_after_create_before_receipt_save(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        original = self.radar.save
        def save(state):
            if self.gh.calls:
                raise OSError("simulated crash after POST")
            original(state)
        with patch.object(self.radar, "save", side_effect=save), self.assertRaises(OSError):
            self.radar.publish(batch, execute=True)
        restored = Radar(self.config, self.gh)
        self.assertEqual(restored.publish(batch, execute=True)["results"][0]["status"], "reconciled")
        self.assertEqual(self.gh.calls, 1)

    def test_prior_unknown_blocks_new_batch_same_feature(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        self.gh.hidden = self.gh.ambiguous = True
        with self.assertRaises(TimeoutError):
            self.radar.publish(batch, execute=True)
        self.radar.collect(page(extra="revision"))
        bundle = self.radar.analyze()
        self.radar.analyze(self.result(bundle))
        with self.assertRaisesRegex(ValueError, "prior_publication_or_unknown"):
            self.radar.publish(bundle["batch_id"], execute=True)
        self.assertEqual(self.gh.calls, 1)

    def test_issue_read_failure_prevents_publication(self):
        batch = self.accepted()
        self.config["publish_enabled"] = True
        with patch.object(self.gh, "issues", side_effect=TimeoutError), self.assertRaises(TimeoutError):
            self.radar.publish(batch, execute=True)
        self.assertEqual(self.gh.calls, 0)
        self.assertEqual(self.radar.status()["batches"][0]["candidates"], ["ready"])

    def test_changed_evidence_and_untracked_evidence_rejected(self):
        bundle = self.prepare()
        result = self.result(bundle)
        (self.repo / "untracked.txt").write_text("supports local-only manual reviews")
        result["decisions"][0]["proposal"]["evidence"][0]["path"] = "untracked.txt"
        with self.assertRaises(subprocess.CalledProcessError):
            self.radar.analyze(result)
        self.radar.analyze(self.result(bundle))
        (self.repo / "README.md").write_text("New repository behavior")
        with self.assertRaisesRegex(ValueError, "repository_changed"):
            self.radar.publish(bundle["batch_id"])

    def test_cross_process_lock_and_missing_journal_fail_closed(self):
        with locked(self.root / "state"):
            code = 'from release_radar.storage import locked; import sys\nwith locked(sys.argv[1]): pass'
            result = subprocess.run([sys.executable, "-B", "-c", code, str(self.root / "state")],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("radar_busy", result.stderr)
        (self.root / "state/bundle-existing.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "missing_state_with_artifacts"):
            self.radar.collect(page())

    def test_nonfinite_json_rejected(self):
        config_file = self.root / "config.json"
        config_file.write_text('{"schema":NaN}')
        with self.assertRaisesRegex(ValueError, "nonfinite_json"):
            read_json(config_file)

    def test_zero_proposals_and_duplicate_decision(self):
        self.gh.data = [{"number": 7, "title": "Existing", "body": "", "state": "closed"}]
        bundle = self.prepare()
        result = self.result(bundle, 0)
        result["decisions"][0].update(decision="duplicate", issue_number=7)
        self.assertEqual(self.radar.analyze(result)["candidates"], 0)
        self.assertEqual(self.radar.publish(bundle["batch_id"])["results"], [])

    def test_lock_contention_and_release(self):
        with locked(self.root / "state"):
            with self.assertRaisesRegex(ValueError, "radar_busy"):
                self.radar.collect(page())
        self.radar.collect(page())

    def test_state_binding_and_unsafe_directory(self):
        self.radar.collect(page())
        self.radar.binding["repo"] = "other/repo"
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            self.radar.collect(page())
        os.chmod(self.root / "state", 0o755)
        with self.assertRaisesRegex(ValueError, "0700"):
            self.radar.collect(page())

    def test_config_and_json_validation(self):
        config_file = self.root / "config.json"
        atomic_json(config_file, self.config)
        self.assertEqual(load_config(config_file), self.config)
        self.config["state_root"] = str(self.repo / "private")
        atomic_json(config_file, self.config)
        with self.assertRaisesRegex(ValueError, "outside_repo"):
            load_config(config_file)
        config_file.write_text('{"schema":1,"schema":2}')
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            read_json(config_file)


class GitHubTests(unittest.TestCase):
    def test_pagination_includes_closed_excludes_prs(self):
        data = [{"number": n, "title": "issue", "body": "", "state": "closed",
                 "html_url": "https://example.invalid", "updated_at": "today"} for n in range(100)]
        data[0]["pull_request"] = {}
        with patch("release_radar.core.command", side_effect=[json.dumps(data), "[]"]) as run:
            self.assertEqual(len(GitHub("example/project").issues()), 99)
            self.assertIn("page=2", run.call_args.args[0][-1])

    def test_pagination_error_or_truncation_fails_closed(self):
        with patch("release_radar.core.command", return_value='{"error":"denied"}'):
            with self.assertRaisesRegex(ValueError, "invalid_issue_page"):
                GitHub("example/project").issues()
        page_data = [{"number": n, "pull_request": {}} for n in range(100)]
        with patch("release_radar.core.command", return_value=json.dumps(page_data)):
            with self.assertRaisesRegex(ValueError, "unstable_issue_pagination"):
                GitHub("example/project").issues()


if __name__ == "__main__":
    unittest.main()
