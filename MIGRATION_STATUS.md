# Migration status

Imported on: 2026-11-04

Current state:

- `orca/` was copied from the private workspace's tracked `source-v1.4.219/` files.
- `swarm/` was copied from the tracked files in the private `swarm` submodule.
- The original private `source-v1.4.219/` directory and `swarm/` submodule were not removed or modified by this migration step.
- Obvious private Swarm history/validation documents were removed from the public copy.
- Obvious hard-coded private paths in the public Swarm copy were replaced with explicit configuration or examples.
- Orca provenance files were added under `orca/UPSTREAM.md` and `orca/upstream.json`.
- A migration sanity scan for obvious private strings was run against `orca/` and `swarm/`; the only remaining match was the public Orca Linear integration filename `linear-workspaces.json`.
- `orca/mobile/google-services.json` was converted to a placeholder Firebase configuration after a high-confidence credential fallback scan found a real Google/Firebase API key in the imported source snapshot.
- Orca cloud project identifiers from the imported snapshot, including production/staging project names, the associated numeric project id, service-account domains, bucket names, and artifact repository prefixes, were replaced with `*-example` placeholders across cloud docs, scripts, tests, and Terraform examples.
- `gitleaks` and `trufflehog` were not available in the migration workspace. A regex fallback scan was run for high-confidence token/key patterns; remaining hits are redaction/test fixtures and the explicit localhost-only static test certificate in `orca/src/main/browser/browser-local-https-test-certificate.ts`, which still require final human review before release.
- A build/artifact sanity scan did not find tracked `node_modules`, `dist`, `coverage`, caches, logs, key/certificate files, or database files. The checked-in `orca/resources/build` path is packaging resources rather than generated build output.

Validation run in this workspace:

- Targeted Swarm regression tests for the publicized CLI/config behavior passed.
- Full Swarm unittest discovery ran `2165` tests with `18` skipped and `85` errors in this container. The observed errors are from the current execution environment's `/proc` PID namespace mismatch: `os.getpid()` differs from `/proc/self/stat`, which intentionally trips Swarm's host process identity checks (`bootstrap_host_proc_view_mismatch`) plus one `/proc/2/stat` lookup failure. The production identity checks were not weakened for this migration snapshot.

Not yet complete:

- Verify the exact upstream Orca tag/commit for version `1.4.219`.
- Complete a full secret scan over the publishable Git object graph before pushing; the fallback regex scan above is not a release-grade scanner result.
- Review all licenses, third-party notices, icons, fonts, and bundled resources.
- Decide which CI workflows should be added at repository root. The copied `orca/.github` tree was excluded from this migration snapshot to avoid publishing unreviewed production release/deploy workflows.
- Run Orca build/tests and Swarm offline tests from a clean checkout without private parent-directory dependencies, including a CI environment with coherent `/proc` process identity for Swarm bootstrap tests.
- Update private callers to consume this submodule layout before deleting old source locations.

