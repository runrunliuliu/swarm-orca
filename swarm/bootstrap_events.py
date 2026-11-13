"""Read-only strict bootstrap evidence diagnostics (Phase 1, no live adapter).

Only fixed paths are read. No notifications, native queries, confirmation repair,
locks, request publication, retries or model calls. Even a complete valid chain
does NOT produce ready_for_strict_config_request.
"""

import argparse
from datetime import timedelta

import json
import os
from pathlib import Path

from bootstrap_protocol import BACKEND, EVENTS, PRODUCERS, layout
from trae_coordinator import UUID  # the validator that shaped these slots
from tui_adapter import kind_adapter
from coordinator_io import (FilePinChanged, digest, now, parse, path, pinned,
                            read_bytes, timestamp, validate_ref)
from coordinator_startup import build_session_contract, session_contract_value
from coordinator_strict import StrictCheckError, caller_result


# ── historical contract readers ──────────────────────────────────────────────
# These four checks used to live in the strict request builders that this repository no longer
# produces. They are kept here because the read-only diagnostic must still be able to say why an
# *old* attempt stopped: the slots are frozen, so the rules that validated them are frozen with them.

def _unique_refs(refs):
    require(isinstance(refs, list) and refs, "strict_config_evidence_required")
    result = []
    for ref in refs:
        validate_ref(ref)
        require(Path(ref["path"]).is_absolute(), "strict_config_evidence_path_invalid")
        if ref not in result:
            result.append(ref)
    return result


def exact_refs(refs):
    require(_unique_refs(refs) == refs, "strict_prepare_duplicate_evidence")
    return refs  # Never sort, expand embedded JSON, or normalize duplicates.


def source_contract(expected):
    fields = parse(pinned(expected["contract_fields"]))
    return source_contract_fields(expected, fields)


def source_contract_fields(expected, fields):
    require(isinstance(fields, dict) and not {"schema_version", "freshness"} & fields.keys(),
            "new_contract_fields_required")
    for key in ("cli", "runtime", "workspace", "coordinator"):
        require(fields.get(key) == expected[key], "strict_prepare_contract_binding_mismatch")
    require(fields.get("skill_read_evidence") in exact_refs(expected["readiness_evidence"]),
            "strict_start_readiness_evidence_required")
    session_contract_value(fields)  # Reject a Run binding; never silently discard it.
    if "domain_binding" in fields:
        from software_development import scoped_json
        task = scoped_json(fields["domain_binding"]["contract"], fields["observation"]["roots"])
        if "task_deadline" in expected:
            require(expected["task_deadline"] == task["policy"]["deadline"],
                    "software_deadline_changed")
    return fields


def observed_coordinator(value, initial):
    observation = parse(pinned(value["session_observation"]))
    require(isinstance(observation, dict) and type(observation.get("schema_version")) is int
            and observation["schema_version"] == 1,
            "strict_config_session_observation_invalid")
    caller = initial["caller"]
    sid = observation.get("thread_id")
    require(isinstance(sid, str) and UUID.fullmatch(sid) is not None
            and observation.get("session_id") == sid,
            "strict_config_provider_session_required")
    require(observation.get("runtime_id") == value["runtime"]
            and observation.get("effective", {}).get("cwd") == value["workspace"]["path"],
            "strict_config_observation_scope_mismatch")
    kind = observation.get("kind")
    adapter = kind_adapter(kind) if isinstance(kind, str) else None
    if adapter is not None:
        binding = observation["binding"]
        terminal = binding["terminal"]
        require(observation.get("adapter") == adapter
                and observation.get("caller_receipt") == value["caller_receipt"]
                and binding["runtime"]["runtimeId"] == value["runtime"]
                and binding["session_id"] == sid,
                "strict_config_observation_binding_mismatch")
        require(caller["processIncarnation"] == terminal["ptyId"] + ":" + terminal["incarnationId"],
                "strict_config_incarnation_mismatch")
    elif kind in ("trae_startup_anchor", "trae_session_observation"):
        require(observation.get("run_id") is None, "strict_config_observation_has_run")
        terminal = observation["terminal"]
    else:
        raise StrictCheckError("strict_config_session_observation_unsupported")
    require(terminal["handle"] == caller["terminalHandle"]
            and terminal["worktreeId"] == value["workspace"]["id"]
            and terminal["tabId"] + ":" + terminal["leafId"] == caller["paneKey"]
            and terminal.get("executionHostId") == "local"
            and caller["hostScope"].get("kind") == "local",
            "strict_config_observation_caller_mismatch")
    require(caller["processIncarnation"].rsplit(":", 1)[-1] == terminal["incarnationId"],
            "strict_config_incarnation_mismatch")
    return {"terminal": terminal["handle"], "incarnation": terminal["incarnationId"], "session": sid}


class BootstrapError(ValueError):
    def __init__(self, state, reason):
        super().__init__(reason)
        self.state = state


def require(condition, reason, state="blocked_invalid_marker"):
    if not condition:
        raise BootstrapError(state, reason)


def shape(value, keys, reason="invalid_schema"):
    require(isinstance(value, dict) and set(value) == set(keys), reason)


def text(value):
    return isinstance(value, str) and bool(value.strip()) and "\0" not in value


def version(value, kind, keys):
    shape(value, {"schema_version", "kind", *keys})
    require(type(value["schema_version"]) is int and value["schema_version"] == 1,
            "unsupported_schema")
    require(value["kind"] == kind, "unexpected_kind")


class EvidenceReader:
    """Scope before reads; remember bytes to reject changes across a check."""

    def __init__(self):
        self.refs = {}

    def exists(self, target):
        return os.path.lexists(target)

    def reference(self, target):
        return {"path": target, "sha256": digest(read_bytes(target))}

    def read(self, ref, expected, *, json_value=True):
        validate_ref(ref)
        require(ref["path"] == expected, "unexpected_pin_path", "blocked_stale_or_mismatch")
        prior = self.refs.get(expected)
        require(prior is None or prior == ref, "conflicting_pin", "blocked_marker_conflict")
        raw = pinned(ref)
        self.refs[expected] = dict(ref)
        return parse(raw) if json_value else raw

    def recheck(self):
        for ref in self.refs.values():
            pinned(ref)


def observation_supported(observation, expected_adapter=None):
    """The observation must belong to the TUI adapter it claims.

    The adapter->kind mapping lives in `tui_adapter`; a literal kind list here is how
    a Pi observation got refused after it had already been committed. An internally
    consistent observation is still not enough: the pair must also be the adapter the
    declared coordinator provider can attest, or a Trae-shaped observation would be
    accepted on a Pi attempt (same defect class, opposite direction).
    """
    if not isinstance(observation, dict):
        return False
    kind = observation.get("kind")
    adapter = kind_adapter(kind) if isinstance(kind, str) else None
    return (adapter is not None and observation.get("adapter") == adapter
            and (expected_adapter is None or adapter == expected_adapter))


def binding(reader, root, sha, attempt):
    ref = {"path": str(root / "attempt-binding.json"), "sha256": sha}
    value = reader.read(ref, ref["path"])
    version(value, "strict_bootstrap_binding", {
        "attempt_id", "runtime", "workspace", "coordinator", "operator", "paths",
        "created_at", "deadline", "context_max_age_seconds", "fixed_inputs",
        "authorization_refs", "file_tool_evidence_paths", "control", "execution_authorized"})
    require(text(attempt) and value["attempt_id"] == attempt, "attempt_mismatch",
            "blocked_stale_or_mismatch")
    require(text(value["runtime"]) and value["execution_authorized"] is False,
            "invalid_binding")
    shape(value["workspace"], {"id", "path"})
    require(text(value["workspace"]["id"]), "invalid_workspace")
    path(value["workspace"]["path"], directory=True)
    shape(value["coordinator"], {"terminal", "incarnation", "process_incarnation", "pane_key", "agent"})
    shape(value["operator"], {"terminal", "incarnation", "provider", "session"})
    # Why: the coordinator's provider is declared evidence, not a constant. The owner
    # binds the pane for whichever provider this build can verify for a bootstrap role;
    # hardcoding Trae refused every Pi coordinator after its registration was accepted.
    from provider_capability import BOOTSTRAP_ROLE, declared
    coordinator_capability = declared(value["coordinator"]["agent"])
    require(all(text(v) for v in value["coordinator"].values())
            and all(text(v) for v in value["operator"].values())
            and coordinator_capability is not None
            and not coordinator_capability.missing(BOOTSTRAP_ROLE)
            and value["coordinator"]["terminal"] != value["operator"]["terminal"],
            "invalid_or_nonindependent_identity")
    require(value["coordinator"]["process_incarnation"].rsplit(":", 1)[-1]
            == value["coordinator"]["incarnation"], "incarnation_mismatch")
    require(value["paths"] == layout(root), "fixed_layout_mismatch")
    seconds = value["context_max_age_seconds"]
    # New contracts use the existing v2 builder's fixed 30-minute policy.
    require(type(seconds) is int and seconds == 1800, "invalid_context_window")
    require(timestamp(value["created_at"]) < timestamp(value["deadline"]), "invalid_deadline")
    shape(value["control"], {"backend", "control_id", "generation"})
    require(value["control"]["backend"] == BACKEND
            and all(text(v) for v in value["control"].values()), "unsupported_control_backend")
    fixed = value["fixed_inputs"]
    shape(fixed, {"cli", "runtime_config", "role_skill", "handoff", "skill_read_evidence"})
    for key, item in fixed.items():
        validate_ref(item)
        expected = value["paths"][key] if key == "skill_read_evidence" else item["path"]
        reader.read(item, expected, json_value=False)
    require(isinstance(value["authorization_refs"], list) and value["authorization_refs"],
            "authorization_refs_required")
    for item in exact_refs(value["authorization_refs"]):
        reader.read(item, item["path"], json_value=False)
    probes = value["file_tool_evidence_paths"]
    require(isinstance(probes, list) and all(text(p) for p in probes)
            and len(set(probes)) == len(probes), "invalid_file_tool_paths")
    for item in probes:
        target = Path(item)
        require(target.is_absolute() and str(target) == item and ".." not in target.parts
                and target.is_relative_to(root / "coordinator")
                and item not in value["paths"].values(), "invalid_file_tool_path")
    return ref, value


def contract_fields(b, source, fields):
    """Shared candidate/marker validation; no publishing or approval."""
    require(isinstance(fields, dict) and all(fields.get(k) == v for k, v in b["fixed_inputs"].items())
            and fields.get("operator") == b["operator"], "contract_fixed_inputs_mismatch")
    observation = fields.get("observation")
    require(isinstance(observation, dict) and observation.get("caller_receipt") == source["caller_receipt"]
            and observation.get("startup_anchor") == source["session_observation"],
            "contract_observation_mismatch")
    provisional = dict(source, readiness_evidence=[b["fixed_inputs"]["skill_read_evidence"]])
    return build_session_contract(source_contract_fields(provisional, fields))


def review(reader, b, binding_ref, stage, upstream, subjects, evidence, earliest, clock, *, require_approval=True):
    """Validate declarations and exact linkage; never claim review authenticity."""
    paths = b["paths"]
    request_path, result_path = paths[stage + "_review_request"], paths[stage + "_review"]
    request_ref = reader.reference(request_path)
    request = reader.read(request_ref, request_path)
    version(request, "strict_bootstrap_review_request", {
        "request_id", "attempt_binding", "stage", "upstream", "subject_refs", "evidence_refs",
        "operator", "result_path", "created_at", "deadline", "execution_authorized"})
    require(request["request_id"] == b["attempt_id"] + ":" + stage
            and request["attempt_binding"] == binding_ref and request["stage"] == stage
            and request["upstream"] == upstream and request["subject_refs"] == subjects
            and request["evidence_refs"] == evidence and request["operator"] == b["operator"]
            and request["result_path"] == result_path and request["deadline"] == b["deadline"]
            and request["execution_authorized"] is False, "review_request_mismatch")
    for item in exact_refs(subjects + evidence):
        reader.read(item, item["path"], json_value=False)
    result_ref = reader.reference(result_path)
    result = reader.read(result_ref, result_path)
    version(result, "strict_bootstrap_review_result", {
        "request", "subject_refs", "evidence_refs", "operator", "decision", "notes",
        "reviewed_at", "identity_verified", "execution_authorized"})
    require(result["request"] == request_ref and result["subject_refs"] == subjects
            and result["evidence_refs"] == evidence and result["operator"] == b["operator"]
            and result["identity_verified"] is False and result["execution_authorized"] is False
            and text(result["notes"]) and len(result["notes"].encode()) <= 16384,
            "review_result_mismatch")
    require(earliest <= timestamp(request["created_at"]) <= timestamp(result["reviewed_at"])
            <= clock, "review_time_mismatch")
    require(result["decision"] in {"approve", "reject"}, "invalid_review_decision")
    if require_approval:
        require(result["decision"] == "approve", "operator_rejected", "blocked_review_rejected")
    return result_ref, timestamp(result["reviewed_at"])


def _check(root, sha, attempt, clock, result, *, reader=None):
    reader = EvidenceReader() if reader is None else reader
    binding_ref, b = binding(reader, root, sha, attempt)
    created, deadline = timestamp(b["created_at"]), timestamp(b["deadline"])
    require(created <= clock, "binding_from_future", "blocked_stale_or_mismatch")
    result["attempt_binding"] = binding_ref
    result["control"] = b["control"]
    paths = b["paths"]
    previous = None
    previous_time = created
    initial = None
    source = {key: b[key] for key in ("runtime", "workspace")}
    source["cli"] = b["fixed_inputs"]["cli"]
    validated = []
    for index, event in enumerate(EVENTS):
        target = paths[event]
        if not reader.exists(target):
            # A later fixed slot cannot be treated as a harmless pending input.
            require(not any(reader.exists(paths[later]) for later in EVENTS[index + 1:]),
                    "marker_sequence_gap")
            result.update(state="pending_" + event.replace("-", "_"), pending_stage=event,
                          missing=[target], producer=PRODUCERS[index])
            break
        ref = reader.reference(target)
        marker = reader.read(ref, target)
        common = {"event", "attempt_id", "sequence", "attempt_binding", "created_at",
                  "producer", "execution_authorized"}
        extra = (
            {"runtime", "workspace", "coordinator", "caller_receipt", "context"},
            {"consumes", "runtime", "workspace", "coordinator", "caller_receipt",
             "session_observation", "trust_boundary", "requires_live_caller_check"},
            {"consumes", "contract_fields", "review_receipt", "must_match"},
            {"consumes", "readiness_evidence", "evidence_roles", "required_refs"},
        )[index]
        version(marker, "strict_bootstrap_event", common | extra)
        require(marker["event"] == event and type(marker["sequence"]) is int
                and marker["sequence"] == index + 1 and marker["attempt_id"] == attempt
                and marker["attempt_binding"] == binding_ref and marker["producer"] == PRODUCERS[index]
                and marker["execution_authorized"] is False, "marker_binding_mismatch")
        marker_time = timestamp(marker["created_at"])
        require(previous_time <= marker_time <= clock and marker_time < deadline,
                "marker_time_mismatch", "blocked_stale_or_mismatch")
        if previous is not None:
            require(marker["consumes"] == dict(previous, event=EVENTS[index - 1]),
                    "upstream_pin_mismatch", "blocked_marker_conflict")
        if index <= 1:
            require(marker["runtime"] == b["runtime"] and marker["workspace"] == b["workspace"],
                    "marker_identity_mismatch", "blocked_stale_or_mismatch")
            source["caller_receipt"] = marker["caller_receipt"]
            caller = reader.read(source["caller_receipt"], paths["caller_receipt"])
            current = caller_result(caller, b["runtime"])
            expected = b["coordinator"]
            require(current["caller"]["terminalHandle"] == expected["terminal"]
                    and current["caller"]["paneKey"] == expected["pane_key"]
                    and current["caller"]["processIncarnation"] == expected["process_incarnation"]
                    and current["caller"]["hostScope"].get("kind") == "local",
                    "caller_identity_mismatch", "blocked_stale_or_mismatch")
            checked = timestamp(current["checkedAt"])
            require(created <= checked <= marker_time and clock - checked
                    <= timedelta(seconds=b["context_max_age_seconds"]),
                    "caller_stale_or_future", "blocked_stale_or_mismatch")
            if index == 0:
                initial = current
                shape(marker["context"], {"context_max_age_seconds", "requires_live_caller_check"})
                require(marker["coordinator"] == {k: expected[k] for k in ("terminal", "incarnation", "agent")}
                        and type(marker["context"]["context_max_age_seconds"]) is int
                        and marker["context"]["context_max_age_seconds"] == b["context_max_age_seconds"]
                        and marker["context"]["requires_live_caller_check"] is True, "caller_marker_mismatch")
            else:
                require(current == initial, "caller_changed", "blocked_stale_or_mismatch")
                source["session_observation"] = marker["session_observation"]
                observation = reader.read(source["session_observation"], paths["session_observation"])
                require(observation.get("caller_receipt") == source["caller_receipt"],
                        "observation_caller_pin_mismatch")
                from provider_capability import declared
                capability = declared(b["coordinator"]["agent"])
                require(observation_supported(observation, capability.tui_adapter
                                              if capability is not None else None),
                        "unsupported_observation_adapter")
                observed = timestamp(observation["observed_at"])
                require(observed <= marker_time and clock - observed
                        <= timedelta(seconds=b["context_max_age_seconds"]),
                        "observation_stale_or_future", "blocked_stale_or_mismatch")
                source["coordinator"] = observed_coordinator(source, initial)
                require(marker["coordinator"] == source["coordinator"]
                        and marker["trust_boundary"] == "runtime-state-and-log-not-live-process-attested"
                        and marker["requires_live_caller_check"] is True, "observation_marker_mismatch")
        elif index == 2:
            source["contract_fields"] = marker["contract_fields"]
            fields = reader.read(source["contract_fields"], paths["contract_fields"])
            contract_fields(b, source, fields)
            require(marker["must_match"] == {"runtime": b["runtime"], "workspace_id": b["workspace"]["id"],
                                              "coordinator_terminal": source["coordinator"]["terminal"]},
                    "contract_marker_mismatch")
            evidence = [source["caller_receipt"], source["session_observation"],
                        b["fixed_inputs"]["skill_read_evidence"]]
            reviewed, reviewed_at = review(reader, b, binding_ref, "contract", previous,
                                          [source["contract_fields"]], evidence, previous_time, clock)
            require(marker["review_receipt"] == reviewed and reviewed_at <= marker_time,
                    "contract_review_pin_mismatch")
        else:
            refs = exact_refs(marker["readiness_evidence"])
            require(isinstance(refs, list) and refs, "empty_readiness_evidence")
            expected_paths = [paths["skill_read_evidence"], *b["file_tool_evidence_paths"],
                              paths["final_readiness"], paths["readiness_review"]]
            require([r["path"] for r in refs] == expected_paths, "readiness_paths_or_order_mismatch")
            for item, expected in zip(refs, expected_paths):
                reader.read(item, expected, json_value=False)
            require(refs[0] == b["fixed_inputs"]["skill_read_evidence"], "skill_pin_mismatch")
            manifest = reader.read(refs[-2], paths["final_readiness"])
            version(manifest, "strict_bootstrap_readiness", {
                "attempt_binding", "contract_fields", "evidence", "created_at", "execution_authorized"})
            require(manifest["attempt_binding"] == binding_ref
                    and manifest["contract_fields"] == source["contract_fields"]
                    and manifest["evidence"] == refs[:-2] and manifest["execution_authorized"] is False,
                    "readiness_manifest_mismatch")
            manifest_at = timestamp(manifest["created_at"])
            require(previous_time <= manifest_at <= marker_time, "readiness_time_mismatch")
            reviewed, reviewed_at = review(reader, b, binding_ref, "readiness", previous,
                                          [refs[-2]], refs[:-2], manifest_at, clock)
            require(refs[-1] == reviewed and reviewed_at <= marker_time, "readiness_review_pin_mismatch")
            roles = marker["evidence_roles"]
            require(isinstance(roles, list), "invalid_evidence_roles")
            seen = []
            for role in roles:
                shape(role, {"ref", "role"})
                validate_ref(role["ref"])
                require(role["ref"] in refs and role["ref"] not in seen and text(role["role"]),
                        "invalid_evidence_role_ref")
                seen.append(role["ref"])
            shape(marker["required_refs"], {"skill_read_evidence_present", "file_tool_probe_evidence_present"})
            require(marker["required_refs"]["skill_read_evidence_present"] is True
                    and marker["required_refs"]["file_tool_probe_evidence_present"]
                    is bool(b["file_tool_evidence_paths"]),
                    "required_refs_mismatch")
            source["readiness_evidence"] = refs
            source_contract(source)
        validated.append(ref)
        result["last_validated_stage"] = event
        previous, previous_time = ref, marker_time
    reader.recheck()
    require(clock < deadline, "attempt_deadline_expired", "blocked_deadline_exceeded")
    result["validated_markers"] = validated
    result["evidence_chain_complete"] = len(validated) == len(EVENTS)
    if result["evidence_chain_complete"]:
        result.update(state="durability_unverified", reason="confirmation_and_live_admission_unavailable",
                      request_input_preview={k: source[k] for k in (
                          "caller_receipt", "session_observation", "contract_fields", "readiness_evidence")})
    result["ok"] = True  # Diagnostic succeeded; NOT an executable success/ready signal.
    return result


def check_state(bootstrap, *, attempt_binding_sha256, expect_attempt, clock=None):
    result = dict(ok=False, kind="strict_bootstrap_state", schema_version=1,
                  state="blocked_invalid_marker", diagnostic_only=True, ready=False,
                  execution_authorized=False, identity_verified=False,
                  last_committed_stage=None, last_validated_stage=None, pending_stage=None,
                  evidence_chain_complete=False, missing=[],
                  capability_gaps=["confirmation_adapter_not_connected", "live_admission_not_connected",
                                   "review_provenance_not_attested"])
    try:
        root = path(bootstrap, directory=True)
        return _check(root, attempt_binding_sha256, expect_attempt,
                      timestamp(now()) if clock is None else clock, result)
    except BootstrapError as exc:
        result.update(state=exc.state, reason=str(exc))
    except FilePinChanged:
        result.update(state="blocked_stale_or_mismatch", reason="file_pin_changed")
    except PermissionError:
        result.update(state="blocked_permission_denied", reason="evidence_access_denied")
    except FileNotFoundError:
        result.update(reason="binding_or_committed_reference_missing")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        # Native strings / malformed evidence contents must not leak to diagnostics.
        result.update(reason="invalid_or_unreadable_evidence")
    return result


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--expect-attempt", required=True)
    parser.add_argument("--attempt-binding-sha256", required=True)
    parser.add_argument("--check", action="store_true", required=True)
    args = parser.parse_args(argv)
    result = check_state(args.bootstrap, attempt_binding_sha256=args.attempt_binding_sha256,
                         expect_attempt=args.expect_attempt)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(cli_main())
