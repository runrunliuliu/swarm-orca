"""Local bootstrap checks shared by the offline driver and original request builder.

No authentication, native calls, automatic reconciliation or live-ready CLI.
An authority/adapter must independently enforce identity, freshness and STOP.
"""

from pathlib import Path

from bootstrap_events import EvidenceReader, _check, require
from coordinator_io import canonical, digest, now, parse, pinned, timestamp


def control_paths(root):
    """Control records are separate from the frozen binding layout/request v5."""
    from bootstrap_actions import ACTIONS
    names = ["request-input", "request-admission", *ACTIONS,
             "wait-contract", "wait-readiness", "downstream-intent"]
    return {name: str(root / "control" / (name + ".json")) for name in names}


def json_ref(target, value):
    return {"path": str(target), "sha256": digest(canonical(value) + b"\n")}


class ConfirmationUnavailable(ValueError):
    """Unconfirmed exact target; diagnostics route the caller, they grant nothing."""

    def __init__(self, ref, status):
        super().__init__("bootstrap_confirmation_unavailable")
        self.diagnostics = dict(target=ref["path"], sha256=ref["sha256"], status=status,
                                execution_authorized=False)


def confirmed(authority, control, ref):
    reply = authority.query(control, ref)
    if not (reply.control == control and reply.target == ref and reply.status == "confirmed"):
        # The bare code cannot say WHICH fixed slot is unconfirmed; a caller then
        # guesses (and has guessed wrong) about the stage that is actually blocked.
        raise ConfirmationUnavailable(ref, reply.status)
    pinned(ref)
    return ref


class CandidateReader(EvidenceReader):
    """Validate one not-yet-published marker with the exact read-only parser."""

    def __init__(self, target, raw):
        super().__init__()
        self.target, self.raw = target, raw
        self.ref = {"path": target, "sha256": digest(raw)}

    def exists(self, target):
        return target == self.target or super().exists(target)

    def reference(self, target):
        return self.ref if target == self.target else super().reference(target)

    def read(self, ref, expected, *, json_value=True):
        if expected != self.target:
            return super().read(ref, expected, json_value=json_value)
        require(ref == self.ref, "candidate_pin_mismatch")
        return parse(self.raw) if json_value else self.raw


def inspect_chain(control, *, clock=None, reader=None):
    root = Path(control.attempt_binding["path"]).parent
    reader = EvidenceReader() if reader is None else reader
    b = parse(pinned(control.attempt_binding))
    require(control.attempt_binding["path"] == str(root / "attempt-binding.json"),
            "bootstrap_binding_path_mismatch")
    require(b["control"]["control_id"] == control.control_id
            and b["control"]["generation"] == control.generation,
            "bootstrap_control_mismatch")  # No implicit generation recovery in Phase 2.
    result = _check(root, control.attempt_binding["sha256"], b["attempt_id"],
                    timestamp(now()) if clock is None else clock, {}, reader=reader)
    return b, result, reader


def chain_confirmations(authority, control, b, reader):
    # S0 pins are immutable inputs, not commits by this authority. Every later
    # evidence/request/marker read by the validator must have its own confirmation.
    initial = [control.attempt_binding, *b["fixed_inputs"].values(), *b["authorization_refs"]]
    refs = [r for r in reader.refs.values() if r not in initial]
    for ref in refs:
        confirmed(authority, control, ref)
    return refs


def commit_request(input_ref, prepared, admission, authority, recheck):
    """Called ONLY at the original builder's final publication seam.

    Both immutable admission association and request use the same authority.
    An association without a request remains an intent; retries must reconcile
    its original bytes, never regenerate a different handshake clock.
    """
    control = admission.control
    root = Path(control.attempt_binding["path"]).parent
    paths = control_paths(root)
    raw = canonical(prepared["value"]) + b"\n"
    request_ref = {"path": str(prepared["target"]), "sha256": digest(raw)}

    def check():
        recheck()
        b, state, reader = inspect_chain(control)
        require(state["evidence_chain_complete"]
                and state["validated_markers"][-1] == admission.readiness_marker,
                "bootstrap_readiness_mismatch")
        require(request_ref["path"] == b["paths"]["request"]
                and input_ref["path"] == paths["request-input"], "bootstrap_request_path_mismatch")
        source = prepared["source"]
        expected = dict(state["request_input_preview"], cli=b["fixed_inputs"]["cli"],
                        runtime=b["runtime"], workspace=b["workspace"])
        require(all(source.get(k) == v for k, v in expected.items()), "bootstrap_request_input_mismatch")
        task = parse(pinned(source["task_source"]))
        require(task["authorization_refs"] == b["authorization_refs"], "bootstrap_authorization_refs_mismatch")
        chain_confirmations(authority, control, b, reader)
        confirmed(authority, control, input_ref)

    check()
    association = dict(schema_version=1, kind="strict_bootstrap_request_admission",
        attempt_binding=control.attempt_binding, control_id=control.control_id,
        generation=control.generation, readiness_marker=admission.readiness_marker,
        request=request_ref, actor="coordinator", created_at=prepared["value"]["startup_window"]["prepared_at"],
        execution_authorized=False)
    association_ref = json_ref(paths["request-admission"], association)
    authority.commit_new(control, actor="coordinator", target=association_ref["path"],
        raw=canonical(association) + b"\n", prerequisites=[admission.readiness_marker, input_ref], recheck=check)
    confirmed(authority, control, association_ref)
    authority.commit_new(control, actor="coordinator", target=request_ref["path"], raw=raw,
        prerequisites=[association_ref, admission.readiness_marker, input_ref], recheck=check)
    confirmed(authority, control, request_ref)
