# Strict Coordinator control plane (experimental)

`strict-v1` is an opt-in runtime guard for **new Runs**, implementing the control path
`Operator → business Coordinator → Runtime → Workers`. It is not enabled by default,
does not convert existing Runs, and is not production-ready.

**There is no safe rebind, adoption, or crashed-Coordinator recovery in this version.**
The original live Coordinator can retire a reconciled Run through the bounded protocol
below; settlement alone does not unpin it or release historical Worker protection.
`run-use` is refused, and strict history still disables `orchestration reset` for the
entire database. Test only in an isolated, disposable runtime profile; do not enable
this on a shared operational profile. Removing database rows/triggers or downgrading
the server is not a supported recovery procedure.

The workspace skill policy defaults **new supervised Swarms with a separate business
Coordinator** to requiring strict. This is a launch requirement, not a runtime-wide
default: unsupported enforcement/recovery stops that path instead of falling back to
ordinary creation. Ordinary tasks and existing Runs are unchanged. The shared-profile
activation gate remains closed until safe recovery and live host acceptance exist.

This source change alone does not deploy a server, launch an Agent, migrate a Run, or
change any training Job. Follow the repository's authorization and launch procedures
before using a built runtime.

## Roles and parallel work

| Role | Allowed path in a strict Run | Refused path |
| --- | --- | --- |
| Operator | Send goals/evidence to the Coordinator's `run:<id>` mailbox; inspect explicit Run/Task/inbox state | Direct Worker instructions, Task/Dispatch/gate mutations, or claiming to be the Coordinator via `--from` |
| Pinned Coordinator | Create Tasks, start/dispatch Workers, send typed instructions, answer questions, control Worker lifecycle | Raw Worker terminal input, silent rebind, or taking another Run's Workers |
| Worker | Read its own mailbox; ask/report/reply to its owning Coordinator | Nested control planes, another Worker's mailbox, or direct messages to other Workers/Runs |
| Runtime | Validate native identity, retain receipts, deliver through existing orchestration paths | Treat missing output, timeout, or missing receipt as permission for Operator takeover |

The Coordinator remains the business decision-maker in research, implementation,
training, evaluation, and publication. Operator can actively ask it to reassess ready
work; it need not wait passively for a training Job to finish. Exact platform-operation
delegation is a separate business receipt, not transfer of Worker control.

The guard adds **no global serial scheduler**. Independent Dispatches can coexist:

```text
Operator → Coordinator
               ├─ training path: submitted Job, waiting for evidence
               ├─ research Worker: independent literature/ablation work
               └─ reviewer: check frozen artifacts
```

Keep training inputs frozen; isolate research writes. The Coordinator still enforces
dependencies, file ownership, `max_workers`, budgets, and independent review through the
existing workflow. Worker capacity and external Job capacity are separate limits. This
guard neither supplies those limits nor implements a training-platform scheduler.

## Activation and readback

Before expensive bootstrap work, the **live native Coordinator itself** can run:

```text
orca orchestration strict-caller-check --json
```

This distinct read-only RPC (`orchestration.strictCallerCheck`, capability
`orchestration.strict-caller-check.v1`) uses the same native proof verifier as creation.
It returns a public caller identity/fingerprint and observation time, never the launch
token or its hash, and neither creates nor binds a Run. Pinning this result allows the
workflow to compare the bootstrap process with the process consuming the Operator gate;
the result is not a credential or lease. Creation always rechecks live authority.
An old server refuses the unknown method; never fall back to ordinary creation.

Use Orca's native `terminal create --agent trae --agent-args ...` launch path, not a raw
shell invoking a capture wrapper. Keep that Agent process alive while it waits for the
Operator startup gate and creates the Run from its own tool context. Agent exit retires
launch authority even if the shell/PTY survives. Resuming the same provider UUID from
that shell cannot restore it. The probe does not enable safe recovery or open the
shared-profile activation gate described above.

The Coordinator must execute creation in its own verified native terminal context,
using the CLI belonging to the target runtime. After launch authorization and the
separate Coordinator startup gate have passed, the new command is:

```text
orca orchestration run-create --strict-coordinator --objective "<authorized objective>" --json
orca orchestration run-show --id <returned-run-id> --json
```

Both receipts expose `coordinatorPolicy: "strict-v1"`. An ordinary Run has no such
policy; absence is not proof of enforcement. `--from` names a caller but does not prove
its identity. The runtime validates the native launch token and pins terminal handle,
pane, process incarnation, launch-token hash, and execution-host scope. Subsequent
control operations must match that pin and the Run's owner/consumer generation.

The flag calls a distinct RPC method, `orchestration.runCreateStrict`. An old server
refuses the unknown method instead of dropping a new optional flag and creating an
unguarded Run. Do not retry without the flag. Existing ordinary Run creation is unchanged.
Use one current runtime process as the database writer; the immutable-policy presence
cache is initialized at database open and updated after strict creation commits.

Only native terminal Coordinators and same-runtime terminal Workers are supported.
Structured-session and federated Worker placement are refused. Same-runtime SSH/WSL
terminals require proof from their execution host; loss of contact is `unverifiable`,
never evidence of `exited`. Do not substitute a local identity for a remote one.

## What is checked

- Unary and streaming RPC entrypoints check strict ownership before compatibility
  recovery, durable replay, and handler invocation. Merely supplying a Run, gate,
  Task, Dispatch, terminal, or mailbox identifier cannot confer authority.
- Direct and group messages validate their resolved recipients before inserting mail
  or waking Workers. A mixed group is refused in full if any recipient is unauthorized.
  Replay keeps its stored recipient metadata and validates it again before re-notifying.
- `terminal.send` and binary-stream input refuse protected Worker input, including
  input from the Coordinator. Use typed `orchestration send/reply/dispatch` instead.
  A before-write callback catches a terminal becoming protected while input was pending.
- Worker start/dispatch revalidate identity after asynchronous discovery/readiness and
  at placement/delivery boundaries. A request already having effects may return a failed
  attempt with residual resources; a refusal is **not** proof that nothing happened.
- A waiting Worker mailbox check validates caller identity again before delivery; a
  changed process cannot keep consuming the old attempt's inbox.
- Run policy and history are immutable in storage. Binding changes are limited to the
  receipted one-way retirement fence. Starting and settled Worker identities remain
  protected until retirement because settlement does not prove process exit.

`strict_coordinator_required` means stop the refused path and drive the pinned
Coordinator or inspect evidence. Do not retry as another role, reuse an old handle, or
create a competing Run. Operator monitoring should use explicit `run-show`, `task-list`,
and `inbox`; `check` is caller-bound and may consume/acknowledge mail, so even its peek
form is not an identity-free Operator monitoring API.

If the Coordinator identity changes or becomes unverifiable, stop affected writes,
retain receipts, and report the need for recovery. This experimental version cannot
complete ownership transfer/adoption after identity loss; it deliberately does not guess an
automatic takeover. Receipt absence alone never authorizes a new executor.

## Original-live-Coordinator retirement

The original pinned native identity may call:

```text
orca orchestration run-retire-strict --run <run-id> --generation <observed-generation> --decision <reconciliation-reference> --json
orca orchestration run-show --id <run-id> --json
```

Retirement is not cancellation. The Coordinator first reconciles business acceptance,
external Jobs and artifacts, settles Tasks/Dispatches/gates, and resolves uncertain
resource operations. The runtime requires exact process incarnation and execution-host
scope for every historical Dispatch/resource and a host verdict of `exited` for each.
Missing identity, even on a failed-before-start attempt, blocks this conservative path;
do not fabricate identity or delete the attempt. `live` and `unverifiable` both refuse.
No process is stopped by retirement; external Job state is not checked or fenced.

No other orchestration mutation or mailbox check may be in flight, including a waiting
check. During inspection, a short runtime-wide gate refuses new writes/checks, including
requests without durable IDs and message replay. Normal dispatches remain parallel
outside retirement. Unknown pending durable receipts conservatively block retirement
across the database because their Run scope is not reliably recorded. Resolve them
through supported recovery, never deletion. Read-only Run/Task/inbox inspection remains
available. The gate does not pause arbitrary renderer, shell or external API operations.

After async host probes, the runtime revalidates caller identity and the full inventory.
One transaction stores an immutable retirement receipt, unbinds the owner, advances
consumer generation, and fences mailbox deliveries. `run-show.strictRetirement` exposes
the receipt, including `externalJobsVerified: false`. Only the original identity may
replay retirement; a repeated retirement reads the same final receipt without further
effects. This does not restore a dead Coordinator or permit a new one to adopt its Run.

The original Coordinator can then create a new Run. Retired Run control and historical
Dispatch addresses remain fenced; released bare Worker panes can host new work. Old
message retries cannot wake those panes. Newly recorded replay metadata carries its
Run scope so later work is not mistaken for the retired attempt; old unscoped receipts
remain conservative. Run, Task, Dispatch, mutation and retirement records are retained.
Strict history continues to prohibit database reset.

## Offline administrator history archival

The Linux independent-Server maintenance entry
`config/scripts/orchestration-history-maintenance.ts` supports explicitly authorized
history erasure without pretending an unknown Worker exited or adopting its authority.
It is not an RPC, an Agent recovery path, or a general `reset --force` option. Ordinary
strict reset and policy-update refusals remain unchanged.

The administrator must capture fresh native status, terminal and Worker inventories,
stop the exact runit service, verify that the application PID from that status is absent,
inventory every historical Dispatch, and explicitly acknowledge
each `unverifiable` verdict. Only settled, local history is supported. A state-pinned,
integrity-checked, durable SQLite backup precedes the transactional deletion. Immutable
audit receipts and Run/Task/Dispatch/terminal/pane/session identity fences survive the
cleanup and later ordinary resets; mutation receipts also survive. Old messages,
including group replay and binary terminal input, cannot resume a quarantined identity.

This operation deletes history, not processes, workspaces, artifacts, external Jobs,
provider conversations, or monitor persistent-stop files. Retained/user-owned resource
records are archived, not released. Root maintenance must be coordinated against other
administrators; the service must remain down throughout inspection and apply. The
entry uses a root-only concurrent-maintenance lock and checks the service state and
that exact PID with signal 0 before backup and transaction commit. It never scans
`/proc` or unrelated processes; only `ESRCH` proves PID absence, while permission errors
or PID reuse block maintenance. Its receipt explicitly records that cleanup
does not prove process exit.

Do not downgrade to a build unaware of the fences after applying cleanup. Keep both
the pre-open database backup and the final content-pinned backup. Restoring a profile
requires a separate offline reconciliation; never restore it over new live work.
See the host operation guide at `remote-server/history-maintenance.md` in the parent
workspace for preparation and command ordering.

## Boundaries and remaining work

This is same-OS-user role discipline, **not a security sandbox against a hostile user**.
It does not universally gate renderer/internal terminal input, terminal close/stop,
filesystem writes, arbitrary shell processes, or direct external service APIs. It does
not establish the Operator and Coordinator as independently authorized human roles;
the separate startup gate must verify that distinction. It cannot prove that
`fin-verl-rsi-coordinator` was loaded or followed, or validate business adoption receipts,
external Job authority, training exclusivity, OS permissions, or user budget sources.

The placement checks are at the calls to terminal/worktree creation, not a distributed
transaction spanning every host-side setup action. A changed identity cannot justify
discarding an attempt's partial effects or reissuing a submission. Server downgrade with
a strict database is unsupported: immutable-binding triggers alone do not teach old
code to enforce messaging rules.

Not every in-flight lifecycle effect is revalidated after every asynchronous wait.
For example, Worker stop checks authority at RPC entry, not at each later host-side
cleanup step. Do not treat these checks as an atomic authorization boundary.

Before production/default rollout, implement auditable fenced rebind/adoption and
crash recovery, precise platform-operation delegation, the remaining input/control paths,
and real runtime/host acceptance tests. Do not describe local tests as a deployed or
end-to-end training fix.

## Local regression coverage

`src/main/runtime/rpc/strict-coordinator*.test.ts` exercise both unary and streaming
RPCs: native-proof refusal, Operator→Coordinator mail, parallel Dispatches, direct and
group bypass, replay, Worker reports/questions, late protection, incarnation/token/host
changes, placement revalidation, and complete terminal `worker-start` handling with
mocked host operations. `strict-coordinator-schema.test.ts` covers migration, restart,
immutable binding, and rollback. Retirement tests additionally cover original identity,
host exit verdicts, quiescence, inventory races, durable replay and released-pane reuse;
schema tests cover v43 upgrade and immutable retirement after restart. These are offline
tests, not live Agent execution.

Validation on 2026-10-22 used `ORCA_BACKGROUND_LAUNCH=1` and Vitest `--maxWorkers=2`:

- Combined database, orchestration methods, strict authority/retirement, mutation
  executor, Run CLI and skill-guidance regression: 149 files / 1325 tests passed.
- Final retirement/schema/CLI/argument/skill-guidance group: 5 files / 110 tests passed,
  including added missing-host-proof and post-probe identity tests. It overlaps the
  preceding group; do not add the counts as unique coverage.
- The session-caller registry suite could not load because the local installation
  lacks `ws`; no passing result is claimed for that suite.
- Changed/new TypeScript lint, formatting, generated RPC catalog, and diff checks passed.
  Full node/CLI typechecks failed with missing dependencies and diagnostics outside the
  changed files; this is not a clean full-project typecheck or production acceptance.
- Both local skill entrypoints passed the skill-creator validator. Installed skill
  copies, remote repository skills and running services were not synchronized.
