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
import os
import socket
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


OVERRIDE_SCHEMA_VERSION = 1
OVERRIDE_KEYS = frozenset({"schemaVersion", "label", "hostnames", "verifiedOn", "paths",
                           "runtime", "projectSetups"})
OVERRIDE_PATH_KEYS = ("worktreeBase", "artifactRoot", "serverCli")


def default_override_path():
    return Path("/opt/swarm/hosts") / ("%s.json" % socket.gethostname())


def host_override(path):
    """Validate the host-local values; never invent, merge silently or search directories."""
    target = Path(path).expanduser() if path else default_override_path()
    block = {"state": "missing", "path": str(target), "label": None, "sha256": None,
             "paths": {}, "pathsResolved": {}, "runtime": {}, "projectSetups": {},
             "explicit": bool(path), "reasons": []}
    if not target.is_file():
        block["reasons"].append("host-override-missing: %s" % target)
        return block

    def refuse(reason):
        block["state"] = "invalid"
        block["reasons"].append(reason)
        return block

    try:
        data = load_strict_json(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return refuse("host-override-invalid-json: %s" % error)
    if not isinstance(data, dict):
        return refuse("host-override-invalid-json: not an object")
    unknown = sorted(set(data) - OVERRIDE_KEYS)
    if unknown:
        return refuse("host-override-unknown-key: %s" % ", ".join(unknown))
    if data.get("schemaVersion") != OVERRIDE_SCHEMA_VERSION:
        return refuse("host-override-schema-unsupported: %r" % data.get("schemaVersion"))
    hostnames = data.get("hostnames")
    if not isinstance(hostnames, list) or not hostnames \
            or not all(isinstance(item, str) and item for item in hostnames):
        return refuse("host-override-invalid-value: hostnames must be a non-empty list of strings")
    if socket.gethostname() not in hostnames:
        return refuse("host-override-host-mismatch: %s not in %s"
                      % (socket.gethostname(), hostnames))
    paths = data.get("paths", {})
    if not isinstance(paths, dict):
        return refuse("host-override-invalid-value: paths")
    resolved_paths = {}
    for name, value in sorted(paths.items()):
        if name not in OVERRIDE_PATH_KEYS:
            return refuse("host-override-unknown-key: paths.%s" % name)
        if not isinstance(value, str) or not value.startswith("/"):
            return refuse("host-override-not-absolute: paths.%s" % name)
        target_path = Path(value)
        if target_path.is_symlink():
            return refuse("host-override-symlink: paths.%s" % name)
        if name == "serverCli":
            if not (target_path.is_file() and os.access(target_path, os.X_OK)):
                return refuse("host-override-server-cli-not-executable: %s" % value)
        elif not target_path.is_dir():
            return refuse("host-override-path-missing: paths.%s" % name)
        resolved_paths[name] = str(target_path.resolve())
    runtime = data.get("runtime", {})
    if not isinstance(runtime, dict):
        return refuse("host-override-invalid-value: runtime")
    for name, value in sorted(runtime.items()):
        if not isinstance(value, str) or not value:
            return refuse("host-override-invalid-value: runtime.%s" % name)
    setups = data.get("projectSetups", {})
    if not isinstance(setups, dict):
        return refuse("host-override-invalid-value: projectSetups")
    for name, value in sorted(setups.items()):
        if not isinstance(value, str) or not value:
            return refuse("host-override-invalid-value: projectSetups.%s" % name)
    block.update(state="ok", label=data.get("label"), sha256=sha256(target),
                 paths=dict(paths), pathsResolved=resolved_paths, runtime=dict(runtime),
                 projectSetups=dict(setups))
    return block


def load_strict_json(text):
    """Parse JSON but refuse duplicate keys: last-wins would hide what the hash covers."""
    def no_duplicates(pairs):
        seen = {}
        for key, value in pairs:
            if key in seen:
                raise ValueError("duplicate key %r" % key)
            seen[key] = value
        return seen
    return json.loads(text, object_pairs_hook=no_duplicates)


def report(args):
    project = Path(args.project).expanduser().resolve()
    plane = control_plane(pointer=args.pointer, directory=args.control_plane)
    skills = skill_block(args.agent, args.skills_dir)
    project_info = project_block(project)
    config = config_inputs(plane) if plane["state"] in ("ok", "dev-checkout") else \
        {"codeRoot": None, "configDir": None, "launcher": False, "required": {},
         "adapters": {}, "missing": []}
    override = host_override(args.host_override)
    reasons = blocking_reasons(plane, skills, project_info, config, args.require_pin,
                               expected_config_hashes(args.expect_config))
    # An explicitly requested override is fail-closed; an implicit one is only reported, so a
    # generic project can still be planned without any host-local values.
    if args.host_override or args.require_host_override:
        reasons.extend(override["reasons"])
    elif override["state"] == "missing":
        override["reasons"] = []
    artifacts, artifacts_source = resolve_path(args.artifacts, override, "artifactRoot")
    if artifacts:
        if not Path(artifacts).is_dir():
            reasons.append("artifacts-dir-missing: %s" % artifacts)
    server_cli, server_cli_source = resolve_path(None, override, "serverCli")
    plan = plan_block(config, project) if not reasons else None
    if plan is not None:
        plan["paths"] = {
            "artifacts": {"value": artifacts, "source": artifacts_source},
            "serverCli": {"value": server_cli, "source": server_cli_source},
        }
        plan["runtime"] = {"default": override["runtime"].get("default"),
                           "source": "host-override" if override["state"] == "ok" else "unset"}
    return {"ready": not reasons,
            "controlPlane": plane,
            "skills": skills,
            "project": project_info,
            "config": config,
            "hostOverride": override,
            "plan": plan,
            "blocking": reasons}


def resolve_path(explicit, override, key):
    """Explicit flag > host override > unset. No default path is invented."""
    if explicit:
        return explicit, "explicit"
    if override["state"] == "ok" and override["paths"].get(key):
        return override["paths"][key], "host-override"
    return None, "unset"


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
    parser.add_argument("--host-override", default=None, metavar="PATH",
                        help="host-local values file (default /opt/swarm/hosts/<hostname>.json)")
    parser.add_argument("--require-host-override", action="store_true",
                        help="block when the host-local values are absent or invalid")
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
        override = result["hostOverride"]
        print("host override: %s %s" % (override["state"], override["path"]))
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
