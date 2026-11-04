"""Planned restart preparation only; independent review and service restart remain explicit."""

import argparse
import subprocess
from pathlib import Path

from coordinator_io import canonical, digest, file_ref, parse, pinned, publish_new, require
from operator_continuity_route import maintenance_call
from operator_continuity_source import seal_source
from operator_sender_correct import original
from coordinator_tui_errors import failure


def review_source(plan_ref, preparation_ref, seal_ref, *, approved, reason, call=None):
    contract = original(plan_ref)[4]
    prepared, sealed = parse(pinned(preparation_ref)), parse(pinned(seal_ref))
    require(prepared["preparation"]["proposal"]["plan"] == plan_ref
            and digest(canonical(prepared["preparation"])) == prepared["preparationCanonicalSha256"]
            and digest(canonical(prepared["preparation"]["proposal"]))
                == prepared["preparation"]["proposalCanonicalSha256"],
            "continuity_preparation_mismatch")
    seal = sealed["seal"]
    require(digest(canonical(seal)) == sealed["sealCanonicalSha256"]
            and seal["runId"] == prepared["preparation"]["runId"] == contract["run"]["id"]
            and seal["sourceRuntimeId"] == contract["runtime"], "continuity_seal_mismatch")
    result = maintenance_call(contract["cli"], contract["runtime"], dict(phase="review",
        seal=dict(runId=seal["runId"], databaseId=seal["databaseId"], sealCanonicalSha256=sealed["sealCanonicalSha256"]),
        proposalCanonicalSha256=prepared["preparation"]["proposalCanonicalSha256"],
        approved=approved, reason=reason), call=call)
    require(result.get("reviewCanonicalSha256") == digest(canonical(result.get("review")))
            and result["review"].get("preparationCanonicalSha256") == prepared["preparationCanonicalSha256"],
            "continuity_review_mismatch")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="phase", required=True)
    for phase in ("seal", "review", "transition"):
        p = sub.add_parser(phase)
        p.add_argument("--plan", required=True)
        p.add_argument("--plan-sha256", required=True)
        p.add_argument("--execute", action="store_true")
        p.add_argument("--output", required=True)
        if phase == "seal":
            p.add_argument("--expires-at-ms", type=int, required=True)
        else:
            p.add_argument("--seal", required=True)
            p.add_argument("--seal-sha256", required=True)
        if phase == "review":
            p.add_argument("--preparation", required=True)
            p.add_argument("--preparation-sha256", required=True)
            p.add_argument("--decision", choices=("approve", "reject"), required=True)
            p.add_argument("--reason", required=True)
        if phase == "transition":
            p.add_argument("--target-runtime", required=True)
    args = parser.parse_args(argv)
    require(args.execute, "planned_restart_execute_required")
    ref = lambda name: dict(path=getattr(args, name), sha256=getattr(args, name + "_sha256"))
    if args.phase == "seal":
        result = seal_source(ref("plan"), args.output, expires_at_ms=args.expires_at_ms)
    else:
        target = Path(args.output)
        require(target.is_absolute() and not target.exists(), "planned_restart_fresh_output_required")
        if args.phase == "review":
            result = review_source(ref("plan"), ref("preparation"), ref("seal"),
                                   approved=args.decision == "approve", reason=args.reason)
        else:
            contract = original(ref("plan"))[4]
            result = maintenance_call(contract["cli"], args.target_runtime,
                                      dict(phase="transition", seal=ref("seal")))
        publish_new(target, result)
        result = dict(receipt=file_ref(target), execution_authorized=False)
    print(canonical(result).decode())


def cli(argv=None):
    try:
        main(argv)
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(canonical(failure(exc, "planned_restart_stopped_preserve_all_evidence")).decode())
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
