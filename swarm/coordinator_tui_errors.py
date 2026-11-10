"""Public TUI diagnostics: local codes only, never raw native/provider errors."""

import math

from coordinator_io import FilePinChanged
from trae_coordinator import ContextFreshnessError
from observation_budget import ObservationTimeout, ObservationBusy


class TuiError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise TuiError(code)


def failure(exc, fallback):
    result = {"ok": False, "decision": "stop", "error": fallback}
    if isinstance(exc, ObservationBusy):
        result.update(error=str(exc), observation="unavailable", execute_action=False,
                      recovery="preserve_receipts_no_mutation_replay")
    elif isinstance(exc, ObservationTimeout):
        result.update(error=str(exc), **exc.details, execute_action=False,
                      recovery="preserve_receipts_audit_incomplete_no_business_or_ack_replay")
    elif isinstance(exc, TuiError):
        result["error"] = str(exc)
        if getattr(exc, "missing_evidence", None):
            # Provider refusals name the absent evidence channels; they are
            # diagnostics for routing, not an alternative success path.
            result["missing_evidence"] = list(exc.missing_evidence)
        recovery = {
            "tui_action_window_insufficient": "checkpoint_enqueue_end_turn_no_new_business_action",
            "tui_continuation_new_real_turn_required": "end_current_turn_keep_tui_and_original_pins",
            "tui_hook_stale_or_future": "preserve_receipts_verify_real_hook_no_timestamp_rewrite",
            "tui_turn_end_unprocessed_delivery": "process_whole_delivery_persist_evidence_then_ack",
            "tui_turn_end_unsettled_action": "reconcile_claimed_action_no_replay_no_automatic_ack",
            "tui_turn_end_mailbox_state_unavailable": "matching_server_required_do_not_assume_empty",
            "tui_checkpoint_not_from_current_turn": "revalidate_domain_publish_new_checkpoint_in_current_turn_keep_config_and_journal_no_timestamp_rewrite",
            "tui_checkpoint_turn_timestamp_required": "publish_genuine_current_turn_domain_checkpoint_and_receipt_no_timestamp_fabrication",
            "tui_checkpoint_predates_dispatch_gate": "publish_domain_checked_checkpoint_after_successful_dispatch_gate_keep_original_pins",
            "tui_scheduler_checkpoint_not_advanced": "publish_domain_checked_next_authorized_action_with_unused_id_or_evidenced_terminal_decision_preserve_journal_no_replay_no_stop_reset",
            "tui_result_control_file_reference": "publish_immutable_evidence_outside_control_state_retry_unsettled_result_without_action_replay",
        }.get(str(exc))
        if recovery:
            result["recovery"] = recovery
    elif isinstance(exc, FilePinChanged):
        result["error"] = "file_pin_changed"
        result["recovery"] = "preserve_original_pins_and_receipts_no_repin_or_replay"
    elif isinstance(exc, ContextFreshnessError):
        result["error"] = exc.code
        for key in ("age_seconds", "max_age_seconds"):
            value = getattr(exc, key)
            if type(value) in (int, float) and math.isfinite(value):
                result[key] = value
        result["recovery"] = "new_real_turn_context_required_no_timestamp_rewrite_or_ttl_extension"
    return result
