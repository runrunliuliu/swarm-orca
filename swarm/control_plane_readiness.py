#!/usr/bin/env python3
"""Report, read-only, whether a project can start swarm work on this host.

Contract: docs/deploy/control-plane-publish.md §6. Four blocks are reported: the
control plane in use, the skills this agent can actually read, the project's own
material, and the plan that would be used. Nothing is created, launched or written;
`max_workers` is always reported as unconfirmed because only the user may set it.

Exit codes: 0 ready, 2 usage, 78 blocked (the report lists the reasons).
"""

import argparse
import json
import sys
from pathlib import Path

from deploy.publish_control_plane import Failure, inspect_artifact

EXIT_BLOCKED = 78

REQUIRED_SKILLS = ("orca-cli", "orchestration", "swarm-orchestration", "worktree-delivery")

# Universal inputs every execution path needs; adapters are reported but not required here.
REQUIRED_CONFIG = ("coordinator-model.json", "worker-model-profiles.json")
ADAPTER_CONFIG = ("coordinator-runtime.json", "trae-coordinator-tui-runtime.json",
                  "trae-coordinator-runtime.json")

AGENT_SKILL_DIRS = {
    "agents": ("~/.agents/skills",),
    "pi": ("~/.agents/skills",),
    "claude": ("~/.claude/skills", "~/.agents/skills"),
    "codex": ("~/.codex/skills",),
    "trae": ("~/.trae/skills",),
}

PROJECT_ROLE_SKILL_DIRS = (".agents/skills", ".trae/skills", ".claude/skills", ".codex/skills")


def frontmatter_name(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not text.startswith("---"):
        return None
    for line in text.splitlines()[1:]:
        if line.strip() == "---":
            break
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip("\"'")
    return None


def skill_block(agent, override=None):
    candidates = [Path(override).expanduser()] if override else \
        [Path(item).expanduser() for item in AGENT_SKILL_DIRS.get(agent, AGENT_SKILL_DIRS["agents"])]
    directory = next((path for path in candidates if path.is_dir()), None)
    block = {"agent": agent, "directory": str(directory) if directory else None,
             "required": {}, "missing": [], "mismatched": []}
    if directory is None:
        block["missing"] = list(REQUIRED_SKILLS)
        return block
    for name in REQUIRED_SKILLS:
        path = directory / name / "SKILL.md"
        if not path.is_file():
            block["missing"].append(name)
            continue
        declared = frontmatter_name(path)
        resolved = str(path.resolve())
        if declared != name:
            block["mismatched"].append({"name": name, "declared": declared})
        block["required"][name] = {"path": resolved, "declared": declared}
    return block


def project_block(project):
    block = {"path": str(project), "agentsMd": (project / "AGENTS.md").is_file(),
             "bindingFile": (project / ".orca" / "swarm-binding.json").is_file(),
             "roleSkills": []}
    for relative in PROJECT_ROLE_SKILL_DIRS:
        base = project / relative
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if (child / "SKILL.md").is_file():
                block["roleSkills"].append("%s/%s" % (relative, child.name))
    return block


def control_plane(*, pointer=None, directory=None):
    """Resolve the control plane without ever searching parent directories."""
    if directory:
        root, source = Path(directory).expanduser().resolve(), "argument"
        if not root.is_dir():
            return {"state": "invalid", "path": str(root), "reason": "control-plane-missing",
                    "source": source}
        if not (root / ".swarm-build.json").is_file():
            return dev_checkout(root, source)
        try:
            report = inspect_artifact(root)
        except Failure as error:
            return {"state": "invalid", "path": str(root), "reason": str(error), "source": source}
        return released(root, report, source)
    root = Path(pointer or "/opt/swarm/current").expanduser()
    if not root.is_symlink():
        state = "missing" if not root.exists() else "invalid"
        reason = "pointer-missing" if state == "missing" else "pointer-not-a-symlink"
        return {"state": state, "path": str(root), "reason": reason, "source": "pointer"}
    if not root.exists():
        return {"state": "dangling", "path": str(root), "reason": "pointer-dangling",
                "source": "pointer"}
    target = root.resolve()
    try:
        report = inspect_artifact(target)
    except Failure as error:
        if str(error).startswith("identity-missing"):
            checkout = dev_checkout(target, "pointer")
            if checkout["state"] == "dev-checkout":
                return checkout
        return {"state": "invalid", "path": str(target), "reason": str(error), "source": "pointer"}
    return released(target, report, "pointer")


def released(root, report, source):
    return {"state": "ok", "path": str(root), "buildId": report.get("buildId"),
            "identityKind": report.get("identityKind"), "source": source,
            "sourceTree": report.get("source"), "reason": None}


def dev_checkout(root, source):
    layout = (root / "swarm-orca" / "swarm").is_dir() or (root / "swarm").is_dir()
    if not layout:
        return {"state": "invalid", "path": str(root), "reason": "not-a-control-plane-or-source-root",
                "source": source}
    return {"state": "dev-checkout", "path": str(root), "buildId": None, "source": source,
            "sourceTree": None,
            "reason": "variable source checkout: usable for local trials, never as a pin source"}


def config_inputs(plane):
    """Report the inputs the launch plan would use; missing required files block."""
    root = Path(plane["path"])
    if plane["state"] == "dev-checkout":
        code, config_dir = root / "swarm-orca" / "swarm", root / "swarm"
    else:
        code, config_dir = root / "code", root / "private"
    block = {"codeRoot": str(code), "configDir": str(config_dir),
             "launcher": ((code / "coordinator_launch.py").is_file()
                          and not (code / "coordinator_launch.py").is_symlink()),
             "codeSymlink": code.is_symlink(),
             "required": {}, "adapters": {}, "missing": []}
    for name in REQUIRED_CONFIG:
        path = config_dir / name
        block["required"][name] = {"path": str(path), "present": path.is_file(),
                                   "sha256": sha256(path) if path.is_file() else None}
        if not path.is_file():
            block["missing"].append(name)
    for name in ADAPTER_CONFIG:
        path = config_dir / name
        if path.is_file():
            block["adapters"][name] = {"path": str(path), "sha256": sha256(path)}
    if not block["launcher"]:
        block["missing"].append("coordinator_launch.py")
    return block

def sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plan_block(config, project):
    argv = [sys.executable, "-B",
            str(Path(config["codeRoot"]) / "coordinator_launch.py"),
            "--model-config", config["required"]["coordinator-model.json"]["path"]]
    return {"argv": argv, "env": {"SWARM_WORKER_PROFILES":
                                  config["required"]["worker-model-profiles.json"]["path"]},
            "cwd": str(project), "maxWorkers": "unconfirmed: the user must confirm a positive integer",
            "note": "plan only: this tool never launches an Agent, a Run or a service"}


def blocking_reasons(plane, skills, project, config, require_pin, expected=None):
    reasons = []
    if plane["state"] in ("invalid", "dangling"):
        reasons.append("control-plane-%s: %s" % (plane["state"], plane.get("reason")))
    if plane["state"] == "missing":
        reasons.append("control-plane-missing: no pointer and no --control-plane")
    if plane["state"] == "dev-checkout" and require_pin:
        reasons.append("control-plane-dev-checkout: not a pin source")
    if plane["state"] == "ok" and require_pin:
        if plane.get("identityKind") != "provenance":
            reasons.append("control-plane-legacy-identity: provenance is not bound to the buildId")
        tree = plane.get("sourceTree") or {}
        if tree.get("dirty"):
            reasons.append("control-plane-dirty: published from a modified source")
        if tree.get("unpinned"):
            reasons.append("control-plane-unpinned: published without a pinned source")
    reasons += ["skills-missing: %s" % name for name in skills["missing"]]
    reasons += ["skills-name-mismatch: %s" % item["name"] for item in skills["mismatched"]]
    if not project["agentsMd"]:
        reasons.append("project-agents-missing: %s" % project["path"])
    reasons += ["config-missing: %s" % name for name in config["missing"]]
    if config.get("codeSymlink"):
        reasons.append("config-symlink: %s" % config.get("codeRoot"))
    for name, digest in (expected or {}).items():
        entry = config["required"].get(name) or config["adapters"].get(name)
        if entry is None:
            reasons.append("config-unexpected: %s" % name)
        elif (entry.get("sha256") or "").lower() != digest.lower():
            reasons.append("config-hash-mismatch: %s" % name)
    return reasons


def expected_config_hashes(pairs):
    """Parse `--expect-config name=sha256`; a malformed pair is a usage error, not a pass."""
    expected = {}
    for pair in pairs or []:
        name, _, digest = pair.partition("=")
        if not name or len(digest) != 64:
            raise ValueError("expected NAME=<64 hex sha256>, got %r" % pair)
        expected[name] = digest
    return expected


def report(args):
    project = Path(args.project).expanduser().resolve()
    plane = control_plane(pointer=args.pointer, directory=args.control_plane)
    skills = skill_block(args.agent, args.skills_dir)
    project_info = project_block(project)
    config = config_inputs(plane) if plane["state"] in ("ok", "dev-checkout") else \
        {"codeRoot": None, "configDir": None, "launcher": False, "required": {},
         "adapters": {}, "missing": []}
    reasons = blocking_reasons(plane, skills, project_info, config, args.require_pin,
                               expected_config_hashes(args.expect_config))
    if args.artifacts:
        artifacts = Path(args.artifacts).expanduser()
        if not artifacts.is_dir():
            reasons.append("artifacts-dir-missing: %s" % artifacts)
    return {"ready": not reasons,
            "controlPlane": plane,
            "skills": skills,
            "project": project_info,
            "config": config,
            "plan": plan_block(config, project) if not reasons else None,
            "blocking": reasons}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", required=True, help="project directory to report on")
    parser.add_argument("--pointer", default=None, help="control-plane symlink (default /opt/swarm/current)")
    parser.add_argument("--control-plane", default=None,
                        help="explicit artifact directory or dev source root; skips the pointer")
    parser.add_argument("--agent", default="agents", choices=sorted(AGENT_SKILL_DIRS),
                        help="which agent's skill installation to report")
    parser.add_argument("--skills-dir", default=None, help="override the skill directory (tests, audits)")
    parser.add_argument("--artifacts", default=None, help="artifact/evidence root that must exist")
    parser.add_argument("--expect-config", action="append", default=[], metavar="NAME=SHA256",
                        help="require this config file's sha256; repeatable")
    parser.add_argument("--require-pin", action="store_true",
                        help="block a dev checkout; request a pinned, released control plane")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        expected_config_hashes(args.expect_config)
    except ValueError as error:
        parser.error(str(error))
    result = report(args)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        plane = result["controlPlane"]
        print("ready: %s" % ("yes" if result["ready"] else "no"))
        print("control plane: %s %s" % (plane["state"], plane.get("path")))
        print("skills: %s/%d missing=%s"
              % (result["skills"]["agent"], len(result["skills"]["required"]),
                 result["skills"]["missing"] or "none"))
        print("project: AGENTS.md=%s binding=%s roleSkills=%d"
              % (result["project"]["agentsMd"], result["project"]["bindingFile"],
                 len(result["project"]["roleSkills"])))
        if result["plan"]:
            print("plan: %s" % " ".join(result["plan"]["argv"]))
            print("max_workers: %s" % result["plan"]["maxWorkers"])
        for reason in result["blocking"]:
            print("blocked: %s" % reason)
    return 0 if result["ready"] else EXIT_BLOCKED


if __name__ == "__main__":
    sys.exit(main())
