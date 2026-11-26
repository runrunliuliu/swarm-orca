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
| `ORCA_CAPTURE_EVIDENCE=1` | The opt-in that turns lane-B capture on for one run. | A CI mode or a default: without the literal `1` no screenshot, CDP session or encoder is touched. |
| `captureEvidence({ page, name, record: true })` | The real renderer's own pixels for the span between the helper starting the CDP screencast and the screenshot being taken — typically the screenshot's own span, 0–3 frames at 15 fps. | The page's lifetime: a longer clip needs the caller to run `startRecording(page, { scope: 'page-lifetime' })` (see “Recording a scenario”). It never decides a spec: a failed start or write arrives as `skipped` with the reason, and a degraded capture still returns the frames it did get. |
| `startRecording(page, { outDir, scope })` | Paint-paced CDP screencast frames, each carrying its own `metadata.timestamp`, so the timeline is what the page painted. | Continuous wall-clock coverage: no paint means no frame, and one still frame is not a second of stillness. |
| `writeEvidencePackage({ slug, lane, command, artefacts, notCaptured, redaction, … })` | One hashed `pr-evidence/<slug>/manifest.json` over the bytes that were actually captured. | Truth: `notCaptured`, `redaction` and every `what` string stay caller claims, so the hash makes them stable, not verified. |

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

### Recording a scenario

Two sentences, two calls: run the spec with `ORCA_CAPTURE_EVIDENCE=1`, call
`captureEvidence({ page, name: '<two digits>-<before|after|scenario>-<id>.png', record: true })` once
`page` holds the state worth showing, then hand what it returned to `writeEvidencePackage()`, which
hashes it into `pr-evidence/<slug>/manifest.json`. The recording travels in `recordings`, never in
`artefacts`, and it needs a `recordingScope`: the writer refuses a package that ships a clip without
saying what it covers. This block is the whole thing, and pasting it verbatim produces a package
that validates.

```ts
import { captureEvidence } from './helpers/evidence-capture'
import { writeEvidencePackage } from './helpers/sim-remote/evidence-package'

const capture = await captureEvidence({ page, name: '01-before-issue-67.png', record: true })
if (!capture.screenshotPath) {
  throw new Error(`evidence capture skipped: ${capture.skipped ?? 'no screenshot'}`)
}
await writeEvidencePackage({
  slug: 'issue-67-remote-only-record',
  lane: 'B',
  command: 'pnpm test:e2e --grep @issue-67',
  project: 'orca',
  notCaptured: ['agent model output (a stub agent stands in)', 'anything outside the app window'],
  redaction: { applied: false, what: 'nothing was redacted; treat the package as sensitive' },
  artefacts: [{ file: capture.screenshotPath, what: 'the window before the palette opened' }],
  recordings: capture.recording ? [capture.recording] : [],
  recordingScope: "the screenshot call's own span (0-3 frames at 15 fps), not the page's lifetime"
})
```

What `record: true` covers is short by construction: the helper starts the screencast, takes the
screenshot, and stops it, so the clip is the screenshot's own span rather than the page's lifetime.
For a clip covering the page's lifetime, call `startRecording(page, { scope: 'page-lifetime' })`
before the work, `await recording.stop()` after it, and pass that artifact instead —
`recordings: [clip]` with `recordingScope: "the page's lifetime"` — everything else in the block is
unchanged, because the recorder artifact *is* the entry the writer takes.

Recording is best-effort by construction — no encoder, no CDP session, or a disk error yields a
degraded artifact with `videoPath: null` and the reason, and the frames stay behind as
`frames/*.jpg` and `timings.json` instead of failing the spec.

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
- A recording is evidence, not an assertion. The recorder, the encoder and the package writer must
  never turn a red product assertion green or a green one red; a clip nobody reads proves nothing.
- The clip covers only the span the recorder was running for — the page's lifetime only when the
  caller started it at page start — and inside that span only the moments the page painted. Frames
  arrive when the compositor presents one, so a large `largestGapSec` is missing picture rather than
  a proven still interval, and the seconds before the recorder started are not in the file at all.
- It records whatever is on screen, including absolute paths in the window chrome and any content
  the fixture did not redact. Say in the manifest what was and was not redacted, and treat the
  artefact as sensitive: recording is a lane-B, opt-in, non-archived-in-CI action.
