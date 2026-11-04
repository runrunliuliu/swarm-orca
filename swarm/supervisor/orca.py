"""Pinned native CLI adapter. No shell, inferred targets, retries or authority spoofing."""

import json
import os
import re
import subprocess
from pathlib import Path

from .config import SafetyError, require
from . import trae_trust


def result(receipt):
    require(isinstance(receipt, dict), "invalid native envelope")
    if receipt.get("ok") is not True:
        code = receipt.get("error", {}).get("code", "native_error")
        # Native stderr/message can contain prompts, tokens or credentials.
        raise SafetyError("native:" + (code if re.fullmatch(r"[a-z_]+", str(code)) else "error"))
    require(isinstance(receipt.get("result"), dict), "missing native result")
    return receipt["result"]


class Orca:
    def __init__(self, config, *, coordinator=False, runner=subprocess.run, env=None):
        self.config = config
        self.runner = runner
        self.env = dict(os.environ if env is None else env)
        self.coordinator = coordinator
        require(not any(self.env.get(k) for k in ("ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE", "ORCA_DEV_REPO_ROOT")),
                "remote routing overrides are forbidden; execute on the independent Server host")
        if not coordinator:
            require(not any(self.env.get(k) for k in ("ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_AGENT_SESSION_ID")),
                    "Supervisor must run outside an Agent's identity context")

    def invoke(self, argv):
        """Return even a failed native receipt so the operation journal can preserve it."""
        require(all(isinstance(v, str) for v in argv), "CLI arguments must be strings")
        require(not any(v in argv for v in ("--from", "--environment", "--pairing-code", "--retry-request")),
                "caller impersonation, routing and blind retry are forbidden")
        try:
            process = self.runner([self.config["runtime"]["cli"], *argv, "--json"],
                                  capture_output=True, text=True, timeout=55, env=self.env)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SafetyError("native_transport_unknown") from error
        try:
            receipt = json.loads(process.stdout)
        except (TypeError, ValueError) as error:
            raise SafetyError("native_receipt_unreadable") from error
        require(isinstance(receipt, dict), "invalid native envelope")
        if receipt.get("ok") is True:
            require(receipt.get("_meta", {}).get("runtimeId") == self.config["runtime"]["runtime_id"],
                    "native runtime changed; no fallback allowed")
        # Some commands (wait/start) return a useful JSON receipt with exit code 1.
        require(process.returncode in (0, 1), "native_process_exit_unknown")
        return receipt

    def read(self, *argv):
        return result(self.invoke(list(argv)))

    def verify_runtime(self):
        runtime = self.read("status")["runtime"]
        require(runtime.get("state") == "ready" and runtime.get("reachable") is True,
                "independent runtime not ready")
        require(runtime.get("runtimeId") == self.config["runtime"]["runtime_id"], "wrong runtime")
        require(runtime.get("appVersion") == self.config["runtime"]["version"], "unsupported runtime version")
        return runtime

    def terminal(self, handle):
        require(isinstance(handle, str) and bool(handle), "missing Coordinator identity")
        terminal = self.read("terminal", "show", "--terminal", handle)["terminal"]
        require(terminal.get("handle") == handle and terminal.get("connected") is True
                and terminal.get("writable") is True and terminal.get("ptyId"),
                "Coordinator terminal is unavailable; manual recovery required")
        expected = self.config["runtime"]["coordinator_worktree_id"]
        listing = self.read("terminal", "list", "--worktree", "id:" + expected)
        require(listing.get("truncated") is not True, "incomplete Coordinator terminal inventory")
        require(any(t.get("handle") == handle for t in listing["terminals"]), "wrong Coordinator workspace")
        return terminal

    def identity(self):
        require(self.coordinator, "native mutations require real Coordinator context")
        handle = self.env.get("ORCA_TERMINAL_HANDLE")
        require(handle, "run this inside the real Coordinator PTY; never copy another terminal's environment")
        return self.terminal(handle)

    def preflight(self, worktree_id=None, *, for_trust=False, expected_head=None):
        """Verify exact native targets and the local checkout before admitting a launch."""
        repo_id = self.config["runtime"]["repo_id"]
        repo = self.read("repo", "show", "--repo", "id:" + repo_id)["repo"]
        require(repo.get("id") == repo_id, "repository identity mismatch")
        # Git object existence is checked on the confirmed local Coordinator checkout.
        target = worktree_id or self.config["runtime"]["coordinator_worktree_id"]
        row = self.read("worktree", "show", "--worktree", "id:" + target)["worktree"]
        require(row.get("id") == target, "exact workspace identity mismatch")
        path = Path(target.split("::", 1)[1])
        if for_trust:
            require(target.startswith(repo_id + "::/") and row.get("repoId") == repo_id
                    and target.split("::", 1)[1] == str(path)
                    and row.get("path") == str(path) and row.get("hostId") == "local",
                    "Trae trust requires the exact repository/path on this Server host")
        require(path.is_dir() and path == path.resolve(), "workspace is not an exact local checkout")

        def git(*args):
            try:
                process = self.runner(["git", "-C", str(path), *args], capture_output=True,
                                      text=True, timeout=15, env=self.env)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise SafetyError("local_git_preflight_failed") from error
            require(process.returncode == 0, "local_git_preflight_failed")
            return process.stdout.strip()

        require(git("rev-parse", "--show-toplevel") == str(path), "workspace is not the Git root")
        git("cat-file", "-e", self.config["base_commit"] + "^{commit}")
        if worktree_id:
            require(not git("status", "--porcelain", "--untracked-files=normal"), "exact workspace is dirty")
        if expected_head:
            require(git("rev-parse", "HEAD") == expected_head, "prepared workspace has a different baseline")
        return path

    def check_trust_context(self):
        trae_trust.check_context(self.config["trae_workspace_trust"], self.env)

    def trust_workspace(self, worktree_id, *, expected_head=None):
        self.verify_runtime()
        path = self.preflight(worktree_id, for_trust=True, expected_head=expected_head)
        return trae_trust.register(self.config["trae_workspace_trust"], path, self.env)

    def workers(self, run):
        workers, cursors, cursor = [], set(), None
        while True:
            argv = ["orchestration", "worker-list", "--run", run, "--include-remote"]
            if cursor:
                argv += ["--cursor", cursor]
            page = self.read(*argv)
            require(not page.get("partialHostErrors") and not page.get("warnings"), "incomplete native fleet")
            require(isinstance(page.get("workers"), list), "invalid native fleet")
            workers.extend(page["workers"])
            paging = page.get("page", {})
            require(type(paging.get("hasMore")) is bool, "missing fleet pagination truth")
            if not paging["hasMore"]:
                break
            cursor = paging.get("nextCursor")
            require(isinstance(cursor, str) and cursor and cursor not in cursors, "invalid fleet cursor")
            cursors.add(cursor)
        ids = [w["dispatchId"] for w in workers]
        require(len(ids) == len(set(ids)), "duplicate fleet rows")
        return workers

    def tasks(self, run):
        receipt = self.read("orchestration", "task-list", "--run", run)
        require(not receipt.get("legacyReadOnly") and not receipt.get("truncated"), "incomplete/legacy task inventory")
        tasks = receipt["tasks"]
        require(isinstance(tasks, list) and len({t["id"] for t in tasks}) == len(tasks), "invalid task inventory")
        return tasks
