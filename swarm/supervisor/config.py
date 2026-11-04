"""Explicit authorization and immutable, self-contained task contracts."""

import hashlib
import json
import re
from pathlib import Path, PurePosixPath


class SafetyError(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise SafetyError(message)


def positive(value):
    return type(value) is int and value > 0


def exact_id(value):
    return (isinstance(value, str) and bool(value.strip()) and value == value.strip()
            and not any(x in value for x in ("<", ">", "\n", "\r", "\0")))


def text_list(value, *, nonempty=True):
    return isinstance(value, list) and (bool(value) or not nonempty) and all(
        isinstance(v, str) and bool(v.strip()) for v in value)


def relative_path(value):
    return (isinstance(value, str) and value not in ("", ".")
            and not PurePosixPath(value).is_absolute()
            and ".." not in PurePosixPath(value).parts
            and not any(c in value for c in "*?[\n\r\0"))


def overlap(left, right):
    a, b = PurePosixPath(left), PurePosixPath(right)
    return a == b or a in b.parents or b in a.parents


def validate(config, *, live=False):
    require(config.get("schema_version") == 1, "schema_version must be 1")
    require(re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", config.get("goal_id", "")), "invalid goal_id")
    require(isinstance(config.get("objective"), str) and config["objective"].strip(), "objective is required")
    runtime = config["runtime"]
    require(Path(runtime["cli"]).is_absolute(), "runtime.cli must be an absolute, fixed executable")
    require("/REPLACE/" not in runtime["cli"], "replace runtime.cli template before use")
    require(".orca-relay" not in runtime["cli"], "desktop relay cannot host a Swarm")
    require(exact_id(runtime.get("runtime_id")), "verify and set runtime_id")
    require(runtime.get("version") == "1.4.219", "only Orca 1.4.219 is currently supported")
    require(exact_id(runtime.get("repo_id")), "verify and set repo_id")
    require(exact_id(runtime.get("coordinator_worktree_id")), "set coordinator_worktree_id")
    require(runtime["coordinator_worktree_id"].startswith(runtime["repo_id"] + "::/"),
            "coordinator workspace must belong to the exact repository")
    require(re.fullmatch(r"[0-9a-f]{40}", config.get("base_commit", ""))
            and set(config["base_commit"]) != {"0"}, "base_commit must be a real full SHA")
    require(Path(config["state_dir"]).is_absolute(), "state_dir must be absolute")
    require(Path(config["artifact_dir"]).is_absolute(), "artifact_dir must be absolute")
    require(all(str(Path(config[k])) == str(Path(config[k]).resolve()) for k in ("state_dir", "artifact_dir")),
            "state/artifact paths must be canonical and symlink-free")
    require(not overlap(config["state_dir"], config["artifact_dir"]), "private state and artifacts must be separate")

    limits = config["limits"]
    require(type(limits.get("implementation_concurrency")) is int
            and 1 <= limits["implementation_concurrency"] <= 2, "MVP implementation concurrency must be 1..2")
    for name in ("total_concurrency", "max_run_launches", "max_service_launches", "max_run_seconds",
                 "max_run_micro_usd", "max_service_micro_usd", "max_period_micro_usd", "period_seconds",
                 "coordinator_reservation_micro_usd", "worker_reservation_micro_usd", "max_failures",
                 "poll_seconds", "max_round_seconds"):
        require(positive(limits.get(name)), f"set positive limits.{name}; no unbounded defaults")
    require(limits.get("max_task_retries") == 0 and limits.get("max_model_upgrades") == 0,
            "MVP retries and model upgrades require manual re-planning; set both to 0")
    require(limits["poll_seconds"] <= 60, "poll_seconds must be <= 60")
    require(limits["max_round_seconds"] <= limits["max_run_seconds"], "round limit exceeds run limit")
    require(limits["total_concurrency"] >= limits["implementation_concurrency"], "invalid concurrency limits")

    roles = config["agents"]
    trust = config.get("trae_workspace_trust", {"enabled": False})
    require(isinstance(trust, dict) and type(trust.get("enabled")) is bool,
            "trae_workspace_trust.enabled must be boolean")
    if trust["enabled"]:
        require(all(exact_id(trust.get(k)) for k in ("hostname", "username", "trae_home")),
                "pin Trae trust hostname, username and trae_home")
        require(Path(trust["trae_home"]).is_absolute(), "trae_home must be an absolute directory")
        require(trust.get("launch_context_confirmed") is True,
                "confirm worker launch account/TRAE_HOME and exclusive config writer before enabling trust")
    for role in ("coordinator", "implementation", "review", "integration"):
        agent = roles[role]
        require(exact_id(agent.get("agent")), f"select agents.{role}.agent")
        require(all(agent.get(k) is None or exact_id(agent[k]) for k in ("model", "effort")), "invalid model/effort")
        require(not agent.get("effort") or agent.get("model"), "effort requires an explicit model")
        if agent.get("model"):
            require(agent["agent"] in ("codex", "claude", "cursor", "antigravity", "muse"),
                    "agent does not support launch model overrides")

    tasks = config["tasks"]
    require(isinstance(tasks, list) and 1 <= len(tasks) <= 100, "tasks must contain 1..100 contracts")
    keys = set()
    ancestry = {}
    for task in tasks:
        key = task.get("key", "")
        require(re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", key) and key not in keys, "invalid/duplicate task key")
        require(task.get("role") in ("implementation", "review", "integration"), "invalid task role")
        deps = task.get("depends_on", [])
        require(isinstance(deps, list) and len(set(deps)) == len(deps) and all(d in keys for d in deps),
                "contracts must be topologically ordered; missing dependency or cycle")
        ancestors = set(deps)
        for dep in deps:
            ancestors.update(ancestry[dep])
        ancestry[key] = ancestors
        keys.add(key)
        require(isinstance(task.get("goal"), str) and task["goal"].strip()
                and text_list(task.get("constraints")), "task goal and constraints are required")
        require(text_list(task.get("references", []), nonempty=False), "references must be a text list")
        owned = task.get("allowed_paths", [])
        protected = task.get("do_not_touch", [])
        require(isinstance(owned, list) and isinstance(protected, list), "path lists required")
        require(all(relative_path(p) for p in owned + protected), "use explicit repository-relative paths")
        require(not any(overlap(a, b) for a in owned for b in protected), "allowed and protected paths overlap")
        require(owned or task["role"] == "review", "writing tasks must declare owned paths")
        require(task["role"] != "review" or not owned, "reviews are read-only, fresh-context tasks")
        require(text_list(task.get("acceptance", {}).get("commands"))
                and text_list(task["acceptance"].get("expected_results")),
                "observable acceptance commands and expected_results are required")
        place = task["placement"]
        require(place.get("kind") in ("new-top-level", "exact"), "ambiguous placement is forbidden")
        if place["kind"] == "exact":
            require(exact_id(place.get("worktree_id"))
                    and place["worktree_id"].startswith(runtime["repo_id"] + "::/"), "invalid exact workspace")
            require(place["worktree_id"] != runtime["coordinator_worktree_id"], "do not edit coordinator workspace")
        else:
            require(re.fullmatch(r"[a-z][a-z0-9-]{0,60}", place.get("name", "")), "invalid worktree name")
        if task["role"] == "integration":
            require(any(t["role"] == "review" and t["key"] in ancestors for t in tasks),
                    "integration must depend on an independent review")
            require(place["kind"] == "exact", "integration requires a preverified exact integration workspace")
    for task in tasks:
        if task["role"] == "implementation":
            require(any(t["role"] == "review" and task["key"] in ancestry[t["key"]] for t in tasks),
                    "each implementation needs a downstream independent review")
    require(any(t["role"] == "integration" for t in tasks), "a final integration/test task is required")
    final = tasks[-1]
    require(final["role"] == "integration" and ancestry[final["key"]] == keys - {final["key"]},
            "the final integration must depend transitively on every task")
    names = [t["placement"]["name"] for t in tasks if t["placement"]["kind"] == "new-top-level"]
    require(len(names) == len(set(names)), "new worktree names must be unique")
    for i, task in enumerate(tasks):
        for other in tasks[i + 1:]:
            a, b = task["placement"], other["placement"]
            if a["kind"] == b["kind"] == "exact" and a["worktree_id"] == b["worktree_id"]:
                require(task["key"] in ancestry[other["key"]], "shared exact workspace tasks must be ordered")
            if task["key"] not in ancestry[other["key"]]:
                require(not any(overlap(x, y) for x in task["allowed_paths"] for y in other["allowed_paths"]),
                        "parallel tasks need disjoint ownership, even in separate branches")

    if live:
        auth = config.get("authorization", {})
        require(config.get("enabled") is True, "configuration is disabled")
        for name in ("remote_host_confirmed", "persistent_storage_confirmed", "independent_auth_confirmed",
                     "pilot_scope_approved", "spend_approved", "admission_budget_not_provider_cap_accepted"):
            require(auth.get(name) is True, f"authorization.{name} requires operator confirmation")
        for name in ("state_dir", "artifact_dir"):
            resolved = Path(config[name]).resolve()
            require(not any(overlap(str(resolved), root) for root in ("/tmp", "/private/tmp", "/var/tmp")),
                    f"{name} cannot use temporary storage")
            require(len(resolved.parts) >= 4, f"{name} must name a dedicated directory")
    return config


def load(path, *, live=False):
    with open(path, encoding="utf-8") as source:
        config = json.load(source)
    return validate(config, live=live)


def execution_sandbox_permissions(config, role):
    """Version the execution contract so old escalation evidence is not reinterpreted."""
    contract = config.get("launch_contract")
    require(isinstance(contract, dict) and type(contract.get("schema_version")) is int
            and contract["schema_version"] == 2,
            "launch_contract_missing: capture schema_version 2 approval and CLI evidence before launching")
    roles = contract.get("roles")
    require(isinstance(roles, dict) and isinstance(roles.get(role), dict), "launch_contract_invalid_role")
    mode = roles[role].get("sandbox_permissions", "use_default")
    require(mode in ("use_default", "require_escalated"), "invalid_sandbox_permissions:" + role)
    return mode


def task_spec(config, task, prerequisites):
    """Pass only this contract plus immutable upstream evidence, never chat history."""
    return json.dumps({
        "task_key": task["key"], "role": task["role"], "goal": task["goal"],
        "artifact_dir": str(Path(config["artifact_dir"]) / config["goal_id"] / task["key"]),
        "base_commit": config["base_commit"], "ownership": {
            "allowed_paths": task["allowed_paths"], "do_not_touch": task["do_not_touch"]},
        "execution_contract": {
            "orca_cli": config["runtime"]["cli"],
            "required_sandbox_permissions": execution_sandbox_permissions(config, task["role"]),
            "default_execution": "For use_default, omit sandbox_permissions or use use_default if the tool "
                                 "supports it; do not request escalation or change the sandbox/approval policy.",
            "on_conflict": "Stop and report; never replace this CLI with bare orca/orca-ide, "
                           "override higher-priority policy, automatically escalate after denial, "
                           "or bypass access restrictions using another tool."},
        "constraints": task["constraints"] + [
            "No production deploys, training, external messages, new agents, or main-branch pushes.",
            "Ask the coordinator about scope/interface conflicts; never expand scope.",
            "Follow the live Orca preamble; worker_done exactly once with explicit outcome, then idle."],
        "acceptance": task["acceptance"], "references": task.get("references", []),
        "prerequisites": prerequisites,
        "deliverables": ["Full commit SHA/patch and base SHA", "Tests, results and evidence paths",
                         "Unresolved risks; review verdict or integrated commit when applicable"],
    }, ensure_ascii=False, indent=2)
