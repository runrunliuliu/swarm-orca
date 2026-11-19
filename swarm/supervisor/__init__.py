"""Fail-closed, remote-first policy layer for Orca's native orchestration.

The fixed-DAG Sidecar (`engine`, `watchdog`, `launch_guard`'s service use, `service_finish`,
`__main__`) and its `runit/` templates were retired on 2026-11-19: no production module called
them and no host ever installed the templates, so keeping the read like a running control plane.
`docs/supervisor.md` is now the retirement record.

What remains is imported by the rest of `swarm/`: `config` (the `SafetyError` family and the
reviewed contract), `store` (admission, reservations, the state lock), `orca`/`trae_trust` (the
native adapter) and `receipts` — used by `swarm_ledger/*`, `operator_trust`, `pi_tui`,
`evidence_archive` and `trae_tui`. `launch_guard` and `safety` survive for the four offline
commands documented in `startup-safety.md` (`preflight`, `diagnose`, `derive-receipts`,
`check-receipts`), which serve the adaptive path, not the retired service.

Why this package has its own `require` (raising `SafetyError`, not `ValueError`): the dependency
runs one way — `supervisor/` never imports a top-level module, so it can be staged and imported on
its own. `coordinator_tui_errors.require` is the third `require`, and it is a third layer again:
TUI callers get a typed code with its own `recovery` text. The repeated `digest` (here) and
`digest`/`canonical` (in `coordinator_io`) are the same price. Three implementations of one verb
is a layering decision, not an unmerged duplicate — do not collapse them without first removing
the independence they buy.
"""
