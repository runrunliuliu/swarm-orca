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


## 1. Resolve the control plane, discover the runtime and choose an execution path

Before choosing anything, resolve the control plane from one explicit entry only: `SWARM_CONTROL_PLANE`
when the task sets it, otherwise the machine pointer `/opt/swarm/current`. Never search parent
directories, and never substitute a source checkout that happens to be nearby: a missing pointer is a
reported gap, not a licence to guess which code and configuration are current.

If the pointer is missing or unusable, name the fix instead of improvising one: a host gets its control
plane from `swarm/deploy/install.sh` in a checkout of this repository (see `swarm/deploy/README.md`).
Show the read-only command first, and never run it with `--apply` unless the user asked for a
deployment — publishing, switching the pointer and relinking skills are deploy actions, not setup.

Run the read-only readiness check for the target project and keep its output as evidence:

```bash
python3 -B <control-plane>/code/control_plane_readiness.py --project <target-project>
# from a source checkout: python3 -B <source>/swarm-orca/swarm/control_plane_readiness.py --project <target-project>
```

The relative form works in both layouts: `../../control_plane_readiness.py` from this file.

`ready: yes` is a fact about inputs, not authorization: it starts no Run, and `max_workers` stays
unconfirmed until the user states a positive integer. Every `blocked:` line is an explicit blocker —
stop and report it instead of choosing another path, config or checkout. A `dev-checkout` control
plane, or a published one whose source was dirty or unpinned, is usable for local trials only and is
never a pin source; keep `--require-pin` in force for anything that will be resumed or audited.

This check does not replace reading the deployment policy in §2, and it does not make the missing
host override layer exist: private paths, adapters and `max_workers` still come from the task.

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

#### Waiting for another pane: one turn boundary, and only with turn evidence

The mailbox rule above is unchanged. A peer pane's *turn* is a different channel and has its own
single-call form, not a `sleep` and a screen read:

```bash
# Save the submission receipt: this is the only proof that a turn started.
orca terminal send --terminal <peer> --text "…" --enter --wait-submit 30 --json > send.json
# Then wait once. Re-enter only after a 124.
python3 swarm/wait_pane.py --terminal <peer> --turn-evidence send.json --idle-timeout 300
```

- One call, `--idle-timeout` at most 300 s (same policy as the mailbox window). Exit 0 means the
  turn *this receipt started* reached its boundary — it is **not** "the work is done": verify the
  products before acting. A wake is not a receipt.
- `tui-idle` alone is never a completion signal: the pane is idle *before* it starts working. The
  wait requires the `turn_started` stage of the same submission, bound to the same terminal
  process incarnation. Without it `wait_pane.py` exits 4 `unverifiable` and does not fall back to
  watching the screen; providers that answer `provider: "unsupported"` never produce
  `turn_started`, so that handoff needs another channel or a human.
- Exit 5 `interaction_required` means a trust/approval/update prompt is waiting: that is a human
  decision, not a longer window.
- Reading a peer's screen stays a diagnostic act, never a verdict: no `terminal read` loop, no
  `sleep`, no "looks done". Racy observations are exactly what the receipt replaces.

#### Waiting for a file to be published: inotify, with the deadline in charge

```bash
python3 swarm/wait_for_file.py --path <published.json> --timeout-ms 300000 --json
python3 swarm/wait_for_file.py --path <log.jsonl> --mode change --timeout-ms 120000
```

An event may only shorten this wait; the deadline decides. Exit 0 = the path appeared, or
`st_mtime_ns`+`st_size` moved; 124 = timeout; 4 = the parent is not reachable, answered
immediately and never retried into a timeout; 2 = usage or transport. After 0, re-read the bytes
with `file_ref` and the schema: a non-atomic writer is visible here before it is complete, and
`--mode change` cannot see a rewrite that keeps both size and timestamp.

Stage files (`events/000N-*.json`) do **not** use the generic file form: the path comes from the
attempt bundle through the fixed entry, never from a hand-assembled relative path, a directory scan
or a glob.

```bash
python3 swarm/coordinator_launch.py strict-bootstrap-wait-stage \
  --bootstrap <BOOTSTRAP> --expect-attempt <attempt-id> \
  --attempt-binding-sha256 <64 hex> --stage 2 --timeout-ms 300000 --json
```

Exit 0 validated, 124 timeout, 4 attempt/binding unreachable, 5 the path is there but the chain does
not validate (no re-read), 2 usage or a pin mismatch. At 0 it prints the evidence Ref it read: carry
that exact `{path, sha256}` forward, do not compute your own, and do not skip it because
`already_satisfied` is true — 0 is neither confirmation nor permission to advance.
A `sleep` micro-loop (`for`/`while` plus `sleep`, whatever the single duration) is a forbidden
waiting form too: the `N >= 60` rule only ever covered one call, and a loop of 8 s sleeps still
reads "slow" as "dead".

### Handoff delivery: the mailbox by default, steering is not the fast path

This is the one part of a strict attempt that actually failed: pins and bytes were correct, the text
went in through `terminal send --enter`, and the receiver was sitting inside `check --wait`.

1. **The default and only regular channel is the mailbox**: `orca orchestration send --type handoff`,
   received with `check --wait`. Delivery is durable and independent of where the receiver is; a live
   wait wakes immediately, an absent one keeps the message for the next check.
2. **`terminal send --enter` (steering) has exactly two uses left**: the native launch turn's short
   prompt (fixed by the launch contract, part of the plan hash) and a human interaction
   (`interaction_required`). It is **not** a premise for a handoff: steering is only committed after
   the current tool call returns, so it cannot interrupt a running `check --wait`.
3. **Do not use `turn_started` as a handoff receipt.** Measured here: both pi and trae answer
   `terminal send --wait-submit` with only `input_accepted` and `provider: "unsupported"`. When a
   provider reports unsupported the only options are the mailbox or a human.
4. **A mis-send is not repaired by re-sending.** Only a **same-handoff copy** is allowed:
   `handoff_id`, `payload_sha256`, `refs` and `subject` byte-identical to the original (normally the
   same payload moved onto the mailbox), plus one turn-boundary wait. Never mint a new `handoff_id`
   or new text. The receiver de-duplicates by that identity; the same id with different bytes (or a
   different sending pane) is a conflict, not "take the newer one".
5. The receiver checks what the protocol calls the handoff envelope: **the pin assertion and the
   sender assertion are two independent assertions**, and the sender one is a consistency check that
   stops a mis-fill or an accident — it does not stop impersonation and must never be called
   authentication or a security boundary.

Implementation and acceptance state: [handoff channel design](../../docs/design/strict-handoff-channel.md)
— offline regression only, **no live acceptance**.

These are the only two additions. `--for output-change` is not an option in this repo (PTY output
is token-level noise, not a decision point), and none of the three channels covers a human
decision, an external job, a gate or a local process exit. Design, invariants and what each
channel does *not* prove: [pane handoff wait](../../docs/design/pane-handoff-wait.md).

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
