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

### Reconcile ambiguous lifecycle results

A transport result is not always the operation result. In particular, a slow filesystem or initialized
submodules can let create/remove continue after the CLI reports `runtime_unavailable`, or can leave an
initializing worktree locked. Do not immediately replay the mutation, restart the runtime, or infer
success/failure from that transport error.

- Preserve the error and timestamps, then use bounded, read-only checks against the same runtime and
  exact ID. Reconcile runtime identity, native `worktree list`/`show`, terminal inventory, the canonical
  path, `git worktree list`, local/remote refs, status, and host processes whose cwd is under the path.
- An empty terminal list does not prove every PTY or Agent exited after
  `terminal_stop_unverifiable`. Do not delete until process ownership and exit are proven. Any direct
  host process intervention requires explicit authorization; prefer graceful termination and never
  describe a missing terminal surface as a stopped process.
- A create that timed out may still own a live `git worktree add` and show `locked initializing`.
  Do not launch a duplicate create, unlock it, or remove underneath the creator. Wait boundedly; if
  the creator remains live or is blocked in uninterruptible I/O, preserve it and report the blocker.
- A list omitting the target does not prove its catalog record is gone. After removal, query the exact
  ID: if the filesystem and Git worktree/ref cleanup are complete but exact `worktree show` still
  returns stale metadata, repeat the same supported native removal without force only after the prior
  operation has settled. Require an affirmative removal receipt, then `selector_not_found` for the
  exact ID. Never edit the runtime catalog directly.
- Verify deletion separately in all relevant planes: native catalog/display, terminals/processes,
  filesystem and Git worktree metadata, local branch, and any authorized remote branch. Refresh the
  native list after the exact-ID check so the user-facing view observes the new catalog generation.

### Verify the client-facing projection after removal

Native removal notifies clients; a removal performed outside Orca — for example an explicitly
authorized `git worktree remove` after the native entry refused — emits no such event. Verify the
projection, not just Git:

- The filesystem, `git worktree list`, the local branch, the exact-ID lookup and the repo-scoped
  listing must all be clean, as above.
- Then check what a client would render. A row left in runtime metadata does not by itself create a
  workspace: the list is built from the Git listing and metadata only overlays it. It re-projects
  only when that listing fails, so a leftover row is inert, not an active workspace.
- A user-facing list that still shows the workspace after the checks above is a stale client view.
  Trigger one supported catalog refresh for that repository (a metadata write such as `worktree set`
  with its existing value notifies clients), then re-check the same view.
- Do not edit the runtime database, reset the profile, or restart the runtime to clear a cache. If
  the entry survives a refresh and a client reopen, report it as an unresolved projection defect
  with the exact IDs rather than working around it.

## 6. Report distinct outcomes

Report reviewed and integrated commits, target branch/remote, push status, post-integration tests,
deployed version (if any), live checks, rollback reference, cleanup performed — including whether the
client-facing projection was verified or is still stale — resources retained and coverage gaps. If blocked, name the last proven step and next owner. Do not call “committed” merged,
“deployed” accepted, or an absent terminal exited.
