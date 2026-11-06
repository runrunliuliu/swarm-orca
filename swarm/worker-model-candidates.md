# Worker model candidates

This public copy does not ship private provider/model policy. Define approved
workers in `worker-model-profiles.json` or in a private configuration file before
launching real agents.

Example shape:

| Agent | Model | Effort | Backend | Status |
| --- | --- | --- | --- | --- |
| `example-agent` | `example-model` | `high` | `standard` | placeholder only; not deployable |
| `pi` | `example-provider/example-model` | `null` | `null` | placeholder only; Pi takes one provider-qualified selector and rejects effort/backend |

The fixed `agent`/`effort`/`backend_variant` values above are illustrative. A `pi`
profile must leave effort and backend `null`; Trae effort/Max values are not
mapped to Pi thinking and are refused before launch.

