"""Provider-independent lifecycle text and structural checkpoint checks.

No scheduling, authority grants, evidence authentication or native state access.
Adapters must ALSO verify domain evidence, authority, identity, real dependencies
and action receipts. The input is a shared subset of the existing checkpoint,
not a replacement schema or an automatic migration of historical records.
"""

from dataclasses import dataclass
import json
from pathlib import Path
import shlex
import sys



def _strict_request_version_text():
    return ("Use input schema v4 with reviewed contract_fields pin and task_source pin and separate "
            "recovery_note; it generates request schema v5.")


OWNERSHIP = (
    "For an explicitly delegated goal-oriented task, the Coordinator owns business "
    "decisions across phases: decompose work, dispatch Workers, synthesize evidence "
    "and decide continue/wait/blocked/complete against the original acceptance. "
    "The Operator owns startup/recovery gates, identity/authority checks, escalation "
    "and delivery audit, not per-turn business planning. An explicitly delegated "
    "Operator action does not transfer business ownership. A supported driver only "
    "continues the same Coordinator serially, wakes dependencies and deduplicates "
    "actions; an observer is read-only and never resumes, dispatches or consumes Inbox. "
    "This contract adds no scope, budget, permissions or automatic executor. "
    "Repository role restrictions still apply; taking action may require delegation "
    "rather than direct experiment edits or submission by the Coordinator. "
    "A user's one-shot request stays within its original acceptance; do not expand its goal. "
)

PHASES = {
    "strict-tui-bootstrap": (
        "Phase: strict-tui-bootstrap. Keep this native Trae TUI process alive across model turns. "
        "Continuation ownership is fixed by its config: schema v1 uses model enqueue as described below; "
        "schema v2 with scheduler overrides ALL self-enqueue instructions: publish an immutable domain-checked "
        "checkpoint with the source observed_at from this real turn, atomically update checkpoint_head, "
        "settle and ACK prior work, then END the model turn. The Operator monitor checks real task_complete "
        "and enqueues; do not call enqueue or wait for its message inline. check/claim/settle and live "
        "action freshness remain mandatory. Before ending every schema v2 turn, including a duplicate or "
        "external-message wakeup, run coordinator_tui_continue.py turn-end with the original config pins. "
        "It audits that the head belongs to this current real turn; check alone does not. This audit is "
        "not the scheduler trigger or a runtime-enforced turn-end hook. On refusal, revalidate domain "
        "evidence and publish a new immutable checkpoint/receipt from this turn; never rewrite timestamps. "
        "Initialize schema v2 immediately after gates with coordinator_tui_prepare.py --inputs <pinned-inputs> "
        "--inputs-sha256 <sha256> --execute: it derives projection, head and config from a genuine "
        "authorized-progress checkpoint/receipt and publishes continuation-ref.json last. Do not handwrite "
        "these derived files or defer initialization until after long Worker waits. Initialize only once; "
        "duplicate initialization messages must keep the published config, state and deadline, process "
        "native mail, and update only the current domain-checked checkpoint/head, not create a new journal. "
        "Operator observes the fixed publication without sending repeated initialization reminders. Operator prepares "
        "the pinned inputs except source/receipt, and activates operator_monitor_deploy after publication. "
        "For explicitly opted-in startups, Operator uses operator_startup.py to persistently observe that "
        "publication and execute monitor prepare/run/verify with fixed sender/state. Pass its pinned "
        "startup_lifecycle through initialization inputs; turn-end then checks unified readiness before "
        "autonomous waiting. On operator_readiness_required, Operator resumes that same lifecycle; do not "
        "rewrite a valid domain checkpoint to fix infrastructure. Prepared is not started, and monitor_ready "
        "is not autonomy_verified; real two-cycle acceptance remains separate. "
        "For wait actions, put exact native references orca-dispatch:<ID> and/or orca-job:<operation-key> "
        "in next_action.prerequisites before domain checking; do not add a dependencies field to RSI. "
        "Reference only real dispatched Workers/registered Jobs, never future placeholders. Independent "
        "actionable paths must remain actionable; ready technical gates cannot claim dependency_running. "
        "A dependency wake only authorizes rechecking that wait, not inventing work. "
        "turn-end and the scheduler share the progress check: three settled actions without a newly met "
        "requirement require review. turn-end refuses before yield without writing a stop; the scheduler "
        "independently checks after the real turn ends. New processing files, changed action IDs and "
        "readiness statements do not reset this bound. If evidence really supports acceptance advancement, "
        "revalidate through the domain checker and publish a new immutable source/receipt/projection; "
        "never auto-mark met. An already persisted scheduler stop requires independent review and is "
        "not cleared by a corrected checkpoint, new config or monitor restart. "
        "For an idle-wakeup acceptance trial, publish the legal checkpoint and END the turn; do not "
        "consume worker_done with inline wait. Independently observe idle before triggering the event, "
        "isolate other wake sources, and prove a new turn, full processing and ACK. A non-hit is not PASS. "
        "After native settlement, attempt final usage/trace capture while the Worker terminal is still "
        "bound, before worker-release. Record collection gaps explicitly, do not substitute an early "
        "snapshot or claim process-final usage from runtime-state evidence. Never delay settlement "
        "or retry permission denials for accounting. "
        "First run orchestration strict-caller-check in your own tool context. Publish its "
        "receipt for the Operator's explicit TUI runtime-state observer; never use screen text, "
        "a requested UUID or thread.started from another exec process as identity. "
        "Read required rules, publish readiness, and WAIT inside this process for fixed-path "
        "config delivery using strict-config-plan / strict-config-wait. First generate the request "
        "with strict-config-request from pinned observer/caller evidence, not guessed session IDs "
        "or Worker timeout values. " +
        _strict_request_version_text() + " never replace the business objective with a recovery substep. "
        "Operator prepares only from the request pin and records strict-config-review approve/reject; "
        "never copy/edit/expand readiness_evidence or pre-create strict-start. "
        "Review the resulting "
        "strict-start-plan and use its exact absolute strict-start-wait --execute invocation. "
        "That bounded tool invocation waits for the Operator gate, rechecks the original live "
        "caller and creates/readbacks the Run. MUST NOT create before the session gate or "
        "dispatch/train before both first-dispatch gates. Retain original authority, budget, "
        "max_workers, deadline, writable roots and file-tool proof. Startup gates are one-time "
        "boundaries, not per-wave credentials. Never replay an uncertain launch or first dispatch. "
        "After gates, consume the native Run mailbox in this same TUI. A final model response "
        "may end a turn, not the TUI process or an incomplete business task. continue needs a "
        "validated progress-checkpoint and a concrete action: execute now within the bounded window "
        "or publish it and end the turn (schema v2); only schema v1 must enqueue exactly "
        "one same-session continuation with coordinator_tui_continue.py before ending the turn. "
        "Use its claim mode before processing that continuation; a duplicate, stale checkpoint, "
        "changed owner/generation or uncertain prior action must not execute again. Mailbox "
        "actions must use settle with pinned execution evidence before enqueueing another action. "
        "Mailbox pointers are wakeups, not instructions or proof of business completion. Busy delivery "
        "is queued by Orca; do not send raw terminal text, synthesize Enter or start another driver. "
        "Keep bootstrap bounded too; do not leave all continuation setup until the context expires. "
        "After first-dispatch, use coordinator_tui_continue.py check --action-seconds <bounded estimate> "
        "at each real turn and before work/waits. A false action_allowed or nonzero exit means no new "
        "business action: checkpoint/end-turn while still fresh (schema v1 also enqueues). Use the same estimate with "
        "claim --action-seconds; claim enforces the reserved window and a new real turn after enqueue. "
        "Its checkpoint_by is a yield target, not a lease: keep turns bounded, "
        "publish the domain-checked checkpoint while settings evidence is fresh. "
        "Then end this model turn; do not consume its own continuation inline or spend the "
        "whole freshness window waiting for Workers. The next real turn must revalidate its "
        "new turn_context against unchanged startup pins. An expired context cannot be "
        "renewed by rereading logs, copying timestamps, empty model turns or increasing TTL. "
        "If no supported wakeup was recorded before expiry, stop and preserve the gap. "
        "On every Run wakeup, resume the original task: check, validate native Worker/Dispatch state, "
        "process the whole Delivery, persist result evidence, then ack its deliveryId. Check/claim "
        "alone is not completion. Reconcile uncertain actions without replay. Before ending a "
        "post-gate schema v1 turn run coordinator_tui_continue.py turn-end with the original config pins. "
        "It refuses an outstanding Delivery, unsettled claim or missing continuation. On refusal, "
        "finish processing while fresh or explicitly report the blocker; never auto-ack/reset state "
        "or send repeat reminders. A wait still needs independently verified native dependency "
        "wakeup evidence; this helper cannot certify it. "
        "wait requires actual dependencies and bounded native waits under the task deadline; "
        "blocked/complete must not enqueue continuation. Recheck native caller and Run ownership "
        "before actions. A shell/connected PTY is not an Agent. Exit/lost identity stops writes: "
        "strict-v1 has no safe shell resume, replacement, rebind or crash takeover. Preserve "
        "receipts and report the recovery gap. TUI is not daemon/service recovery. "
    ),
    "strict-bootstrap": (
        "Phase: strict-bootstrap. This is one continuous native Coordinator process. "
        "First run orchestration strict-caller-check from your own tool context; stop on "
        "failure before expensive bootstrap work. Before verbose rule output, wait under "
        "the task deadline for the Operator to capture/pin the native startup anchor; "
        "do not flood the startup stream while its only identity event is unarchived. "
        "Read the required rules and publish "
        "readiness evidence including the strict-caller-check result for the Operator to "
        "independently pin, then WAIT inside this process for fixed-path config delivery "
        "using strict-config-plan / strict-config-wait before the Operator session gate. "
        "First use strict-config-request with pinned observer/caller evidence and a separate "
        "handshake deadline; never derive identity from paneKey or use Worker timeout_ms. " +
        _strict_request_version_text() + " "
        "never replace the business objective with a recovery substep. "
        "Operator runs strict-start-prepare from only the request pin, then strict-config-review "
        "approve/reject and strict-config-publish; never copy/edit/expand readiness_evidence "
        "or pre-create strict-start. "
        "the receiver validates prepared-inputs source-to-snapshot mappings and returns a "
        "plan for your review, never a command supplied by a publication. Terminal text "
        "input is not a supported follow-up channel for trae exec --json. "
        "Do not end the exec process to hand control back to a shell. MUST NOT create a Run "
        "before that gate; MUST NOT dispatch Workers or train before both first-dispatch gates. "
        "After all preparation, use the exact absolute strict-start-wait --execute invocation "
        "from the reviewed strict-start-plan. Keep this single native tool invocation alive: "
        "it publishes readiness, waits for the Operator's immutable gate publication, runs "
        "strict-session-check and creates/readbacks the strict Run without another model turn. "
        "Operator must audit readiness before strict-start-publish; never glob for gate files "
        "or overwrite a failed receipt. Missing executable/config pins stop before waiting. "
        "Do not execute separate model-mediated check/create commands against a running TTL. "
        "Startup and first-dispatch gates are one-time phase boundaries, not per-wave checks. "
        "Never replay a started attempt or re-run first-dispatch after Workers exist; reconcile "
        "native state and preserved receipts. Later authorized waves still require live native "
        "identity/owner/generation and progress checks, not refreshed startup credentials. "
        "Repeat strict-caller-check before first dispatch. "
        "Retain the original authorization and max_workers; execute the authorized goal only "
        "after the existing Operator and Coordinator first-dispatch checks. Use only already "
        "authorized writable roots for the exact Run archive. Missing roots or expired gates "
        "stop the affected operation, not widen permissions or create an ordinary Run. "
        "Use bounded waits under the approved task deadline; never run an unbounded busy loop. "
        "If this native process exits, strict-v1 has no supported shell resume, replacement "
        "or takeover. Preserve the checkpoint and report the recovery gap without relaunch. "
    ),
    "bootstrap": (
        "Phase: bootstrap. Verify the actual independent session before any Run exists. "
        "MUST NOT create or bind a Run. MUST NOT dispatch Workers or train. Return the startup "
        "receipt and end this bootstrap turn at the startup gate, not the business task. "
        "After Operator session-gate verification, the same Coordinator receives a "
        "separately prepared native Run-create handoff. "
    ),
    "recovery": (
        "Phase: recovery. Reconcile existing attempts, pending launches and original "
        "ownership before further execution. Preserve unknown outcomes and capacity; "
        "never blindly replay, reset counters or copy identity. Only after verified "
        "recovery gates may the valid Coordinator return to the run phase and its "
        "pending checkpoint; recovery itself is not business completion. "
        "A recovery plan does not provide native takeover support. If the selected "
        "runtime or Run policy cannot safely recover, stop the affected launch/write "
        "path and report the gap without changing the business decision. "
    ),
    "run": (
        "Phase: run. After required startup/recovery gates, execute the goal loop: "
        "act, collect evidence, progress-checkpoint, then act again within authorization. "
        "Intermediate reports, status messages and a model turn/process ending do not "
        "independently prove task completion. At each checkpoint review ALL "
        "original requirements and actionable/waiting/blocked paths. Use an exact "
        "decision: continue, wait, blocked or complete; do not infer it from free-form "
        "text. continue requires a concrete next owner/action and actual "
        "execution receipt, not merely another plan or a hand-back to the Operator. "
        "If a model turn must end, persist the checkpoint for the supported driver "
        "to continue the same Coordinator; do not claim a driver exists without evidence. "
        "wait requires no independent actionable path plus exact dependencies and "
        "wakeup conditions. A local blocker must not hide independent authorized work. "
        "Before global wait/blocked, distinguish limits on scientific claims from blocked "
        "operations. Review useful authorized prerequisite work separately: source/provenance "
        "inspection, extraction feasibility, alternative measurement or a concrete validation "
        "design. State what uncertainty the next action resolves and what existing artifact it "
        "advances; do not repeat a completed specification to stay busy. A missing output or a "
        "plan still owned by the Coordinator is not by itself an external running dependency. "
        "Use the repository's operational checkpoint schema and checker from the first business "
        "turn, not a custom status string. Validate and correct it before handing off a turn. "
        "blocked requires evidence of the remaining boundaries and alternatives review; "
        "complete requires evidence for every original acceptance requirement. "
        "Keep business decision separate from executor state: identity failure, unknown "
        "execution and bounded no-progress stop the affected executor, not automatically "
        "turn the goal into blocked/complete. Preserve receipts and counters across restart. "
    ),
    "closeout": (
        "Phase: closeout. Audit the Coordinator's evidenced conclusion against the "
        "original acceptance or real boundary, settle resources, archive evidence and "
        "reconcile usage/coverage gaps. A wait parks with its wakeup; it is not completion. "
        "A continue checkpoint cannot enter final closeout. If verification finds a gap, "
        "return it to the valid Coordinator or the recovery gate, not Operator replanning. "
    ),
}


def phase_contract(phase, root=None):
    """Shared text for the actual provider handoff and driver continuation.

    `root` names the helper tree this contract points at. It defaults to this
    module's own tree; a materials pipeline that pins another reviewed tree passes
    it so the contract never advertises a helper from a different checkout.
    """
    if phase not in PHASES:
        raise ValueError("unsupported_coordinator_phase")
    root = Path(root) if root is not None else Path(__file__).resolve().parent
    worker_contract = ""
    if phase in ("strict-bootstrap", "strict-tui-bootstrap", "recovery", "run"):
        entry = shlex.join([sys.executable, "-B", str(root / "coordinator_launch.py")])
        worker_contract = (
            " Before authorized worker-start, use " + entry + " worker-plan --request <absolute JSON> "
            "--request-sha256 <sha256>; schema: "
            + str(root / "coordinator-worker-plan.md") + ". "
            "Use request schema_version=2; choose only model, never agent/effort/backend_variant. "
            "Use the Operator-reviewed profiles_sha256 and SWARM_WORKER_PROFILES canonical path "
            "with the same environment for planning, dispatch and receipt verification; only an "
            "unset variable uses worker-model-profiles.json beside the helper. It supplies fixed "
            "launch settings. Do not edit profiles, substitute a config "
            "path, downgrade to schema v1 or bypass a blocked profile with raw worker-start. "
            "Review and use its argv unchanged, not an ad hoc command builder. Existing workspace "
            "placement uses exact id: and forbids name/repo/base_branch/display_name/comment/setup; "
            "task_title with spec names a Task, not a worktree. Planning is offline, not authorization "
            "or a dispatch receipt; native identity/capacity/gates and unknown-outcome rules still apply. "
            "For the first Worker of a startup-gated v2 Run, one fixed private state_root is required; "
            "the legacy chain embeds first_dispatch with contract and operator_gate pins in the request. "
            "Execute the returned first-dispatch helper argv, never a raw worker-start: it rechecks "
            "the Coordinator gate and starts once in the same tool invocation. An expired or short "
            "Operator gate needs an explicit Operator recheck against the original session receipt; "
            "reuse the same live Coordinator/Run/contract and preserve old receipts. Do not refresh "
            "as Operator from the Coordinator context, restart, or change TTL. A dispatch intent or "
            "unknown result requires reconciliation, not another state directory or retry. After a "
            "confirmed first dispatch, later waves omit first_dispatch and use normal live checks. "
            "Prefer the prepared chain: fix the contract, a plain Worker request without first_dispatch "
            "and one private state_root in an immutable package, run first-dispatch-prepare for a "
            "reviewable READY, then let the Operator issue the fresh gate and execute exactly one "
            "first-dispatch --package/--ready/--operator-gate call. Planning and review must finish "
            "before the gate; a 180-second receipt must not cover them. Package slot, READY and intent "
            "are a local workflow fence, not a server-side exactly-once guarantee; schema: "
            + str(root / "coordinator-startup.md") + ". "
        )
    return OWNERSHIP + PHASES[phase] + worker_contract


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    # Preserve JSON distinctions (e.g. true versus 1) when checking immutable input.
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def references(value):
    return isinstance(value, list) and bool(value) and all(nonempty(v) for v in value)


def rows(value, label):
    require(isinstance(value, list), "invalid_" + label)
    require(all(isinstance(row, dict) and nonempty(row.get("id")) for row in value),
            "invalid_" + label)
    indexed = {row["id"]: row for row in value}
    require(len(indexed) == len(value), "duplicate_" + label)
    return indexed


@dataclass(frozen=True)
class Route:
    decision: str
    kind: str
    owner: str | None = None


def checkpoint_route(record, contract):
    """Validate shared structure without inventing/correcting a business decision.

    Domain adapters may project their records to this subset. References here are
    declarations only; the adapter must authenticate evidence and bind live waits.
    Unknown owners yield an executor stop, preserving the business decision.
    """
    require(isinstance(record, dict) and isinstance(contract, dict), "invalid_checkpoint")
    decision = record.get("decision")
    require(isinstance(decision, str) and decision in {"continue", "wait", "blocked", "complete"},
            "invalid_checkpoint_decision")
    original = rows(contract.get("requirements"), "contract_requirements")
    requirements = rows(record.get("requirements"), "requirements")
    require(original and original.keys() == requirements.keys(), "acceptance_requirements_changed")
    for key, spec in original.items():
        item = requirements[key]
        require(all(k in item and canonical(item[k]) == canonical(v) for k, v in spec.items()),
                "acceptance_requirements_changed")
        require(item.get("status") in ("met", "actionable", "waiting", "blocked"),
                "invalid_requirement_status")
        if item["status"] == "met":
            require(isinstance(item.get("evidence"), list) and item["evidence"],
                    "acceptance_evidence_missing")
    unmet = {key for key, item in requirements.items() if item["status"] != "met"}
    paths = rows(record.get("paths"), "paths")
    barriers = rows(record.get("barriers"), "barriers")
    for path in paths.values():
        require(nonempty(path.get("requirement_id")) and path["requirement_id"] in unmet
                and nonempty(path.get("operation")),
                "path_requirement_mismatch")
        require(path.get("status") in ("actionable", "waiting", "blocked"), "invalid_path_status")
        if path["status"] in {"waiting", "blocked"}:
            require(nonempty(path.get("barrier_id")), "path_boundary_evidence_missing")
            barrier = barriers.get(path.get("barrier_id"), {})
            require(isinstance(barrier.get("path_ids"), list) and path["id"] in barrier["path_ids"]
                    and references(barrier.get("evidence_refs"))
                    and nonempty(barrier.get("condition")), "path_boundary_evidence_missing")
    for key in unmet:
        require(any(p["requirement_id"] == key for p in paths.values())
                or (requirements[key]["status"] == "blocked"
                    and nonempty(requirements[key].get("path_review_ref"))), "remaining_paths_missing")
    statuses = {path["status"] for path in paths.values()}
    expected = ("continue" if "actionable" in statuses else "wait" if "waiting" in statuses
                else "blocked" if unmet else "complete")
    require(decision == expected, "checkpoint_decision_conflicts_with_remaining_work")
    action = record.get("next_action")
    if decision in {"complete", "blocked"}:
        require(action is None, "terminal_next_action_present")
        return Route(decision, "acceptance_review" if decision == "complete" else "alternatives_review")
    require(isinstance(action, dict) and all(nonempty(action.get(k)) for k in ("id", "owner", "kind")),
            "concrete_next_action_required")
    require(references(action.get("deliverables")) and nonempty(action.get("validation")),
            "next_action_deliverables_required")
    targets = action.get("path_ids")
    require(isinstance(targets, list) and targets and all(nonempty(k) and k in paths for k in targets)
            and len(set(targets)) == len(targets), "next_action_paths_invalid")
    require(all(paths[k]["status"] == ("actionable" if decision == "continue" else "waiting")
                for k in targets), "next_action_has_no_ready_path")
    require((action["kind"] == "wait") == (decision == "wait"), "next_action_decision_mismatch")
    owner = action["owner"]
    kind = ("operator_handoff" if owner == "outer-operator" else
            "dependency_wait" if owner == "coordinator" and decision == "wait" else
            "coordinator_turn" if owner == "coordinator" else "unsupported_executor")
    return Route(decision, kind, owner)


def transition(before, after, result, novel, reviewed_paths=()):
    """An action cannot silently retire or block unrelated work; not semantic acceptance."""
    old = rows(before["paths"], "paths")
    new = rows(after["paths"], "paths")
    targeted = set(before["next_action"]["path_ids"]) | set(reviewed_paths)
    met = {r["id"] for r in after["requirements"] if r["status"] == "met"}
    for key, route in old.items():
        if key not in new:
            require(key in targeted and novel and result["status"] == "executed",
                    "remaining_path_disappeared")
        else:
            require(all(route[k] == new[key][k] for k in ("requirement_id", "operation")),
                    "path_identity_changed")
            if key not in targeted:
                require(not (route["status"] == "actionable" and new[key]["status"] != "actionable")
                        and not (route["status"] == "waiting" and new[key]["status"] == "blocked"),
                        "independent_path_silently_blocked")
    newly_met = met - {r["id"] for r in before["requirements"] if r["status"] == "met"}
    require(not newly_met or (novel and result["status"] == "executed"),
            "acceptance_claim_without_execution")
    if after["decision"] in {"complete", "blocked"}:
        require(novel and result["status"] == "executed", "terminal_claim_without_execution")
    if not novel and after["decision"] == "continue":
        require(canonical(before["next_action"]) == canonical(after["next_action"]),
                "action_advanced_without_execution")
