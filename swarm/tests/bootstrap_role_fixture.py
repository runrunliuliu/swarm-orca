"""Offline original-role workflow consuming only returned contracts and commands.

Real CLI dispatch, owner sockets and evidence publication; native identity/probes
are test-only. Never starts Agents, Runs or Workers.
"""

from contextlib import redirect_stdout
import copy
import io
import os
from pathlib import Path
from unittest.mock import patch

from bootstrap_actions import ACTIONS
from bootstrap_tool import RoleTool, connect
from coordinator_launch import main as launch_main
from coordinator_io import file_ref, parse, pinned, publish_new


class RoleWorkflow:
    def __init__(self, f, identity, owner_ref):
        self.f, self.identity, self.owner_ref = f, identity, owner_ref

    def cli(self, role, args):
        self.identity.actor = role
        output = io.StringIO()
        with redirect_stdout(output):
            code = launch_main(["strict-bootstrap", *args])
        result = parse(output.getvalue().encode())
        if code:
            raise ValueError(result["reason"])
        return result["result"]

    def pull(self, role):
        return self.cli(role, ["pull", "--owner", self.owner_ref["path"], "--owner-sha256", self.owner_ref["sha256"],
                               "--actor", role, "--timeout", "30", "--execute"])

    def advance_marker(self, role):
        self.identity.actor = role
        control, client = connect(self.owner_ref)
        tool = RoleTool(control, client, role)
        try:
            tool.step()
        finally:
            tool.close()

    def returned_command(self, action, key="complete_argv"):
        argv = action[key]
        assert argv is not None
        assert Path(argv[2]).name == "coordinator_launch.py"
        assert argv[3] == "strict-bootstrap"
        return self.cli(ACTIONS[action["action"]].actor, argv[4:])

    def candidate_value(self, action):
        value = copy.deepcopy(action["payload"]["candidate_template"])
        if value.get("kind") == "strict_bootstrap_review_result":
            value.update(decision="approve", notes="Independent offline fixture review, not live evidence",
                         reviewed_at=self.f.base.clock.isoformat())
        return value

    def write_candidates(self, action):
        contract = action["submission"]
        if contract["mode"] == "submit":
            publish_new(Path(contract["candidate_path"]), self.candidate_value(action))
        else:
            for output in contract["outputs"]:
                publish_new(Path(output["candidate_path"]), {"read": pinned(self.f.b["fixed_inputs"]["role_skill"]).decode()})

    def complete(self, action, *, write=True):
        name = action["action"]
        if name == "caller-intent":
            with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_test"}), \
                    patch("trae_coordinator.native", return_value=self.f.base.tui.caller):
                return self.returned_command(action)
        if name == "observe-intent":
            observation = copy.deepcopy(self.f.base.observation)
            observation["caller_receipt"] = file_ref(self.f.paths["caller_receipt"])
            with patch("trae_tui.observe", return_value=observation):
                return self.returned_command(action)
        if write:
            self.write_candidates(action)
        return self.returned_command(action)

    def until(self, name):
        """Advance earlier actions with returned templates; leave requested action fresh."""
        for current, spec in ACTIONS.items():
            action = self.pull(spec.actor)
            assert action["action"] == current, action
            if current == name:
                return action
            self.complete(action)
            if current in {"caller-intent", "contract-intent"}:
                self.advance_marker(spec.actor)
        raise AssertionError(name)
