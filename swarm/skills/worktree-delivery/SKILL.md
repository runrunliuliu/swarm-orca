---
name: worktree-delivery
description: >-
  Verify and deliver completed Orca worktree changes: independent review, integration into a
  confirmed target branch, optional authorized deployment, and safe cleanup. Use for merge,
  delivery or worktree-cleanup requests; not for starting new work or automatic service operations.
---

# Worktree delivery

Read this skill in full for delivery tasks. Paths are relative to this file. A commit, integration,
push, deployment and deletion are separate outcomes and permissions. Do not infer permission for
all of them from “work is done”. Read [Orca CLI discovery](../../../orca/skills/orca-cli/SKILL.md)
and the selected executable's version-matched guide before Orca state operations.
On access denial or connection failure, stop affected operations; do not automatically escalate,
switch runtimes or restart despite upstream discovery suggestions.

## 1. Establish the target and scope

Verify repository, execution host, full native worktree ID, canonical path, branch, HEAD, status,
submodule pointers and untracked files. Confirm the intended integration branch and method from
the repository/task policy; “main branch” does not necessarily mean a branch named `main`.

- Detached HEAD is normal for pinned submodules. Before creating new commits, establish an approved
  branch or durable reference; do not imply existing detached commits immediately disappear.
- A changed submodule checkout is not automatically an error. Review the exact gitlink delta and
  ensure referenced objects are available on the intended remote before publishing the parent.
- Preserve unrelated changes and evidence. Do not automatically stash, reset, clean or delete.
- Follow task workspace-isolation policy; use explicit Orca IDs, not active/current targets.

## 2. Verify the change

Run relevant deterministic tests and adjacent suites; report commands, results and skipped coverage.
For bug fixes, demonstrate the regression against the old baseline where practical in an isolated
fixture/checkout. Do not temporarily revert a live shared checkout or invalidate a running source pin.
Tests need not all fail on the old version to be useful.

Inspect actual dependencies and documented test environments before assuming packages are missing.
Do not download, install or replace dependency links silently. Reuse only verified compatible inputs.
Obtain independent review of the actual change and fix findings before integration.

## 3. Integrate with one writer

Use the repository's approved PR/MR, merge, fast-forward or squash workflow. Verify both source and
target revisions and worktree ownership before writing. Do not switch to a branch checked out in
another worktree. Rebase is not a default: never rewrite shared or pinned history without permission.
Resolve conflicts explicitly, then run tests on the integrated result rather than relying only on
branch tests. Publish only to the authorized remote/branch.

For submodules, verify the submodule commit is remotely available before pushing its parent pointer.
Landing on the submodule default branch is required only when the repository's delivery policy says
so; remote availability and merge completion are different checks.

## 4. Deploy only if authorized

Read the target deployment runbook. Inventory live terminals, Workers, pending operations and jobs;
resolve unsafe/unknown activity before restart. Build with the supported reproducible build process
and lockfile versions, preserving all required artifacts and integrity metadata.

Stage a new validated artifact, keep the previous artifact and configuration, and record a rollback
procedure. Run preflight/smoke checks before switching the service. Do not replace only one bundled
file when the deployment contract requires a coherent artifact set.

After an authorized restart, verify native readiness, actual artifact identity, the original behavior
and an unchanged adjacent case. A down service is a diagnostic checkpoint, not automatic permission
to force-start it. Follow the runbook's recovery and rollback gates. Mirror private deployment-script
changes in the private source, never in public examples.

## 5. Cleanup is explicit and last

Before deleting a worktree or branch, verify:

- the authorized integration/publication is complete (for squash, use the accepted review and
  integrated diff/tests rather than only ancestry);
- no uncommitted/untracked work, private evidence or unpushed commits would be lost;
- no live or unresolved Agent/Worker/job, pending request, worktree child or deployment depends on it;
- evidence and usage have been preserved and remaining resources have owners;
- deletion is within the user's scope.

Use the selected runtime's supported worktree removal procedure with the exact ID, without default
`--force`. Never remove a main checkout. Use safe branch deletion only after verifying it is no longer
needed or checked out. On refusal preserve and report; do not switch to raw Git removal, `-D`, force,
or lock deletion to bypass native safety. Keep rollback artifacts according to retention policy.
Worker settlement/release and strict retirement remain Coordinator-owned under the native protocol;
worktree deletion is not a substitute.

## 6. Report distinct outcomes

Report reviewed and integrated commits, target branch/remote, push status, post-integration tests,
deployed version (if any), live checks, rollback reference, cleanup performed, resources retained and
coverage gaps. If blocked, name the last proven step and next owner. Do not call “committed” merged,
“deployed” accepted, or an absent terminal exited.
