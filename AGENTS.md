# AGENTS.md — swarm-orca

Guidance for agents working in this repository; all paths below are repository-relative.
This checkout is self-contained. If embedded in another workspace, also follow its applicable
instructions and explicit deployment policy; no particular private parent repository is required.

## Two layers, two contracts

| Path | Origin | How to treat it |
| --- | --- | --- |
| `orca/` | Reviewed snapshot of upstream `v1.4.219` (see `orca/upstream.json`, `orca/UPSTREAM.md`) | Upstream code and its own `orca/AGENTS.md`. Change it only for a narrow, tested fix; do not reformat, rename, or restyle it, and do not carry private configuration into it. |
| `swarm/` | This project's orchestration code, docs, skills | Normal development area. Python here is standard-library only. |

When a change spans both layers, keep the upstream diff minimal and put the reasoning in the
commit message: it has to survive the next upstream upgrade.

## Directory and artifact landing

- A dispatch states two absolute paths: the **working directory** (briefs, in-flight evidence,
  notes) and the **archive directory** (what must outlive the task). A brief that names only one
  is incomplete: do not infer the other, and never treat the working directory as the archive.
- A local disk is not durable storage. A working directory on the host's own filesystem dies with
  that host or container. Before claiming delivery, copy the report and its evidence into the
  archive, write an index (host, account, source working directory, resolved archive path,
  hosting filesystem, per-file SHA256) and read the copies back to compare hashes.
- Resolve paths instead of assuming them: `readlink -f` for the symlink chain, and
  `findmnt -T <path>` or `stat -L -c %d` for the filesystem that actually holds the bytes. `df`
  and `stat -f %T` follow symlinks, so they misreport a linked path in both directions.
- Concrete landing paths, host names and archive layout come from the deployment or private
  policy for that task, not from this file (see
  [public-repository boundary](#public-repository-boundary)). This section states the rule, not
  the address.
- A retry reuses the archive directory already registered for that Run or Task; do not open a new
  one, and do not overwrite a different attempt.

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
tests/run_offline.sh                          # full suite: the integration/delivery gate
tests/run_offline.sh --fast                   # full suite minus the four wall-time dominators
tests/run_offline.sh -p "test_coordinator_*"  # one area
tests/run_offline.sh --list                   # what a mode would run, without running
tests/run_offline.sh -v                       # equivalent to the full form below
```

Run the narrowest command that covers the change while iterating; run the **full** suite
once before integration or delivery. Say which mode produced a result: `--fast` output is
iteration feedback, and only `--full` may be reported as "offline PASS". The full suite is
about eight minutes of real owner-socket RPC, `fsync` and subprocess signature work — do not
re-run it after every edit, and do not shorten it by deleting the heavy modules, which are
the bootstrap/strict production-path evidence (see
[testing strategy](swarm/docs/testing/strategy.md#5-跑法与门禁地图) for the gate levels).

The script clears both private-input variables and is equivalent to:

```bash
env -u SWARM_WORKER_PROFILES -u RSI_CHECKER_TEST_ROOT \
  PYTHONPATH=.:tests python3 -B -m unittest discover -s tests
```

`env -u SWARM_WORKER_PROFILES` is deliberate: a private profile file changes the pinned
`worker-model-profiles.json` hash and makes unrelated suites fail with `file_pin_changed`.

The suite is grouped into `tests/bootstrap/`, `tests/coordinator/`, `tests/operators/`,
`tests/trae/`, `tests/worker/` and `tests/core/` (everything without a matching prefix). Each
area is a package, so a module's unittest name is `area.test_name` and `run_offline.sh --list`
prints exactly the names discovery reports; `tests/core/test_offline_baseline.py` fails if the
two ever diverge. Single-module runs therefore look like
`PYTHONPATH=.:tests python3 -B -m unittest operators.test_operator_monitor -v`, and a pattern
such as `-p "test_coordinator_*"` still matches basenames across areas.
`RSI_CHECKER_TEST_ROOT` decides whether the 18 explicitly gated real-RSI cases run or skip;
neither variable should be set by hand for a baseline run.

Node/vitest (`orca/`), when a prepared dependency tree is available:

```bash
cd orca && node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts <paths>
```

- Run vitest in small batches: a few directories/files per command, always `--maxWorkers=2`, and
  keep each batch around ≤250 test files. Never launch the whole suite from one command; see
  [orca test runs](swarm/docs/testing/orca-test-runs.md).
- Never install dependencies into `orca/` as a side effect of a code change; reuse a prepared tree
  or report the gap.
- Put regression tests next to the source they cover. Where practical, demonstrate a bug test
  against the old baseline in an isolated fixture/checkout; never revert an active shared checkout
  or invalidate a running source pin just to obtain a red test.
- Put the file in the area directory matching its source prefix, keeping the basename equal to the
  module under test: `tests/<area>/test_<module>.py`. Shared helpers (`offline_env.py`,
  `*_fixture.py`, `fixtures/`) stay at the `tests/` top level because `tests` is on
  `PYTHONPATH`; an area name must therefore not collide with an importable top-level module
  (that is why the Operator area is `operators/`, not `operator/`).
- Report "tests added" and "tests executed" separately, and name what did not run.

## Git

- Detached HEAD is normal for pinned submodules. Before new commits, establish an approved
  branch or durable reference; do not rewrite a shared/pinned branch.
- Before publishing a parent gitlink, verify its submodule commit is available on the intended
  remote. Remote availability does not necessarily require merging into the default branch.
- Do not rewrite a branch that another worktree, Run, or deployment pins.
- Use the full `id:<repoId>::<path>` worktree selector. `path:` is ambiguous when two registrations
  share one directory.

Delivery steps after development — integration, deployment, verification, cleanup — are in
`swarm/skills/worktree-delivery/SKILL.md`. Read that file in full before acting when the task is
“merge it”, “ship it”, “deploy/restart”, “clean up the worktree”, or “the work is done”.
Deployment and service restarts are separately authorized actions, not part of "merge".

Embedding workspaces should explicitly route relevant tasks here. Agent harnesses differ in how
nested instructions are loaded; do not rely on automatic recursive discovery.

## Task workspace design

When planning task/workspace routing or cross-project development, read
[the task-centric workspace design](swarm/docs/design/task-workspaces.md). A logical task may bind
multiple repository worktrees and continue from different Projects or terminals; entry points are
not task identities. This is a target design, not an implemented automatic gate or permission to
migrate existing Runs. Current task authorization, isolation policy and delivery requirements still apply.

### Isolating modification work (hard rule)

Every primary checkout of this repository is read-only for modification work. Decide by intent, not
by where the agent happened to be launched:

- Read-only review, diagnosis and Q&A need no new worktree. Anything that will produce a git change
  (source, scripts, config, or content docs) is modification work and belongs in a dedicated Orca
  worktree created from a confirmed baseline.
- Cwd is not authorization. A task instruction such as "fix it" or "apply option A" authorizes the
  change, not the location: it is neither permission to edit a primary checkout nor permission to
  create a worktree. When the location is not already authorized, stop and ask for the worktree
  (repo id, base ref, name) instead of silently taking the cheaper branch.
- Detect the case mechanically: a primary checkout has `git rev-parse --git-dir` equal to
  `--git-common-dir`; linked worktrees differ. Apply it to submodules and nested repositories too —
  when cwd is a primary checkout and the target files live in one of its submodules, it is still
  modification work in a primary checkout.
- Do not stack new edits on a primary checkout that is already dirty. Name the dirty files first.
- Before delivery run `git -C <repo> status --porcelain` for every repository touched. A primary
  checkout carrying this task's changes is a process violation to report, never a detail to omit.

Before deciding *whether* a task should use the task sparse workspace mode, use that document's
"When to use task mode" checklist: it is an explicit operator decision (only `orca worktree create
--sparse-task-dir` triggers it today), and using it for a small repo or a one-line fix buys friction
rather than safety.

For the strict bootstrap path, the known gaps (exit-classification, progression ownership, gate
proportionality) and the draft repair plan live in
[strict bootstrap liveness](swarm/docs/design/strict-bootstrap-liveness.md); it is a draft and
authorizes nothing.

For the Orca-side view of a task (workspaces, agents, spend), read
[the Tasks workbench design](swarm/docs/design/task-workbench/README.md) and its
[development plan](swarm/docs/design/task-workbench/development-plan.md). The relationship storage
split (derived vs provenance vs a new `taskRecords` domain) and the "unknown never recorded as 0"
usage rule live there. Both are drafts: no schema, RPC or UI is implemented, and the plan authorizes
nothing.

## Choosing what to read first

Pick the execution entry before the skill: [entry paths](swarm/docs/entry-paths.md) starts from task
identity and workspace isolation, then covers when not to convene several agents, which of the three
mutually exclusive execution paths a task belongs to, and how a domain adapter attaches. It is a
routing index, not a mode enumeration and not a grant of authority.

## Skills

Discover skills through the table below and read the applicable `SKILL.md` completely before acting.
No global installation is required. Paths/references resolve from the skill's directory. These are
repository reading entry points, not a claim that every harness automatically lists them.

| Task | Required entry |
| --- | --- |
| Orca worktrees, terminals, repositories or handoff | `orca skills get orca-cli` |
| Native messages, tasks, Dispatches and lifecycle | `orca skills get orchestration` |
| Supervised Swarm preparation, Coordinator loop, recovery and accounting | [swarm-orchestration](swarm/skills/swarm-orchestration/SKILL.md) |
| Strict software-development-v1 scope, progress and evidence | [software-development](swarm/skills/software-development/SKILL.md) |
| Review, merge, optional deployment and safe worktree cleanup | [worktree-delivery](swarm/skills/worktree-delivery/SKILL.md) |

The two Orca guides are printed by the selected executable itself (`orca skills get <name>`),
version-matched to it; this checkout does not vendor an `orca/skills/` directory, so a missing
file path there is not evidence that a guide is unavailable.

The first two entries load version-matched guides from the selected executable; they do not duplicate
its command reference. Project skills live under `swarm/skills/`, not the upstream skill directory.
For all entries, access denial or connection failure means stop affected operations and report the
error: no automatic escalation, runtime switching or restart. This overrides automatic recovery
suggestions in upstream stubs without rewriting the snapshot.

Before live Swarm work read [configuration](swarm/configuration.md); for validation read
[reliability](swarm/docs/testing/reliability.md). Deployment supplies exact target identities, approved
models/limits, artifact locations and domain skills. Missing inputs are not permission to use public
examples or a different runtime. Do not copy private policies here; existing pinned Runs are not migrated.

## Claims

State what was verified, with the command and its answer. Do not present a helper succeeding, a
file existing, or an offline test passing as a live acceptance result. If a step was skipped,
blocked, or unknown, say so instead of dropping it.
