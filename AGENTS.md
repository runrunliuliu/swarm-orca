# AGENTS.md — swarm-orca

Guidance for agents working in this repository. The parent workspace has its own `AGENTS.md`;
this file only adds rules specific to `swarm-orca` and does not relax anything there.

## Two layers, two contracts

| Path | Origin | How to treat it |
| --- | --- | --- |
| `orca/` | Reviewed snapshot of upstream `v1.4.219` (see `orca/upstream.json`, `orca/UPSTREAM.md`) | Upstream code and its own `orca/AGENTS.md`. Change it only for a narrow, tested fix; do not reformat, rename, or restyle it, and do not carry private configuration into it. |
| `swarm/` | This project's orchestration code, docs, skills | Normal development area. Python here is standard-library only. |

When a change spans both layers, keep the upstream diff minimal and put the reasoning in the
commit message: it has to survive the next upstream upgrade.

## Public-repository boundary

This repository is public-safe. Do not add:

- organization-specific configuration, host names, profiles, or credentials;
- real Run / Task / Dispatch / terminal IDs, session excerpts, or archived evidence;
- deployment paths or service state from a private host;
- build output (`orca/out/`, `orca/dist/`), `node_modules/`, or dependency caches.

Private policy, live configuration, and historical results stay in the private workspace.

## Tests

Python (from `swarm-orca/swarm`):

```bash
env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
  PYTHONPATH=.:tests python3 -B -m unittest discover -s tests -q
```

`env -u SWARM_WORKER_PROFILES` is deliberate: a private profile file changes the pinned
`worker-model-profiles.json` hash and makes unrelated suites fail with `file_pin_changed`.

Node/vitest (`orca/`), when a prepared dependency tree is available:

```bash
cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <paths>
```

- Never install dependencies into `orca/` as a side effect of a code change; reuse a prepared tree
  or report the gap.
- New tests live next to the source they pin, and must fail against the old behavior. A test that
  never failed does not prove anything.
- Report "tests added" and "tests executed" separately, and name what did not run.

## Git

- **Never commit on a detached `HEAD`.** Create a branch first; a commit on a detached head is
  reachable only until the worktree disappears.
- Bump a submodule pointer only after its branch is pushed. A parent pointer to an unpushed commit
  is a broken delivery.
- Do not rewrite a branch that another worktree, Run, or deployment pins.
- Use the full `id:<repoId>::<path>` worktree selector. `path:` is ambiguous when two registrations
  share one directory.

Delivery steps after development — integration, deployment, verification, cleanup — are in
`swarm/skills/worktree-delivery/SKILL.md`. Read that file in full before acting when the task is
“merge it”, “ship it”, “deploy/restart”, “clean up the worktree”, or “the work is done”.
Deployment and service restarts are separately authorized actions, not part of "merge".

The parent workspace's `AGENTS.md` points here explicitly, because a nested `AGENTS.md` is not
loaded automatically for an agent whose working directory is the parent repository. Keep that
pointer intact when editing either file.

## Skills

- `orca/skills/<name>/SKILL.md` belongs to upstream. Do not add project skills there.
- Project skills live in `swarm/skills/<name>/SKILL.md` with `name` and `description` frontmatter.
  The description states when to use the skill and what it is not for.

## Claims

State what was verified, with the command and its answer. Do not present a helper succeeding, a
file existing, or an offline test passing as a live acceptance result. If a step was skipped,
blocked, or unknown, say so instead of dropping it.
