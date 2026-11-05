# Continuation and external-operation handoff

Read [the Coordinator loop](coordinator-loop.md) and [repository roles](repository-skills.md).
Coordinator retains business decisions and dispatch throughout the task. Operator handles only
startup/recovery/audit or a precise delegated operation. A receipt is not an autonomous executor.

| Situation | Supported protocol to read |
| --- | --- |
| Normal completed turn with work remaining | [Driver](../../../coordinator-driver.md) for supported non-strict same-PTY/session execution; [TUI](../../../coordinator-tui.md) for strict TUI continuation. Do not interchange them. |
| `next_action.owner=outer-operator` | Driver's pinned claim/return protocol; original Coordinator reviews the returned result. |
| Authorized automatic external action | [Operator executor](../../../coordinator-operator.md): reviewed routes/adapters, fixed config, original budget. Never execute checkpoint text. |
| Read-only follow of driver turns | [Progress watch](../../../progress-watch.md): exact `driver_binding`, pending/current records, no newest-log guesses or resume. |
| Long external job with independent work | Reviewed background-completion path; exact submission receipt first, then independent authorized work on inputs isolated from the running job. |
| Interrupted submission/settlement | Query the original operation key; only verified complete settlements may be reconciled. Unknown launches, changed identities or unsupported adoption stop that executor. |

Requirements:

- Read the actual domain role skill and required references before claiming skill-read confirmation.
  Hashes, declarations and claims are not user authorization or evidence of execution.
- Pin config/request/claim/report references. Use existing state and claim/return helpers, not a new
  inbox consumer or shell executor. One operation has one assigned executor.
- Missing Worker-start receipts go back to the real Coordinator for reconciliation; Operator does
  not dispatch on its behalf. Preserve the original ownership and restrictions.
- Reuse original requests/results. Unknown submission stops replay persistently. A known submitted
  job with unknown subsequent status retains responsibility/capacity; its query stop need not block
  independent authorized work. Never change action IDs, erase journal or restart to resubmit.
- Submitted means queued/running, not complete. Freeze job inputs; observe dependencies separately
  from model turns. Unchanged status does not justify model wakeups; new facts must be reviewed and
  settled by the original Coordinator at a safe turn boundary. No concurrent resume.
- `probe/query` are read-only; execute requires durable intent first. Incomplete budget/capacity,
  real denial or exhausted recovery stops affected execution. Local locks or adapter declarations
  do not prove platform admission or global budget enforcement.

Use explicit, verified domain/platform adapters; missing implementation is a coverage gap, not
permission to invent a replacement. New helpers do not deploy services, relax STOP, change fixed
execution mode, migrate pinned Runs or authorize external jobs.
