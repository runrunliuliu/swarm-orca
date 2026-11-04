"""Direct evidence binding; validates declarations, never grants domain authority."""

from pathlib import Path
import re

from coordinator_io import canonical, digest, parse, path, pinned, validate_ref
from coordinator_tui_errors import require
from coordinator_loop import checkpoint_route
from coordinator_tui_dependencies import wait_spec
from coordinator_authority_bundle import ADAPTER, validate_binding, validate_progress


FIELDS = ("requirements", "paths", "barriers", "decision", "next_action")


def validate_checkpoint(ref, config, contract):
    require(any(path(ref["path"]).is_relative_to(Path(root))
                for root in contract["observation"]["roots"]), "tui_checkpoint_outside_roots")
    record = parse(pinned(ref))
    return validate_record(record, config, contract)


def validate_record(record, config, contract):
    """Validate the same projection before publication or after loading it."""
    require(set(record) == {"binding", "requirements", "checkpoint", "domain_check"},
            "tui_checkpoint_projection_invalid")
    require(canonical(record["binding"]) == canonical({"runtime": contract["runtime"], **contract["run"],
            "terminal": contract["coordinator"]["terminal"]}), "tui_checkpoint_binding_changed")
    validate_domain(record, contract, config)
    acceptance = parse(pinned(config["acceptance"]))
    require(canonical(record["requirements"]) == canonical(acceptance["requirements"]),
            "tui_original_acceptance_changed")
    route = checkpoint_route(record["checkpoint"], acceptance)
    if route.kind == "dependency_wait":
        wait_spec(record["checkpoint"]["next_action"])
    return record, route


def validate_domain(record, contract, config=None):
    domain = record["domain_check"]
    binding = (config or {}).get("authority_binding")
    if config is not None and "authority_binding" in config:
        validate_binding(binding, contract, parse(pinned(config["acceptance"])))
    require(isinstance(domain, dict) and set(domain) == {"adapter", "source", "receipt"}
            | ({"completion"} if binding is not None else set()),
            "tui_domain_check_required")
    require(domain["adapter"] == (ADAPTER if binding is not None else "rsi-authorized-progress-v1"),
            "tui_domain_adapter_unsupported")
    if binding is not None:
        validate_progress(domain, binding, contract)
    for name in ("source", "receipt"):
        validate_ref(domain[name])
        require(any(path(domain[name]["path"]).is_relative_to(Path(root))
                    for root in contract["observation"]["roots"]), "tui_domain_evidence_outside_roots")
    source, receipt = (parse(pinned(domain[name])) for name in ("source", "receipt"))
    require(isinstance(source, dict) and type(source.get("schema_version")) is int
            and source["schema_version"] == 2 and source.get("run_id") == contract["run"]["id"],
            "tui_domain_checkpoint_identity_mismatch")
    require(all(key in source for key in FIELDS)
            and canonical(record["checkpoint"]) == canonical({key: source[key] for key in FIELDS}),
            "tui_domain_projection_mismatch")
    require(isinstance(receipt, dict), "tui_domain_receipt_invalid")
    result, authority = receipt.get("result"), receipt.get("authority_check")
    require(receipt.get("ok") is True and isinstance(result, dict) and isinstance(authority, dict)
            and result.get("consistent") is True and authority.get("status") == "consistent"
            and authority.get("error_code") is None
            and type(authority.get("schema_version")) is int and authority["schema_version"] == 1
            and authority.get("grants_authority") is False, "tui_domain_receipt_invalid")
    # RSI hashes canonical JSON; the source/receipt file pins above hash raw bytes.
    require(authority.get("run_id") == source["run_id"]
            and authority.get("checkpoint_sha256") == digest(canonical(source))
            and isinstance(source.get("contract_sha256"), str)
            and result.get("contract_sha256") == source["contract_sha256"]
            and result.get("decision") == source["decision"], "tui_domain_receipt_binding_mismatch")
    require(all(isinstance(authority.get(key), str)
                and re.fullmatch(r"[a-f0-9]{64}", authority[key])
                and result.get(key) == authority[key]
                for key in ("authority_sha256", "context_sha256")), "tui_domain_receipt_binding_mismatch")
    return domain
