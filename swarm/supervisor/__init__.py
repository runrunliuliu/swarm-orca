"""Fail-closed, remote-first policy layer for Orca's native orchestration.

Deployment status, stated here because the code reads like a running control plane: the Sidecar
half of this package (`engine`, `watchdog`, `launch_guard`, `safety`, `service_finish`,
`__main__`) has offline tests and **no production caller**, and the `runit/` templates beside it
were never installed, registered or accepted on a host (see `../README.md` and `../acceptance.md`).
The library half (`config`, `store`, `orca`, `receipts`, `trae_trust`) is the part other modules
import; `config` is imported by two dozen modules.

Why this package has its own `require` (raising `SafetyError`, not `ValueError`): the dependency
runs one way — `supervisor/` never imports a top-level module, so the MVP can be staged and
deployed on its own. `coordinator_tui_errors.require` is the third `require`, and it is a third
layer again: TUI callers get a typed code with its own `recovery` text. The repeated `digest`
(here) and `digest`/`canonical` (in `coordinator_io`) are the same price. Three implementations of
one verb is a layering decision, not an unmerged duplicate — do not collapse them without first
removing the deployment independence they buy.
"""
