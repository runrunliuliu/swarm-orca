# Migration status

Imported on: 2026-11-04

## Incremental Swarm sync — 2026-11-04

- Updated bootstrap RPCs to share a bounded transport deadline; timeout requires reconciliation, not mutation retry.
- Added an unapproved trigger-review template and early input validation without changing the independent Operator approval boundary.
- Preserved usage for settled failed Workers while rejecting inconsistent outcomes and capture-time scope changes.
- Added a selective evidence archive helper and tests. Its output remains private: preview redaction is not secret scanning, lifecycle settlement, or permission to publish.
- Kept existing public configuration/path adaptations and excluded private execution reports and accounting documents. No private Git history was imported.
- This is a source-only update; it does not deploy a runtime, launch Agents, or establish live acceptance.

Validation for this sync (from `swarm/`, with `RSI_CHECKER_TEST_ROOT` unset):

- `PYTHONPATH=.:tests python3 -B -m unittest test_evidence_archive test_worker_usage_preserve test_startup_handoff test_coordinator_tui_prepare test_operator_startup test_bootstrap_production test_bootstrap_transport -v`: 161 tests passed.
- `PYTHONPATH=.:tests python3 -B -m unittest test_coordinator_driver test_progress_watch test_supervisor -q`: 262 tests passed.
- Gitleaks 8.24.2 current-tree scan passed with the unchanged repository configuration. This does not replace review of excluded or allowlisted content.
- These are targeted offline regressions, not the full Swarm/Orca matrix or live acceptance. No production identity checks were relaxed.

## Initial import record (historical)

The following records the original migration and its validation, not a fresh validation of every later change:

- `orca/` was copied from the private workspace's tracked source snapshot.
- `swarm/` was copied from the tracked files in the private `swarm` submodule.
- The original private source directory and `swarm/` submodule were not removed or modified by this migration step.
- Obvious private Swarm history/validation documents were removed from the public copy.
- Obvious hard-coded private paths in the public Swarm copy were replaced with explicit configuration or examples.
- Orca provenance files were added under `orca/UPSTREAM.md` and `orca/upstream.json`.
- Orca upstream baseline was fixed to annotated tag `v1.4.219` with tag object `482a2438d5d5b76d538b903c8bb8fa81ed48c540` and dereferenced source commit `e705cac04a1db7e7e2184746e912142d34ca838b`.
- Repository notices were added in `NOTICE.md`, including Orca's MIT license file location and the bundled ripgrep notice bundle under `orca/resources/licenses/ripgrep/`.
- A migration sanity scan for obvious private strings was run against `orca/` and `swarm/`; the only remaining match was the public Orca Linear integration filename `linear-workspaces.json`.
- `orca/mobile/google-services.json` was converted to a placeholder Firebase configuration after a high-confidence credential fallback scan found a real Google/Firebase API key in the imported source snapshot.
- Orca cloud project identifiers from the imported snapshot, including production/staging project names, the associated numeric project id, service-account domains, bucket names, and artifact repository prefixes, were replaced with `*-example` placeholders across cloud docs, scripts, tests, and Terraform examples.
- A release-grade `gitleaks` 8.24.2 scan was run with the checked-in `.gitleaks.toml` allowlist for documented deterministic fixtures and generated audit outputs. Both git-history and current-directory scans completed with `no leaks found`.
  - Git-history report: `/tmp/swarm-orca-gitleaks-git-after-allowlist.json`
  - Current-directory report: `/tmp/swarm-orca-gitleaks-dir-after-allowlist.json`
- A build/artifact sanity scan did not find tracked `node_modules`, `dist`, `coverage`, caches, logs, key/certificate files, or database files. The checked-in `orca/resources/build` path is packaging resources rather than generated build output.

Validation run in this workspace:

- Targeted Swarm regression tests for the publicized CLI/config behavior passed.
- Clean checkout validation was run from a fresh local clone at submodule commit `fa9e183e` in `/tmp/swarm-orca-clean.VYE3pv/repo`:
  - `gitleaks git . --config .gitleaks.toml --redact` completed with `no leaks found` (`/tmp/swarm-orca-clean-gitleaks-git.json`).
  - `gitleaks dir . --config .gitleaks.toml --redact` completed with `no leaks found` (`/tmp/swarm-orca-clean-gitleaks-dir.json`).
  - `python3 -B -m unittest tests.test_coordinator_driver tests.test_progress_watch tests.test_supervisor -v` passed `262` tests from `swarm/`.
  - `NOTICE.md`, `.gitleaks.toml`, and the exact upstream commit in `orca/upstream.json` were present in the clean checkout.
- Full Swarm unittest discovery ran `2165` tests with `18` skipped and `85` errors in this container. The observed errors are from the current execution environment's `/proc` PID namespace mismatch: `os.getpid()` differs from `/proc/self/stat`, which intentionally trips Swarm's host process identity checks (`bootstrap_host_proc_view_mismatch`) plus one `/proc/2/stat` lookup failure. The production identity checks were not weakened for this migration snapshot.

Not yet complete:

- Complete final human review of `.gitleaks.toml` allowlist entries before public release; the automated scan is clean, but allowlisted fixtures/resources remain intentional repository content.
- Confirm the final repository-level open-source license for Swarm code that does not carry an explicit upstream license header.
- Review all licenses, third-party notices, icons, fonts, and bundled resources for the exact public release artifact set.
- Decide which CI workflows should be added at repository root. The copied `orca/.github` tree was excluded from this migration snapshot to avoid publishing unreviewed production release/deploy workflows.
- Run full Orca build/tests and full Swarm offline tests from a clean checkout without private parent-directory dependencies, including a CI environment with coherent `/proc` process identity for Swarm bootstrap tests. The targeted clean-checkout regression above is complete, but is not a substitute for the full matrix.
- Update private callers to consume this submodule layout before deleting old source locations.

