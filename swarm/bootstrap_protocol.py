"""Bootstrap interfaces; no production runtime adapter or launch authority.

The normative protocol and failure model are in strict-bootstrap-protocol.md.
These interfaces deliberately cannot turn a file-only check into live readiness.
"""

from dataclasses import dataclass
from typing import Callable, Literal, Protocol


BACKEND = "single-owner-memory-v1"
EVENTS = ("caller-ready", "observation-ready", "contract-fields-ready",
          "readiness-evidence-ready")
PRODUCERS = ("coordinator", "operator", "operator", "operator")
PATHS = {
    "caller_receipt": "initial-caller.json",
    "session_observation": "operator/coordinator-session-observation.json",
    "contract_fields": "operator/new-contract-fields.json",
    "fields_production_request": "operator/contract-fields-production-request.json",
    "skill_read_evidence": "coordinator/skill-read-evidence.json",
    "final_readiness": "coordinator/final-readiness-evidence.json",
    "contract_review_request": "operator/contract-fields-review-request.json",
    "contract_review": "operator/contract-fields-review.json",
    "readiness_review_request": "operator/final-readiness-review-request.json",
    "readiness_review": "operator/final-readiness-review.json",
    "request": "strict-config-request.json",
}
PATHS.update({event: f"events/{index:04d}-{event}.json"
              for index, event in enumerate(EVENTS, 1)})


def layout(root):
    return {key: str(root / relative) for key, relative in PATHS.items()}


@dataclass(frozen=True)
class ControlBinding:
    """Authenticated transport must bind these values, not trust self-report."""

    attempt_binding: dict
    control_id: str
    generation: str


@dataclass(frozen=True)
class Confirmation:
    control: ControlBinding
    target: dict
    status: Literal["confirmed", "not_committed", "durability_unverified"]


@dataclass(frozen=True)
class RequestAdmission:
    """Explicit Phase-2 builder argument; never serialized into request v5.

    At commit, bind the prepared request pin to this exact S4 marker and control.
    The same control remains responsible for supported strict-start operations.
    """

    control: ControlBinding
    readiness_marker: dict


@dataclass(frozen=True)
class OperatorDelivery:
    """Transport status is not approval or proof of the Operator's live identity."""

    request: dict
    status: Literal["new", "submitted", "input_accepted", "turn_started", "completed", "unknown"]
    native_receipt: dict | None


class OperatorScheduler(Protocol):
    """Phase-2 adapter seam for pinned production/review requests.

    Delivery intent must be committed before submit; unknown acceptance is
    queried under the same request ID, not retried or sent to another session.
    Binding, provenance and safe-point checks are adapter responsibilities.
    """

    def submit(self, control: ControlBinding, request: dict) -> OperatorDelivery: ...

    def query(self, control: ControlBinding, request: dict) -> OperatorDelivery: ...


class CommitAuthority(Protocol):
    """One serial owner; no model/native query inside the short commit boundary.

    The supported builder retains preparation and live checks, delegating only
    its final publish to commit_new with its actor and S4 pins. Implementations
    MUST enforce local identity/authorization snapshot validity for every commit,
    independently of the caller-supplied recheck. Phase 2 uses a test authority.
    Query is read-only. It is neither a lease nor permission for a later commit.
    """

    def query(self, control: ControlBinding, target: dict) -> Confirmation: ...

    def commit_new(self, control: ControlBinding, *, actor: str, target: str,
                   raw: bytes, prerequisites: list[dict],
                   recheck: Callable[[], None]) -> Confirmation: ...

    def stop(self, control: ControlBinding) -> None: ...

    def reconcile(self, control: ControlBinding, *, target: dict,
                  recheck: Callable[[], None]) -> Confirmation: ...


def review_route(*, delivery, session, stopped=False, decision=None,
                 safe_point_supported=False):
    """Pure routing table, NOT delivery, approval, identity verification or retry.

    A submitted/unknown request is reconciled by its original ID, never resent.
    The caller must persist intent under admission BEFORE using a route and
    recheck the exact original Operator, pins and competing input at acceptance.
    """
    if delivery not in {"new", "submitted", "input_accepted", "turn_started",
                        "completed", "unknown"}:
        raise ValueError("invalid_review_delivery")
    if session not in {"tool_wait", "busy", "idle", "unknown"}:
        raise ValueError("invalid_operator_session_state")
    if stopped:
        return "stop"
    if decision is not None:
        if decision not in {"approve", "reject"} or delivery != "completed":
            raise ValueError("invalid_review_decision")
        return "validate_review" if decision == "approve" else "blocked_review_rejected"
    if delivery == "completed":
        return "reconcile_result"
    if delivery in {"submitted", "input_accepted", "unknown"} or session == "unknown":
        return "reconcile_delivery"
    if delivery == "turn_started":
        return "await_result"
    if session == "tool_wait":
        return "return_tool_for_review"
    if session == "busy":
        return "defer_to_safe_point"
    return "request_safe_point" if safe_point_supported else "blocked_operator_resume_unsupported"
