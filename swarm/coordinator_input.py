"""Pin and render the actual Coordinator stdin, without modifying its task brief.

Planning is read-only. Capture persists these exact bytes before spawning; an old
metadata-only plan is not silently upgraded. No authority or execution is added.
"""

import hashlib
from pathlib import Path

from coordinator_loop import phase_contract, require


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(plan, brief):
    phase = "recovery" if plan["phase"] == "replacement" else plan["phase"]
    fragment = plan.get("prompt_fragment")
    require(isinstance(fragment, str) and phase_contract(phase) in fragment,
            "phase_contract_missing_from_input")
    brief.decode("utf-8")  # Fail before launching, not inside the child.
    return ("# Coordinator phase contract\n" + fragment +
            "\n\n# Authorized task handoff\n").encode("utf-8") + brief


def bind_prompt(plan, prompt_file):
    """Return a new, reviewable plan; never write the source brief or launch files."""
    prompt = Path(prompt_file)
    require(prompt.is_absolute(), "absolute_prompt_required")
    prompt = prompt.resolve(strict=True)
    brief = prompt.read_bytes()
    bound = dict(plan, prompt_file=str(prompt), command=None)
    stdin = render(bound, brief)
    bound["input_contract"] = {
        "schema_version": 1, "brief_sha256": digest(brief),
        "fragment_sha256": digest(bound["prompt_fragment"].encode("utf-8")),
        "stdin_sha256": digest(stdin),
    }
    return bound


def input_bytes(plan):
    spec = plan.get("input_contract")
    require(isinstance(spec, dict) and set(spec) == {
        "schema_version", "brief_sha256", "fragment_sha256", "stdin_sha256"}
        and type(spec["schema_version"]) is int and spec["schema_version"] == 1,
        "pinned_input_contract_required")
    require(plan.get("command") is None, "raw_prompt_command_not_supported")
    prompt = Path(plan["prompt_file"])
    require(prompt.is_absolute() and prompt.resolve(strict=True) == prompt and prompt.is_file(),
            "canonical_prompt_required")
    brief = prompt.read_bytes()
    require(digest(brief) == spec["brief_sha256"], "prompt_changed_since_planning")
    stdin = render(plan, brief)
    require(digest(plan["prompt_fragment"].encode("utf-8")) == spec["fragment_sha256"]
            and digest(stdin) == spec["stdin_sha256"], "input_contract_changed")
    return stdin
