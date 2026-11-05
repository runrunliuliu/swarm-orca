---
name: worktree-delivery
description: >-
  Deliver an Orca worktree back to its main branch and clean it up: verify the worktree and its
  submodule/deployment state, run and record tests, merge or hand off to the main branch, sync the
  deployed copies (start scripts, pins), deploy and restart with a rollback point, then retire the
  worktree and branch. Use when the user says the work is done and wants it merged, released,
  deployed, or the worktree cleaned up; also when a worktree was built on a detached HEAD, or a
  deployment was done by hand. Not for starting new work or for ordinary read-only review.
---

# Worktree delivery

Development in a worktree ends with an integration decision, not with a commit. This skill covers
the last mile: **verify → test → integrate → deploy (if asked) → verify live → retire the
worktree**. Every step leaves a rollback point; nothing is deleted before its replacement is proven.

Deployment and merging are separate authorities. Landing a fix does not authorize a restart of a
running service; ask before any lifecycle action that interrupts live sessions.

## 1. Inspect before touching anything

```bash
git -C <worktree> status --short --branch      # detached HEAD? uncommitted? submodule dirty?
git -C <worktree> log --oneline -3
git -C <worktree> rev-parse HEAD
git -C <worktree> submodule status             # pointer vs checkout mismatch
```

Stop and report when any of these hold:

| Finding | Why it stops delivery |
| --- | --- |
| `HEAD detached` | A commit here is unreachable once the worktree is removed. Create a branch **before** committing. |
| Submodule shows a different commit than its own worktree HEAD | The parent pointer would publish a commit that does not exist on the submodule's branch. |
| Untracked files that look like evidence or scratch output | They are not part of the change; decide keep/ignore/delete explicitly. |
| A dirty submodule you did not touch | Not yours to commit; report it instead of sweeping it in. |

Record the baseline commit of every repository you will modify. That value is the rollback target.

## 2. Test at the layer the change lives in

- Deterministic tests first; they must fail before the fix and pass after. A test that never failed
  proves nothing — revert the source change once, watch it fail, restore it.
- Run the neighbouring suites for the files you touched, not only the new test.
- Report what did **not** run (missing dependencies, skipped integration, live prerequisites).
  "Tests added" and "tests executed" are different claims.
- Do not install dependencies into a checkout silently. If a prepared environment already exists,
  say which one you reused.

## 3. Integrate deliberately

```bash
git -C <worktree> fetch origin
git -C <worktree> rebase origin/<main>        # prefer rebase for a short branch
git -C <worktree> checkout <main> && git -C <worktree> merge --ff-only <branch>
```

- Merge only after review; an implementation author does not approve their own change.
- If the repository uses submodules, land the submodule branch **first**, then bump the pointer in
  the parent. A parent pointer to an unpushed submodule commit is a broken delivery.
- Keep the branch until the parent pointer commit is pushed and verified.
- Never rewrite a branch that another worktree, Run, or deployment pins.

## 4. Deploy only with an explicit decision

Deployment is a separate, authorized step. Before it:

1. Build with the repository's own build script, never by hand-assembling the artifact. Partial
   bundles fail readiness checks (missing version file, missing preflight payloads) and look like
   runtime bugs.
2. Keep build-time dependency versions equal to the lockfile pin; a newer minor version can be
   rejected by an integrity check at build time.
3. Deploy into a **new directory**; leave the previous one untouched as the rollback target.
4. Update the start script, and keep a timestamped backup of it.
5. Restart, then verify with read-only commands. If the service reports `down`, use the runner's
   start command once (`sv up`), not repeated restarts.
6. Mirror any start-script change into the repository copy so the next operator sees reality.

Record: artifact version, deployment directory, previous directory, script backup, verification
output, and the exact rollback command.

## 5. Verify from the outside

- Service health (ready/connected), not just "process exists".
- The specific behavior the change claims: reproduce the original symptom's command and show the
  new answer.
- An adjacent case that must not change, to prove the fix is not a blanket behavior change.
- Degradations that existed before the deploy and still exist after (do not silently inherit them
  as "passing").

## 6. Retire the worktree

```bash
orca worktree set --worktree id:<repoId>::<path> --comment "delivered in <commit>"
orca worktree rm --worktree id:<repoId>::<path> --force
git -C <main> branch -d <branch>          # -d, not -D: keep only merged work
```

- Use the **full** `id:<repoId>::<path>` selector. `path:` is ambiguous when two registrations
  share one directory, and the answer can depend on registration order.
- Remove the worktree only after its work is reachable from the main branch and pushed.
- Delete the branch only when merged; keep unmerged branches and report them.
- Keep the previous deployment directory and the script backups; they are the rollback, not clutter.
- If terminals or agents were running, re-check them after any restart: terminal records survive a
  restart, but a live agent may not.

## 7. Report

State, separately and without merging them:

- what was merged (commits, target branch, whether pushed)
- what was deployed (artifact version, directory, restart time, rollback point)
- what was verified live, with the exact commands and their answers
- what was left behind on purpose (old artifact, backups, retained branch)
- what is still unknown (unrun suites, unverified terminals, usage not collected)

An interrupted delivery is reported as `blocked` with the last proven step; it is never described as
complete because a later step was attempted.
