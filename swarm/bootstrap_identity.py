"""The two typed bootstrap denials `operator_monitor` still distinguishes.

This module used to hold `NativeIdentity`, the strict-handshake gate-role verifier: process
start ticks, `boot_id`, `SO_PEERCRED` ancestry, a 30 s lease and a declared-then-verified
provider. Its last caller went away with the 2026-11-13 handshake removal, so the class and the
native evidence helpers it owned (`host_process`, `process`, `unchanged`, `descendant`, `peer`,
`identity_pair`, `IdentitySnapshotExpired`, `BootstrapAdmissionClosed`, `NativeIdentityChanged`)
were deleted instead of surviving as code that reads like a live control. The design intent they
encoded is recorded in [native identity retirement](docs/design/native-identity-retirement.md).

What remains is the vocabulary, not the gate: a pending re-verification and an original-Operator
input are both read-only loop exits for the monitor, and it has to tell them apart to say which
owner comes next.
"""


class IdentityVerificationPending(ValueError):
    """Fresh evidence unavailable; no new admission, no assertion of death."""


class OperatorInputPending(ValueError):
    """Original Operator must handle exact input; not a role identity change."""
