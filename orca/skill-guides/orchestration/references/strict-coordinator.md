# Separate business Coordinator and strict control

Operator drives the business Coordinator, which owns Task decomposition, Worker
dispatch, decisions and acceptance throughout research, training and evaluation.
Missing output or a Worker-start receipt requires reconciliation, not Operator
takeover. Send goals/evidence to `run:<id>`; monitor via explicit run-show,
task-list, worker-list and inbox. Do not consume its mailbox or send raw Worker
terminal input. Only the Coordinator sends typed Worker instructions.

Independent work remains parallel: after a training submission is reconciled,
that path can wait while the same Coordinator advances unrelated research or
review. Freeze training inputs, isolate writes, and preserve the task's Worker
and external Job capacity/budget limits separately.

## Experimental runtime guard

For an authorized strict task in a shared or isolated profile, the verified native terminal
Coordinator creates a new Run using:

```text
ORCA orchestration run-create --strict-coordinator --objective "<objective>" --json
ORCA orchestration run-show --id <run_id> --json
```

Verify `coordinatorPolicy: "strict-v1"` and the owner/generation. A --from handle
is not identity proof. The distinct RPC fails closed on unsupported servers;
never retry without strict. Ordinary run-create remains unchanged; this does not
convert existing Runs. A task policy that defaults supervised Swarms to strict
must stop when prerequisites are unsupported, not use the generic loop instead.

Only same-runtime terminal Workers are supported, not federated/structured ones.
This guard is experimental and has no safe rebind/adoption or crashed-Coordinator
recovery. Verify runtime capabilities, native identity and task impact before launch;
a shared profile alone is not a blocker. Loss of
identity stops affected writes; another terminal cannot claim ownership through
run-use, copied credentials, a hand-written receipt or a new Run.

## Original-Coordinator retirement

After business and external Job reconciliation, the original live Coordinator
may retire the Run. First settle all Tasks/Dispatches/gates, finish resource
operations and resolve pending requests. Every historical Worker process must
be proven `exited` by its execution host; `worker_done`, retained state and
`unverifiable` are not exit evidence. No other orchestration call (including a
waiting check) may be in flight. The retirement check temporarily refuses new
orchestration writes across the runtime; it does not serialize ordinary work.

```text
ORCA orchestration run-retire-strict --run <run_id> --generation <observed_generation> --decision <reconciliation_reference> --json
ORCA orchestration run-show --id <run_id> --json
```

Retirement atomically stores its receipt, unbinds the owner and advances the
consumer generation. History remains inspectable but cannot be reactivated;
the Coordinator can create a new Run and proven-exited Worker panes cease to be
raw-input protected. The same original identity can retrieve the retirement
receipt after a lost response; use request-show / the same retry-request when
available. Unknown requests in the database conservatively block retirement,
even if their Run scope is unavailable. Do not delete them to bypass the check.

This operation neither stops processes nor verifies external Jobs. It is not
adoption or business acceptance. Strict history still blocks database reset.
Renderer/internal input, direct external APIs and arbitrary shell processes are
not universally guarded; this is same-user role discipline, not a hostile-user
security boundary. Production rollout still needs safe recovery and live host
acceptance. Skill text and local tests are not deployment evidence.
