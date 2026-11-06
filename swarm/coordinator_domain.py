"""Fixed domain selection for the existing strict control chain; no plugins."""

from pathlib import Path

from coordinator_io import canonical, parse, pinned, path, validate_ref
from coordinator_tui_errors import require


FIELDS = ("requirements", "paths", "barriers", "decision", "next_action")
SOFTWARE = "software-development-v1"
ADAPTERS = ("rsi-authorized-progress-v1", "rsi-authorized-progress-v2", SOFTWARE)


def validate_handoff(contract):
    """A software S0 handoff cannot lose its opt-in when building the session gate.

    Legacy handoffs remain opaque bytes. Only the new JSON domain_binding member
    opts into this contract; no interpretation or rewrite of historical prose.
    """
    raw = pinned(contract["handoff"])
    try:
        handoff = parse(raw)
    except ValueError:
        handoff = None
    selected = isinstance(handoff, dict) and "domain_binding" in handoff
    if selected or "domain_binding" in contract:
        require(selected and "domain_binding" in contract
                and canonical(handoff["domain_binding"]) == canonical(contract["domain_binding"]),
                "software_handoff_binding_changed")


def selection(config, contract):
    """The startup identity owns opt-in, not a mutable checkpoint or config."""
    config = config or {}
    explicit = "domain_binding" in contract or "domain_binding" in config
    if explicit:
        require("domain_binding" in contract and "domain_binding" in config
                and canonical(config["domain_binding"]) == canonical(contract["domain_binding"]),
                "tui_domain_binding_changed")
        require("authority_binding" not in config, "tui_domain_binding_conflict")
        require(isinstance(config["domain_binding"], dict)
                and config["domain_binding"].get("adapter") == SOFTWARE,
                "tui_domain_adapter_unsupported")
        return SOFTWARE
    return ADAPTERS[1] if "authority_binding" in config else ADAPTERS[0]


def validate_config_binding(config, contract):
    if selection(config, contract) == SOFTWARE:
        from software_development import validate_binding
        task = validate_binding(config["domain_binding"], contract)
        require(config["acceptance"] == task["acceptance"], "software_acceptance_changed")
        require(config["deadline"] == task["policy"]["deadline"], "software_deadline_changed")
        return task


def validate_domain(record, contract, config=None, *, current=False):
    adapter = selection(config, contract)
    domain = record["domain_check"]
    if adapter != SOFTWARE:
        # Fixed historical implementation, including its exact receipt semantics.
        from coordinator_tui_checkpoint import validate_rsi_domain
        return validate_rsi_domain(record, contract, config)
    require(isinstance(domain, dict) and domain.get("adapter") == adapter,
            "tui_domain_adapter_unsupported")
    from software_development import check, scoped_json
    task = validate_config_binding(config, contract)
    require(set(domain) == {"adapter", "source", "receipt"}, "tui_domain_check_required")
    roots = contract["observation"]["roots"]
    for key in ("source", "receipt"):
        validate_ref(domain[key])
        require(any(path(domain[key]["path"]).is_relative_to(Path(root)) for root in roots),
                "tui_domain_evidence_outside_roots")
    source = scoped_json(domain["source"], task["scope"]["read_roots"], task["scope"]["exclude_paths"])
    receipt = scoped_json(domain["receipt"], task["scope"]["read_roots"], task["scope"]["exclude_paths"])
    expected = check(config["domain_binding"], contract, domain["source"], current=current)
    require(canonical(receipt) == canonical(expected), "software_receipt_mismatch")
    require(canonical(record["checkpoint"]) == canonical({k: source[k] for k in FIELDS}),
            "tui_domain_projection_mismatch")
    return domain
