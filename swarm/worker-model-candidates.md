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

