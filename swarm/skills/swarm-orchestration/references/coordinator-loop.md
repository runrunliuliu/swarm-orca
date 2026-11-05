# Coordinator loop across phases

Applies only to tasks that authorize an independent Coordinator to pursue a goal. A one-shot task
remains one-shot. This contract grants no operations, budget, concurrency or write access; domain
role restrictions still apply.

## Ownership and phases

- Operator: authorized workspace preparation, startup/recovery gates, external evidence and audit;
  never a second business planner or substitute Worker dispatcher.
- Coordinator: decomposition, dispatch, evidence review, decisions and all remaining paths.
- Driver: mechanical same-session continuation, dependency wakeup and deduplication; never execute
  checkpoint text as commands, choose business actions or consume the Coordinator inbox in its place.
- Observer: read-only evidence and alerts; no resume, dispatch, consumption or automatic recovery.

A specific external operation may be delegated to one Operator with a pinned action and inputs.
Claim and return refer to that action; its result goes back to the Coordinator. This does not
transfer business ownership. Missing Worker-start receipts require reconciliation, not Operator dispatch.

Keep phases separate:

1. Bootstrap establishes identity and gates; a bootstrap receipt is not goal completion. Do not
   dispatch Workers or external work before the appropriate gates and business handoff.
2. Recovery reconciles existing attempts, unknown submissions and owner/generation first. Preserve
   counters and evidence; never copy identity or invent adoption.
3. Run performs work, collects evidence and publishes progress checkpoints. Normal stage completion
   does not require another Operator business prompt.
4. Closeout verifies acceptance, settles resources and accounts for usage/archive. `continue` is
   not closeout; `wait` retains a real wakeup condition. Safety-stopped executors retain their last
   business decision instead of being relabeled complete.

## Required checkpoint semantics

Use the target domain's actual schema/checker from the first business turn. Bind objective,
authorization, original acceptance, session, input action and executed evidence. Record:

- every acceptance criterion, satisfied evidence and remaining gaps without weakening criteria;
- all remaining paths as actionable/waiting/blocked, with alternatives reviewed;
- exact decision, next-action owner, path, deliverables and validation;
- real dependency IDs, observed state and wakeup conditions;
- actual work receipts, no-progress counters and resource/budget observations (unknown is not zero).

| Decision | Required condition and action |
| --- | --- |
| `continue` | Authorized actionable work remains: execute/dispatch or use a supported driver for a concrete next action. A plan alone is not progress. |
| `wait` | No independent ready path; a real running dependency and bounded observation/wakeup responsibility exist. No model wakeup just because nothing changed. |
| `blocked` | No actionable/waiting path; evidence establishes a boundary, alternatives and the external decision needed. |
| `complete` | Every original criterion has adequate evidence; proceed to independent audit and closeout. |

Do not infer machine decisions from prose. A missing output or undesigned task is not a running
dependency. Claim limitations do not automatically block independent source verification or analysis.
Reviewers check all remaining paths and waiting responsibilities, not just conclusion wording.
Do not create equivalent tasks/checkpoints to avoid a no-progress stop. Persist stop counters across
restart. Local denial stops affected operations, not unrelated authorized paths; uncertain identity
stops writes by that executor. Model/PTY exit, Worker success and a checker pass do not prove acceptance.

## Implementations and compatibility

[coordinator_loop.py](../../../coordinator_loop.py) checks shared structural transitions, not domain
authorization or evidence truth. Read [driver](../../../coordinator-driver.md) for supported providers,
same-PTY/session restrictions and strict exclusions, and [TUI](../../../coordinator-tui.md) for its
separate path. There is no universal provider scheduler.

Use the actual domain checker, source-reviewed authority, native identity/exit evidence, real
dependencies and persistent settlement in addition to shared structure. Trae exec plans pin the
phase fragment, original brief and combined stdin; do not bypass them with a bare brief redirect.
Codex phase delivery and continuation support must be checked independently. Single-turn resume
is not a goal loop. Reject bad checkpoints and unknown launches rather than silently replaying.

Template changes can invalidate fixed plans. Preserve old plans and receipts; use reviewed recovery
instead of rewriting history. Fixed-DAG constraints remain fixed. Documentation and offline tests do
not deploy services, migrate Runs or establish unattended operation.
