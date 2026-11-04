"""Read-only Trae Worker pre-release snapshot; never release or finalize usage.

Preserve the settled dispatch's still-bound transcript through observation time,
including output after worker_done. The native accounting end time is unchanged.
"""

import argparse
from datetime import datetime, timezone
import time

from coordinator_io import canonical, file_ref, parse, path, pinned, publish_new, require
from swarm_ledger.ledger import seconds, timestamp
from swarm_ledger.native import Reader
from swarm_ledger.runtime_binding import capture, configuration, identifier
from swarm_ledger.runtime_trae import LOCAL_HOST, check_exact_session


def relation(native, options, run_id, dispatch_id):
    run = native.read("orchestration", "run-show", "--id", run_id)["run"]
    require(run.get("id") == run_id and not run.get("legacy"), "preserve_run_mismatch")
    row = native.read("orchestration", "worker-show", "--dispatch", dispatch_id)
    dispatch, worker, resource = row["dispatch"], row["worker"], row.get("terminalResource") or {}
    require(dispatch.get("id") == dispatch_id and dispatch.get("runId") == run_id
            and worker.get("dispatchId") == dispatch_id and dispatch.get("hostScope") == LOCAL_HOST,
            "preserve_dispatch_mismatch")
    require(dispatch.get("status") == "completed" and worker.get("state") in ("succeeded", "failed")
            and dispatch.get("completedAt"), "preserve_settlement_required")
    require(resource and resource.get("ownershipState") == "owned"
            and resource.get("ownerDispatchId") == dispatch_id
            and resource.get("releaseState") == "not_requested"
            and resource.get("releaseRequestedAt") is None
            and resource.get("releaseCompletedAt") is None
            and resource.get("terminalHandle") == options["terminal_handle"]
            and (row.get("terminal") or {}).get("handle") == options["terminal_handle"],
            "preserve_unreleased_terminal_required")
    effective = ((worker.get("startOptions") or {}).get("launch") or {}).get("effective") or {}
    require(effective.get("agent") == "trae", "preserve_provider_mismatch")
    return dict(run_id=run_id, run_started_at=timestamp(run.get("created_at"), native=True),
                dispatch_id=dispatch_id, task_id=identifier(dispatch.get("taskId")),
                started_at=timestamp(dispatch.get("dispatchedAt"), native=True),
                settled_at=timestamp(dispatch["completedAt"], native=True),
                terminal_handle=options["terminal_handle"], provider_session=row.get("providerSession"))


def preserve(native, options, run_id, dispatch_id, output, *, clock=time.time):
    configuration(options)
    require(options["provider"] == "trae" and options.get("agent_id") == dispatch_id,
            "preserve_explicit_trae_worker_required")
    require(output.is_absolute() and output.name not in ("", ".", ".."), "absolute_output_required")
    path(str(output.parent), directory=True)
    require(not output.exists() and not output.is_symlink(), "preserve_output_exists")
    native.verify_runtime()
    before = relation(native, options, run_id, dispatch_id)
    until = datetime.fromtimestamp(clock(), timezone.utc).isoformat()
    require(before["run_started_at"] and before["started_at"]
            and seconds(before["run_started_at"]) <= seconds(before["started_at"])
            < seconds(before["settled_at"]) <= seconds(until), "preserve_invalid_window")
    evidence = capture(native, options, clock=clock, since=before["started_at"], until=until,
                       scope=dict(runtime_id=native.runtime_id, run_id=run_id, agent_id=dispatch_id))
    require(before == relation(native, options, run_id, dispatch_id), "preserve_scope_changed")
    check_exact_session(before, evidence)
    # Do not publish the raw native providerSession object or any transcript text.
    scope = {key: value for key, value in before.items() if key != "provider_session"}
    receipt = dict(schema_version=1, kind="worker_pre_release_usage", scope=scope,
                   evidence=evidence, final=False, usage_imported=False, release_performed=False,
                   coverage="partial_through_observation_including_post_settlement_tail",
                   gaps=["post_observation_output_unknown", "billable_token_semantics_unverified",
                         "full_turn_inventory_unverified", "raw_tool_trace_not_archived"])
    publish_new(output, receipt)
    ref = file_ref(output)
    require(parse(pinned(ref)) == receipt, "preserve_readback_mismatch")
    return dict(state="preserved_partial", receipt=ref, final=False, release_performed=False)


def main(argv=None):
    from pathlib import Path
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("cli", "runtime-id", "run", "dispatch", "binding", "binding-sha256", "output"):
        p.add_argument("--" + name, required=True)
    args = p.parse_args(argv)
    options = parse(pinned(dict(path=args.binding, sha256=args.binding_sha256)))
    result = preserve(Reader(args.cli, args.runtime_id), options, args.run, args.dispatch, Path(args.output))
    print(canonical(result).decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
