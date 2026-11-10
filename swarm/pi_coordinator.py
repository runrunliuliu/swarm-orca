"""Pi launch recipe for a strict Coordinator bootstrap (the Pi analogue of build_trae_plan).

Trae's recipe pins an execution config (sandbox / approval / launch mode / model) and the
strict contract re-verifies the transcript's per-turn settings against it. Pi has no
sandbox/approval surface, so its recipe pins the reviewed `pi_policy` record instead:
provider, model selector and thinking level — exactly what a Pi transcript can attest.

Two things this module deliberately does *not* do:

- it does not start, observe or gate anything (that stays with coordinator_startup,
  pi_tui and the Operator's session gate);
- it does not accept an exec adapter: Pi is TUI-only here, so the recipe is always
  `launch_mode: "tui"` and the adapter is always `pi-tui-runtime-v1`.

Selection is exact, not inferred: agent, provider, model and thinking level must all
equal the pinned policy, so a plan cannot claim settings the policy does not prove.
"""

from pathlib import Path
import os
import subprocess

import pi_policy
from coordinator_io import require
from log_io import prefix_digest

ADAPTER = "pi-tui-runtime-v1"
TUI_EXECUTION = {"launch_mode": "tui"}


def read_pi_runtime(runtime_config):
    """Return (pinned policy settings, execution) from the reviewed Pi policy file."""
    require(runtime_config is not None, "explicit pi runtime policy required; no Trae mapping")
    return pi_policy.read(runtime_config), dict(TUI_EXECUTION)


def selection_for(policy):
    """The only selection this policy admits."""
    return {"mode": "explicit", "agent": "pi", "provider": policy["model_provider"],
            "model": policy["model"], "thinking_level": policy["thinking_level"]}


def observed_version(executable):
    """The exact version line this host's Pi reports; callers must pin this value."""
    path = require_ordinary_executable(executable)
    reply = subprocess.run([str(path), "--version"], check=True, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    lines = reply.stdout.splitlines()
    require(bool(lines) and lines[0].strip(), "pi_executable_version_missing")
    return lines[0].strip()


def verify_pi_executable(executable, cli_version):
    """Prelaunch observation on this host, not native launch or process attestation."""
    from coordinator_io import now
    path = require_ordinary_executable(executable)

    def fingerprint():
        require(require_ordinary_executable(executable) == path, "pi_executable_changed")
        with path.open("rb") as stream:
            before = os.fstat(stream.fileno())
            sha = prefix_digest(stream, before.st_size)
            after = os.fstat(stream.fileno())

        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

        require(identity(before) == identity(after) == identity(path.stat())
                and require_ordinary_executable(executable) == path, "pi_executable_changed")
        return {"path": str(path), "sha256": sha, "identity": identity(after)}

    before = fingerprint()
    reply = subprocess.run([str(path), "--version"], check=True, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    lines = reply.stdout.splitlines()
    require(lines and lines[0].strip() == cli_version, "pi_executable_version_mismatch")
    require(fingerprint() == before, "pi_executable_changed")
    return {"executable": str(executable), "resolved_path": str(path),
            "sha256": before["sha256"], "cli_version": cli_version, "observed_at": now(),
            "trust": "operator-local-prelaunch-not-process-attested"}


def require_ordinary_executable(executable):
    """Absolute, regular, executable file in the Operator's own view; never a symlink chain."""
    require(isinstance(executable, str) and Path(executable).is_absolute(),
            "pi_executable_absolute_required")
    path = Path(executable)
    require(path.is_file() and os.access(path, os.X_OK), "pi_executable_missing")
    require(path.resolve() == path, "pi_executable_symlinked")
    return path


def build_pi_plan(*, pi, cwd, bootstrap_dir, write_dirs, selection, runtime_config,
                  prompt_file, cli_version):
    """Build the Pi Coordinator recipe. Raises rather than guessing any setting."""
    require_ordinary_executable(pi)
    policy, execution = read_pi_runtime(runtime_config)
    require(selection == selection_for(policy), "unsupported Pi Coordinator selection")
    require(bootstrap_dir is not None, "Pi Coordinator requires a fresh native bootstrap")
    require(isinstance(write_dirs, list) and all(isinstance(item, str) for item in write_dirs),
            "pi_plan_write_roots_invalid")
    # The materials pipeline passes a Path for the generated handoff; the plan stores text.
    require(prompt_file is not None and Path(prompt_file).is_absolute(),
            "pi_plan_prompt_file_required")
    # The recipe must *start* the pane with the settings the policy pins, otherwise the
    # S2 observation compares a transcript this plan never asked for. Pi takes provider,
    # model and thinking level on its own argv; there is no sentinel argument.
    argv = [pi, "--provider", policy["model_provider"],
            "--model", policy["model"] + ":" + policy["thinking_level"]]
    return {"schema_version": 1, "scope": "swarm_coordinator_only", "adapter": ADAPTER,
            "phase": "bootstrap", "cli_version": cli_version, "selection": selection,
            "execution": execution, "cwd": cwd, "runtime_config": runtime_config,
            "artifact_dirs": {"archive": bootstrap_dir}, "task_write_roots": list(write_dirs),
            "resume_session": None, "prompt_file": str(prompt_file), "argv": argv}
