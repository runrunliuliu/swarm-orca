# Worker pre-release usage snapshot

`worker_usage_preserve.py` answers one question about a settled Worker: **what the transcript
still contains after the dispatch was settled but before the terminal is released**. It is the
only documented caller of `swarm_ledger.runtime_binding.capture` that is meant to be run *against*
a live deployment, so the entry is here rather than only in the tests.

It never releases, finalizes or imports usage. The receipt it publishes says so in three fields
(`final:false`, `usage_imported:false`, `release_performed:false`) and its coverage string names
the window it actually covered:
`partial_through_observation_including_post_settlement_tail`, with
`post_observation_output_unknown`, `billable_token_semantics_unverified`,
`full_turn_inventory_unverified` and `raw_tool_trace_not_archived` recorded as gaps. An unknown
tail is disclosed, never filled in.

## Command

```bash
python3 swarm/worker_usage_preserve.py \
  --cli /absolute/reviewed/orca-cli \
  --runtime-id <runtime id> \
  --run <run id> \
  --dispatch <dispatch id> \
  --binding /absolute/private/runtime-state-binding.json \
  --binding-sha256 <RAW_SHA256> \
  --output /absolute/private/evidence/worker-usage-preserve.json
```

All seven arguments are required. `--binding` is the same `runtime-state` binding other
`swarm_ledger` readers take: `provider` (must be `trae` here), `format: "runtime-state"`,
`final:false`, `host` equal to this host's name, `terminal_handle`, `worktree_id`, absolute
`profile` and `log_root` directories. `agent_id` must equal `--dispatch`; there is no fallback
worker. The file is passed as a path plus its pinned SHA256, so it is read through
`coordinator_io.pinned` and a changed byte is refused before anything is observed.

## Sequence, and what each step refuses

1. `native.verify_runtime()` — the CLI must be the reviewed executable for the configured runtime.
2. `relation()` — run-show, worker-show, and the terminal resource must agree: the dispatch
   belongs to the run, the run is not legacy, the resource is `owned` by this dispatch,
   `releaseState` is `not_requested` with no release timestamps, and the terminal handle matches
   the one in the binding. The effective launch agent must be `trae`.
3. The window must be coherent: `run.created_at ≤ dispatchedAt < completedAt ≤ now`.
4. `capture(..., since=started_at, until=now)` — the transcript evidence, including output written
   after `worker_done`.
5. `relation()` again — an outcome change, a release request, or a session mismatch that happened
   during the capture refuses the receipt instead of publishing a mixed snapshot.
6. `check_exact_session(...)` — the provider session in the evidence must be the one the dispatch
   recorded.
7. `publish_new(...)` — one immutable file, never replacing an existing one, then re-read and
   compared (`preserve_readback_mismatch`).

A refusal prints the typed code and writes nothing: there is no partial receipt, no retry loop and
no release attempt. A permission error during capture is a refusal too — the tool does not "try
again later", because the window it was asked about has already closed.

## What the published receipt is not

- not a billing or accounting verdict: `billable_token_semantics_unverified`;
- not a full turn inventory: only what the transcript still held at observation time;
- not evidence that the Worker's work was accepted, merged or reviewed;
- not a release: the terminal stays owned by the dispatch.

The offline suite covers the sequence above with a fake native reader
(`tests/worker/test_worker_usage_preserve.py`: post-settlement tail, released/unsettled/wrong-run
rejections, failed-but-settled partial usage, outcome change during capture, permission failure,
release requested during capture, and the release race). Those tests do not prove a live runtime
emits the same fields; a real capture is a deployment action with its own authorization.
