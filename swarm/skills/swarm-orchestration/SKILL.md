---
name: swarm-orchestration
description: >-
  Prepare and coordinate supervised Orca Swarms: explicit deployment inputs, independent
  Coordinator startup, bounded Worker concurrency, checkpoints, recovery, evidence and closeout.
  Also owns the read-only eligibility judgement for asking several agents to debate or review a
  decision before any Run exists. Use for supervised multi-agent work, or when asked to discuss,
  debate, cross-review or get an independent second opinion; not for ordinary single-agent editing,
  unsupervised handoffs, or questions one check would settle.
---

# Swarm orchestration

This skill has two purposes. Read the entry in full either way; only purpose 2 pulls in the rest.

1. **Read-only eligibility judgement** — decide whether a question deserves several agents at all,
   and return the verdict plus missing inputs. This creates no Run, starts no Agent, and does not
   require a worktree or `max_workers`. The exemption covers execution-preparation requirements
   only: user limits, applicable workspace rules, read-only boundaries and existing permission
   constraints still apply. Protocol: [discussion](references/discussion.md).
2. **Supervised execution preparation** — everything else in this file and every existing startup,
   identity, concurrency and lifecycle requirement applies.

Reading this skill is not launch authorization. Paths below are relative to this file. This
repository supplies generic control protocols; the task supplies deployment policy and
domain-specific role skills. Neither this skill nor a successful helper grants execution authority.
Neither a debate verdict nor a discussion outcome authorizes writing, merging, deploying or
starting a Run; those keep their own authorization and gates.

Read the applicable shared references in full (they are not optional substitutes for the linked
implementation protocols):

| Before | Shared reference |
| --- | --- |
| Judging whether to convene several agents, or running such a discussion | [Discussion](references/discussion.md) |
| Planning, handoff, recovery or ending a business turn | [Coordinator loop](references/coordinator-loop.md) |
| Selecting or handing off domain roles | [Repository skills](references/repository-skills.md) |
| Preparing, refreshing or reusing preflight evidence | [Preflight evidence](references/preflight-evidence.md) |
| Session binding or usage collection | [Session binding](references/session-binding.md) |
| Continuation or external-operation handoff | [Continuation](references/continuation.md) |


## 1. Discover the runtime and choose a supported execution path

Load the selected executable's version-matched guides with `orca skills get orca-cli` and
`orca skills get orchestration`; use `--help` for uncovered commands. Do not invent flags. Resolve the
executable against the explicit task target and verified existing ownership before using environment
defaults. This checkout does not vendor an `orca/skills/` directory: a missing `SKILL.md` path there
is not a failed skill read, and searching the filesystem for it is not a substitute for the guide.

Access denial or connection failure stops affected operations: preserve the error, do not change
runtime, escalate permissions, restart or weaken controls automatically. This safety boundary takes
precedence over automatic escalation/restart suggestions in bundled upstream discovery stubs.

Use [the execution-path guide](../../README.md) to distinguish strict TUI + monitor,
non-strict exec driver, and fixed-DAG Supervisor. Do not substitute one for another to bypass a gate.
Unsupported provider/version/identity or recovery capabilities are explicit blockers.

## 2. Fix inputs before launch

Read [configuration](../../configuration.md) and obtain task-approved, explicit inputs:

- objective, acceptance criteria, target runtime/repository/worktree/host and source baseline;
- write ownership, permitted operations, budgets, deadline and bounded failure recovery policy;
- a positive `max_workers`: maximum concurrent Workers excluding the Coordinator, including
  reviewers, integrators and nested/remote Workers; it is not a cumulative-start limit;
- Coordinator model/runtime configuration and applicable Worker profiles, with reviewed paths/hashes;
- evidence/archive and ledger directories, and a supported usage/session-binding method;
- target repository instructions and domain role skills, including hidden skill directories.

Record unknown authorization separately from denial. Examples are not deployment defaults or
permission. Inherit applicable restrictions when retrying; changing Run or directory cannot reset
budgets or unresolved operations. Do not assume an outer shell's configuration reaches new Agents.

## 3. Prepare workspace and independent roles

For independent modification tasks, prepare a dedicated Orca worktree from a confirmed baseline
unless the task explicitly selects an existing workspace. Continuations retain the original workspace;
read-only tasks may share it. Verify full returned IDs and canonical paths, not names or cwd alone.
Never stash, reset or overwrite unrelated changes. Follow the selected CLI for worktree operations.

Read [Operator preparation](../../operator-prepare.md),
[strict startup](../../coordinator-strict-start.md) and
[the two-stage startup gate](../../coordinator-startup.md). Use their supported helpers and pinned
references, not an ad hoc launch sequence. Verify an independent real Coordinator session before
it creates the Run; before first dispatch verify owner/generation, then have that Coordinator
recheck in its own context. Reading a role skill is not proof of identity or actual handoff.

Operator owns authorized preparation/recovery and evidence delivery. Coordinator owns decomposition,
dispatch and adoption of results. Workers act only on their native Dispatch. Do not borrow handles,
copy identity variables or direct Workers from an outer Operator terminal.

## 4. Execute and checkpoint

Recommend parallel work with distinct ownership, dependencies, planned peak and estimated cumulative
starts. The Coordinator decides actual waves and eligible models within the approved cap/policy.
Use [Worker planning](../../coordinator-worker-plan.md); verify requested/effective settings.
Reserve slots for live, starting and unresolved Workers; absence of output is not exit.
Implementation requires independent review, single-writer integration and post-merge tests.

At checkpoints record each original acceptance criterion, evidence and all remaining paths:
`actionable`, `waiting` or `blocked`. Keep decisions distinct:

- `continue`: perform or hand off a concrete in-scope next action;
- `wait`: no independent ready work and a real dependency with a bounded observation/wakeup path;
- `blocked`: evidence of a boundary, alternatives considered and a named next owner;
- `complete`: every acceptance criterion has sufficient evidence, ready for independent closeout review.

Use the domain's actual schema/checker; generic text does not substitute for it. Do not relabel
unfinished work as complete because a model turn or Worker ended. Bootstrap, recovery, business
execution and closeout are separate phases. Long external jobs have separate capacity/accounting.

### Waiting: one blocking call, never a blind sleep

A session that waits for another agent has exactly one allowed form:

```bash
orca orchestration check --wait --types "worker_done,escalation,question" \
  --timeout-ms 300000 --json 2> >(grep -v _keepalive >&2)
```

`sleep N` with `N >= 60`, repeated polling of `inbox`/`worker-list` to "see if something happened",
and re-reading a file in a loop are not waiting strategies; they are the absence of one. They
cannot be interrupted, they wake the model to do nothing, and after a long sleep the model has to
re-derive what it was waiting for, which is where wrong actions come from.

Two of these are CLI semantics (`--help`, `orca skills get orchestration`, and the check handler
source); the 300 s window is a **repository policy**, not a CLI limit — the CLI accepts larger
values, and this repo chooses not to use them so an interrupt stays distinguishable from a hang.

1. **A wake is not a filtered message.** `check --wait` returns the whole FIFO Delivery; `--types`
   decides what wakes the call, not what comes back. Dispatch by the type in each returned row, and
   re-check the settled state before acting: a wake, an empty batch or a timeout never authorizes
   `worker-start`, `worker-release`, `worker-abandon` or a retry.
2. **stderr carries a `_keepalive` line every 15 s.** It is liveness of the CLI, not a message and
   not evidence about the Worker. Do not parse it, and do not treat its presence as progress.
3. **One call is bounded at 300 s (policy).** When it returns, re-enter another bounded call
   rather than asking for a single 900 s window; a long window makes an interrupt
   indistinguishable from a hang. `--timeout-ms` itself has no documented maximum, so this is a
   choice this repository makes and the number lives here on purpose.

`swarm/wait_for_events.py` implements exactly this contract (keepalive filtered, timeout as its own
exit status, nothing else printed into the message stream) when a shell pipeline is awkward.

For TUI continuation read [the TUI contract](../../coordinator-tui.md),
[lifecycle](../../operator-startup.md) and [monitor](../../operator-monitor.md).
A non-Agent sender is not the Operator Agent. Preserve fixed execution mode and native-event
isolation; a diagnostic response is neither readiness nor durable confirmation.

## 5. Recovery, accounting and delivery

For uncertainty, load the selected runtime's recovery guide. Reconcile the original request and
exact objects; no blind resend, consumer takeover, lock deletion or new key to escape an unknown
result. Caller timeout is not cancellation. Generation changes alone do not fence old writers.
Existing Run/source/config pins are not silently upgraded. Stop when supported recovery is unavailable.

Collect trajectory and usage at launch, dispatch, settlement and closeout, including failed/replaced
attempts. Bind sessions by supported evidence, not cwd or newest-log guesses. Capture usage before
release where required. Unknown is not zero; raw and normalized counters remain distinct.

Verify business outputs independently, then settle/ACK/release through the real Coordinator and
native lifecycle. Retirement does not prove acceptance or stop external jobs. Archive reviewed,
sanitized evidence and verify the manifest by reading it back; do not commit private evidence here.
Report peak vs cap, cumulative attempts, elapsed time, per-role usage, gaps and remaining resources.

For repository integration and cleanup read
[worktree delivery](../worktree-delivery/SKILL.md). For test design or live acceptance read
[reliability](../../docs/testing/reliability.md). Deterministic tests, native integration and real
Agent acceptance are distinct; running a diagnostic Swarm is not a native-event PASS.
