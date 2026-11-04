"""Versioned mechanical role actions. No business decisions or native execution.

The action table is shared by tool dispatch, owner slot allocation and plans.
Descriptions are presentation only; immutable intents pin machine data, not prose.
"""

from dataclasses import dataclass, asdict
from pathlib import Path
import sys

from coordinator_io import require


@dataclass(frozen=True)
class Action:
    actor: str
    target: str
    mode: str
    markers: int
    input_schema: str


ACTIONS = {
    "caller-intent": Action("coordinator", "caller_receipt", "produce", 0, "none"),
    "observe-intent": Action("operator", "session_observation", "produce", 1, "none"),
    "fields-intent": Action("operator", "contract_fields", "submit", 2, "new-session-fields"),
    "contract-intent": Action("operator", "contract_review", "submit", 2, "strict-review-result-v1"),
    "final-evidence-intent": Action("coordinator", "final_readiness", "readiness", 3, "ordered-probe-refs"),
    "readiness-intent": Action("operator", "readiness_review", "submit", 3, "strict-review-result-v1"),
}
SUBMIT_TARGETS = {name: spec.target for name, spec in ACTIONS.items() if spec.mode == "submit"}


def completion_slot(root, name):
    require(name in ACTIONS, "bootstrap_action_binding_mismatch")
    return str(Path(root) / "control" / (name.removesuffix("-intent") + "-submission.json"))


def submission(binding, name):
    """v2: one candidate per final output; readiness never asks to write finals."""
    spec = ACTIONS[name]
    require(spec.mode in {"submit", "readiness"}, "bootstrap_action_requires_specialized_tool")
    from bootstrap_control import slots_for
    final = binding["paths"][spec.target]
    targets = [final] if spec.mode == "submit" else binding["file_tool_evidence_paths"]
    outputs = [dict(candidate_path=str(Path(p).with_name(Path(p).stem + ".candidate.json")),
                    final_path=p) for p in targets]
    candidates = [item["candidate_path"] for item in outputs]
    require(len(candidates) == len(set(candidates)) and not set(candidates) & slots_for(binding).keys(),
            "bootstrap_candidate_reserved_path")
    return dict(schema_version=2, action=name, actor=spec.actor, mode=spec.mode,
                input_schema=spec.input_schema, final_path=final, final_writer="commit_owner",
                outputs=outputs,
                **({"candidate_path": candidates[0]} if spec.mode == "submit" else {}))


def command(owner_ref, actor, mode, intent_ref):
    args = [sys.executable, "-B", str(Path(__file__).resolve().with_name("coordinator_launch.py")),
            "strict-bootstrap", mode, "--owner", owner_ref["path"], "--owner-sha256", owner_ref["sha256"],
            "--actor", actor, "--intent", intent_ref["path"], "--intent-sha256", intent_ref["sha256"]]
    return args + (["--execute"] if mode == "complete" else [])


def plan_actions(binding):
    return [dict(action=name, **asdict(spec),
                 **({"submission": submission(binding, name)} if spec.mode != "produce" else {}))
            for name, spec in ACTIONS.items()]


def plan_stages():
    result = []
    for name, spec in ACTIONS.items():
        work = {"produce": "complete runs the original mechanical producer",
                "submit": "materialize fixed fields from candidate_template" if name == "fields-intent" else "independently review and fill candidate_template judgment fields",
                "readiness": "perform real probes into submission.outputs candidate paths; complete publishes probes/manifest"}[spec.mode]
        if spec.mode == "submit":
            work += "; file tools write submission.candidate_path; complete validates and submits it"
        result.append(f"{spec.actor}: pull {name} -> {work}; use returned complete_argv, unknown -> inspect_argv")
    return result
