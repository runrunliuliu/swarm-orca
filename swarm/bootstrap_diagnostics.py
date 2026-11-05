"""Best-effort owner diagnostics using its already-known Unix endpoint.

No owner.json/NAS read, health assertion, role authentication, or confirmation.
Same-UID transport is not signed protocol evidence. Never use this to release.
"""

import argparse
import os
import socket
import struct
import time
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path


def close_rejected(server, *, seconds=.25):
    """Bounded L1 local staging, never a NAS receipt or proof of owner exit.

    A dedicated one-shot daemon also works if ordinary I/O slots are exhausted.
    No joins/retries, no NAS access, no fsync/durability claim. Local staging is
    optional evidence only; the operator must archive it to NAS after recovery.
    """
    operation = server.diagnostic_operation
    record = dict(schema_version=1, kind="owner_close_rejected", diagnostic_only=True,
                  durable=False, archive_pending=True, execution_authorized=False,
                  requires_reconciliation=True, outcome="unknown", execution_cancelled=False,
                  reason="bootstrap_owner_busy_requires_reconciliation",
                  control=asdict(server.owner.control), process=server.owner.process,
                  operation=operation.snapshot() if operation else None,
                  staging_root="/tmp", target=None, staging_state="unknown")
    done = threading.Event()

    def write():
        from coordinator_io import canonical
        try:
            root = Path(tempfile.mkdtemp(prefix="swarm-owner-close-", dir="/tmp"))
            target = root / "owner-close-rejected.json"
            record["target"] = str(target)
            # Exclusive creation under a fresh private directory; never overwrite.
            with target.open("xb") as output:
                output.write(canonical(record))
            record["staging_state"] = "written_unverified"
        except (OSError, ValueError):
            record["staging_state"] = "unavailable"
        finally:
            done.set()

    try:
        threading.Thread(target=write, daemon=True, name="owner-close-diagnostic").start()
        done.wait(seconds)
    except RuntimeError:
        record["staging_state"] = "unavailable"
    return record.copy()


def same_uid(connection):
    from coordinator_io import require
    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(uid == os.getuid(), "bootstrap_peer_uid_mismatch")


def diagnose(endpoint, *, seconds=2):
    from bootstrap_control import receive, send, transport_timeout
    from coordinator_io import require
    require(isinstance(endpoint, str) and endpoint.startswith("/"), "bootstrap_endpoint_invalid")
    require(type(seconds) in (int, float) and 0 < seconds <= 10, "bootstrap_diagnostic_budget_invalid")
    deadline = time.monotonic() + seconds
    with socket.socket(socket.AF_UNIX) as connection:
        transport_timeout(connection, deadline)
        connection.connect(endpoint)
        same_uid(connection)
        transport_timeout(connection, deadline)
        send(connection, {"op": "diagnose"})
        result = receive(connection, deadline=deadline)
    require(result.get("diagnostic_only") is True and result.get("durable") is False
            and result.get("execution_authorized") is False, "bootstrap_diagnostic_reply_invalid")
    return result


def main(argv=None):
    from blocking_io import run, BlockingIOTimeout
    from coordinator_io import canonical
    from bootstrap_transport import safe_reason
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="Exact endpoint from the original owner registration")
    args = parser.parse_args(argv)
    try:
        result = run(lambda: diagnose(args.endpoint), seconds=3, name="owner_diagnose")
        code = 0
    except (OSError, ValueError) as exc:
        result = dict(diagnostic_only=True, durable=False, execution_authorized=False,
                      state="unknown", reason=safe_reason(exc))
        if isinstance(exc, BlockingIOTimeout):
            result["diagnostics"] = exc.details
        code = 2
    print(canonical(result).decode())
    return code


if __name__ == "__main__":
    raise SystemExit(main())
