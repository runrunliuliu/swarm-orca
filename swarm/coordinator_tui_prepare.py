"""One-shot schema2 initialization from genuine, already checked domain evidence.

No domain authority generation, send, ACK, Worker launch or monitor activation.
The final fixed reference is published last; failed partial attempts are retained.
"""

import argparse
import os
from pathlib import Path
import shlex
import stat
import sys

from coordinator_io import (canonical, file_ref, now, parse, path, pinned,
                            publish_new, timestamp)
from coordinator_tui_checkpoint import FIELDS, validate_record, validate_checkpoint
from coordinator_tui_continue import fence, freshness, load, validate_config
from coordinator_tui_errors import failure, require
from trae_coordinator import native
from operator_sender import preflight as sender_preflight
from coordinator_authority_bundle import ADAPTER


def validate_inputs(data, *, pre_execution=False):
    """Write-free validation of one continuation initialization input.

    The lifecycle action calls this before it takes its execution fence, so a
    deterministic input mistake (for example an acceptance document that is not
    exactly {"requirements": [...]}) fails without leaving an
    ``*-executing.json`` marker behind. It creates nothing and makes no native
    calls; callers still revalidate inside ``prepare`` before publishing.
    """
    require(isinstance(data, dict) and set(data) == {
        "schema_version", "contract", "dispatch_gate", "acceptance", "deadline",
        "scheduler", "output_dir", "source", "receipt"} | (set(data) & {
            "startup_lifecycle", "turn_protocol", "authority_binding", "completion", "execution", "startup_evidence"})
        and type(data["schema_version"]) is int and data["schema_version"] == 1,
        "tui_prepare_inputs_invalid")
    require(("authority_binding" in data) == ("completion" in data), "tui_prepare_authority_pair_required")
    output = Path(data["output_dir"])
    # Existing private parent, exact child, no symlink or implicit directory tree.
    require(output.is_absolute() and output.name not in ("", ".", ".."),
            "tui_prepare_absolute_output_required")
    parent = path(str(output.parent), directory=True)
    require(output == output.resolve(), "tui_prepare_canonical_output_required")
    info = parent.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
            "tui_prepare_private_parent_required")
    require(not os.path.lexists(output), "tui_prepare_already_started_preserve_receipts")
    config = {key: data[key] for key in ("contract", "dispatch_gate", "acceptance", "deadline", "scheduler")}
    if "startup_lifecycle" in data:
        config["startup_lifecycle"] = data["startup_lifecycle"]
    for key in ("execution", "startup_evidence"):
        if key in data:
            config[key] = data[key]
    if "turn_protocol" in data:
        config["turn_protocol"] = data["turn_protocol"]
    if "authority_binding" in data:
        config["authority_binding"] = data["authority_binding"]
    config.update(schema_version=2, state_root=str(output / "state"),
                  checkpoint_head=str(output / "checkpoint-head.json"))
    contract = validate_config(config, require_executing=not pre_execution)
    require(any(output.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "tui_prepare_output_outside_roots")
    return output, config, contract


def prepare(inputs_ref, *, call=native):
    data = parse(pinned(inputs_ref))
    output, config, contract = validate_inputs(data)


    def projection():
        # Check scope before reading domain files, including the first read.
        for key in ("source", "receipt"):
            require(any(path(data[key]["path"]).is_relative_to(Path(r))
                        for r in contract["observation"]["roots"]), "tui_domain_evidence_outside_roots")
        source = parse(pinned(data["source"]))
        require(isinstance(source, dict) and all(k in source for k in FIELDS),
                "tui_domain_checkpoint_identity_mismatch")
        acceptance = parse(pinned(data["acceptance"]))
        record = dict(binding={"runtime": contract["runtime"], **contract["run"],
                               "terminal": contract["coordinator"]["terminal"]},
                      requirements=acceptance["requirements"],
                      checkpoint={k: source[k] for k in FIELDS},
                      domain_check=dict(adapter="rsi-authorized-progress-v1",
                                        source=data["source"], receipt=data["receipt"]))
        if "authority_binding" in config:
            record["domain_check"].update(adapter=ADAPTER, completion=data["completion"])
        validate_record(record, config, contract)
        return record, source

    def revalidate():
        pinned(inputs_ref)
        validate_config(config)
        record, source = projection()
        evidence = fence(contract, call)
        timing = freshness(contract, evidence, data["deadline"])
        sender_preflight(config["scheduler"], contract["runtime"],
                         lambda args, runtime: call(contract["cli"]["path"], runtime, args))
        from startup_execution import startup_gate
        gate = startup_gate(config)
        require(isinstance(source.get("observed_at"), str)
                and timestamp(gate["completed_at"]) <= timestamp(source["observed_at"])
                and timestamp(evidence["observed_at"]) <= timestamp(source["observed_at"])
                <= timestamp(now()), "tui_checkpoint_not_from_current_turn")
        # Re-pin after native I/O, immediately before local publication.
        pinned(inputs_ref)
        validate_config(config)
        projection()
        return record, timing

    record, _ = revalidate()
    output.mkdir(mode=0o700)  # Exclusive attempt fence; never reset/replay a partial.
    publish_new(output / "initialization-intent.json", inputs_ref)
    (output / "state").mkdir(mode=0o700)
    publish_new(output / "checkpoint.json", record)
    checkpoint_ref = file_ref(output / "checkpoint.json")
    publish_new(output / "checkpoint-head.json", checkpoint_ref)
    publish_new(output / "continuation.json", config)
    config_ref = file_ref(output / "continuation.json")
    load(config_ref)
    _, timing = revalidate()
    validate_checkpoint(checkpoint_ref, config, contract)
    # Bind the new journal before advertising it; no outbox entries are invented.
    publish_new(output / "state" / "tui-continuation-binding.json", config_ref)
    publication = output / "continuation-ref.json"
    publish_new(publication, config_ref)

    def command(mode):
        return shlex.join([str(Path(sys.executable).resolve()),
            str(Path(__file__).resolve().with_name("coordinator_tui_continue.py")),
            mode, "--config", config_ref["path"], "--config-sha256", config_ref["sha256"]])
    readiness = {
        "continuation_config_ready": True,
        "continuation_config": config_ref,
        "checkpoint_head_ready": True,
        "checkpoint_head": file_ref(output / "checkpoint-head.json"),
        "initial_checkpoint": checkpoint_ref,
        "state_binding_ready": True,
        "state_binding": file_ref(output / "state" / "tui-continuation-binding.json"),
        "monitor_deploy_required": True,
        "turn_end_audit_required": True,
        "scheduler_first_checkpoint_required": True,
        "scheduler_completion_condition": "claim_action_settle_ack_next_checkpoint",
        "live4_completion_condition": "two_complete_scheduler_cycles_after_real_turn_end",
        "role_completion": {
            "coordinator": ["publish_checkpoint_head", "run_turn_end_audit", "claim", "action", "settle", "ack_delivery",
                            "publish_next_checkpoint_after_scheduler_action"],
            "operator": ["deploy_monitor_with_same_sender_state", "observe_monitor_ready", "audit_first_scheduler_checkpoint"],
            "monitor_scheduler": ["observe_real_turn_end", "schedule_next_checkpoint"]}}
    readiness["startup_lifecycle"] = config.get("startup_lifecycle")
    if "authority_binding" in config:
        readiness["authority_binding"] = config["authority_binding"]
    if "turn_protocol" in config:
        readiness["turn_protocol"] = config["turn_protocol"]
        readiness["scheduler_completion_condition"] = "accepted_submission_then_real_turn_end"
        readiness["role_completion"]["coordinator"] = ["begin", "process_whole_batch", "submit",
                                                       "inspect_submission_and_turn_end"]
    return dict(ok=True, state="initialized", config=config_ref, checkpoint=checkpoint_ref,
                publication=file_ref(publication), freshness=timing, check_command=command("check"),
                turn_end_command=command("turn-end"),
                continuation_readiness=readiness,
                next_step=("operator_startup_observes_publication_then_monitor_ready_then_turn_end_audit"
                           if "startup_lifecycle" in config else
                           "operator_monitor_deploy_prepare_run_verify_then_turn_end_audit_then_end_real_turn"),
                execution_authorized=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--inputs-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "tui_prepare_execute_required")
        result = prepare({"path": args.inputs, "sha256": args.inputs_sha256})
    except Exception as exc:
        result = failure(exc, "tui_prepare_failed_preserve_receipts")
    print(canonical(result).decode())
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
