# Paired-runtime simulation kit

`startSimulation()` builds isolated loopback runtimes and optional identity, record, and network
conditions in one call. Import only from this directory's `index.ts`; scenario code should not
depend on the primitive modules.

## Knobs

| knob | what real condition it stands for | what it cannot stand in for |
| --- | --- | --- |
| `runtimes` | One or more separately persisted remote environments. | Different machines, operating systems, kernels, users, or permission boundaries. |
| `runtimes[].name` | A stable environment name used by every other kit selector. | A product runtime ID or network hostname. |
| `runtimes[].servePort` | A caller-selected loopback endpoint, mainly for collision and recovery cases. | A routable host port, firewall rule, or NAT mapping. |
| `runtimes[].capabilities` | An assertion about the capabilities the real runtime advertises. | Capability replacement: unsupported values fail closed because the product has no override seam. |
| `network` | A userspace TCP proxy in front of one named runtime. | Kernel traffic control, packet-level emulation, DNS, TLS interception, or a true WAN. |
| `network.target` | The runtime name whose public handle and client traverse the proxy. | An array position, load balancer, or multi-hop route. |
| `network.faults.latencyMs` | Fixed delay on each one-way stream delivery. | Scheduler latency or precise packet round-trip time. |
| `network.faults.jitterMs` | Seeded variable one-way delivery delay. | Random packet reordering or nondeterministic internet jitter. |
| `network.faults.bandwidthBytesPerSec` | Deterministic userspace serialization delay by stream chunk. | Byte-perfect link shaping or congestion control. |
| `network.faults.resetAfterBytes` | An abrupt link reset after either direction reaches a byte boundary. | Graceful EOF, process death, or packet loss. |
| `network.faults.blackhole` | A connected socket that silently discards newly received bytes. | A refused connection, DNS outage, or listener shutdown. |
| `proxy.setFaults()` | A fault-policy change for bytes received after the call. | Retrofactive changes to already scheduled delivery. |
| `proxy.cut()` / `proxy.restore()` | Link loss followed by a same-port listener return; clients must reconnect. | Resurrection of sockets cut by the outage. |
| `identity.owner` / `identity.repo` | A GitHub-shaped origin backed by a local, network-free repository fixture. | Proof that GitHub is reachable or that credentials are valid. |
| `identity.metadataFile` | A checked-in tracker snapshot consumed without a runtime network call. | Live issue state or permission checks. |
| `records[].runtime` | The named runtime whose isolated profile receives a task record. | Replication to another runtime or a shared database. |
| `records[].args` | The exact deterministic record shape accepted by `seedTaskRecord`. | Product RPC mutation behavior or arbitrary persistence corruption. |
| `records[].args(runtime)` | Late resolution when a real runtime RPC, such as `repo.add`, creates an ID needed by the record. | General scenario setup; keep the resolver limited to producing seed arguments. |
| `bindings[].hostId` | The execution-host owner recorded for one binding. | A real remote machine or trust boundary. |
| `bindings[].isArchived` | The product's archived-binding state. | Deletion or absence. |
| `bindings[].runs` | A deterministic number of distinct historical run claims. | Live agents, transcripts, or model calls. |
| `bindings[].usage: 'unknown'` | An explicit unavailable usage settlement. | Zero tokens or zero cost. |
| `bindings[].usage: { tokens, costUsd }` | A known provider rollup with fixed values. | Recalculation from genuine provider telemetry. |

## Running the routed lane

`npm_config_verify_deps_before_run=false` alone did not stop Playwright global setup's `pnpm run
prepare:cli-output` from running an install/postinstall pass against the shared dependency tree.
For a prepared shared tree, put a bounded `pnpm` shim in a temporary `bin/` first on `PATH`; it must
accept only exactly `pnpm run prepare:cli-output`, run `verify-cli-bin.mjs` and
`install-dev-cli.mjs` directly, and exit 64 for every other invocation. Every lane sharing
`orca/node_modules` must use that shim (or a private dependency tree), or global setup can mutate
the tree underneath another worktree.

## Adding a scenario

Copy these exact 10 lines into a spec under `tests/e2e/`, then replace the assertion and fault:

```ts
import { expect, it } from 'vitest'
import { startSimulation } from './helpers/sim-remote'
it('reads through a degraded runtime @sim-network', async () => {
  const sim = await startSimulation({ runtimes: [{ name: 'alpha' }, { name: 'beta' }], network: { target: 'beta' } })
  try {
    expect(await sim.runtime('beta').client.call('status.get')).toMatchObject({ ok: true }); sim.proxy?.setFaults({ latencyMs: 25 })
  } finally {
    await sim.dispose()
  }
}, 90_000)
```

Keep the scenario below 90 seconds, add an applicable `@sim-*` tag, and register the spec in
`config/scripts/pr-e2e-source-routing.mjs` when scenario files are in scope.

## Determinism rules

- Select runtimes only by `name`; array position is not an identity.
- Wait for observable RPC, socket, process, or proxy-stat predicates. Never sleep for readiness.
- Jitter uses one fixed-seed delay per connection and direction, so TCP write or
  `data`-event fragmentation cannot change the jitter contribution to the same byte
  stream. That is why it is chunk-independent — and also why it does not model jitter
  that varies over the life of one connection.
- Seeded record IDs and timestamps derive only from seed inputs; replaying a seed is idempotent.
- Dispose in `finally`. Simulation teardown runs every action in reverse creation order and
  aggregates failures; repeated `dispose()` calls return the same settled teardown.
- Keep all traffic on IPv4 loopback and all profiles and repositories in isolated temporary roots.

## Honest limits

- Linux only: the kit does not model OS or kernel differences.
- There is no real model; agent behavior comes from `golden-stub-agent`.
- There is no multi-user or permission modelling.
- The proxy cannot reproduce true WAN pathologies such as packet loss, reordering, MTU changes,
  routing changes, DNS failure, or cross-region congestion.
- Capability advertisement cannot be overridden without a product seam. The runtime helper fails
  closed rather than faking an unsupported advertisement; the capability-gap verdict is covered at
  the unit layer instead.
- Loopback processes, local Git fixtures, and seeded profile state are controlled approximations,
  not evidence of real-machine equivalence or live service availability.
