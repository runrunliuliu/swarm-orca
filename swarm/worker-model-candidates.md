# Worker model candidates

This public copy does not ship private provider/model policy. Define approved
workers in `worker-model-profiles.json` or in a private configuration file before
launching real agents.

Example shape:

| Agent | Model | Effort | Backend | Status |
| --- | --- | --- | --- | --- |
| `example-agent` | `example-model` | `high` | `standard` | placeholder only; not deployable |
| `pi` | `example-provider/example-model` | `null` | `null` | placeholder only; Pi takes one provider-qualified selector and rejects effort/backend |
| `codex-ark` | `codex-ark/example-ark-model` | `null` | `null` | placeholder only; the wrapper config owns the model, so the plan passes `--agent codex-ark` only |

The fixed `agent`/`effort`/`backend_variant` values above are illustrative. A `pi`
profile must leave effort and backend `null`; Trae effort/Max values are not
mapped to Pi thinking and are refused before launch. A `codex-ark` profile must
also leave both `null` and key the entry as `codex-ark/<model-id>`: Orca has no
launch-preference catalog for it, so `--model`/`--effort`/`--backend-variant`
are refused and the wrapper's own config decides the model. That declared model
is not enforced by argv, so the Operator must separately pin the wrapper config
and check `codex-ark --ark-status` before dispatch. Details:
[Worker 参数计划](coordinator-worker-plan.md#codex-ark-worker-固定参数).

`orchestration worker-start --agent <id>`
takes its agent id from the running Orca build, not from this profile. Upstream v1.4.219
source registers a `codex-ark` TUI agent, but a deployed build can predate that entry, and
such a build refuses the id as an unknown TUI agent. Check the build you are about to use
before claiming the agent is deployable; listing a profile proves nothing on its own.

Launch transport is not a request field either. `coordinator_worker_profiles.AGENT_TRANSPORT`
is a closed table (`trae`: `both`, `pi`/`codex-ark`: `tui-only`) and the worker plan only
exists as a TUI launch, so a reviewed agent with no TUI shape is refused before a plan or
a terminal exists. Transport is never inferred from another agent and never downgraded; see
[启动传输](coordinator-worker-plan.md#启动传输tui--exec-由-agent-决定不由请求选择).

