"""`wait_pane.py`: a turn boundary is only awaited when the turn itself is proven.

The fake CLI here answers two commands - `terminal show` and `terminal wait` - and records every
argv it received, so the tests can assert both halves of the contract: the wait happens once and
only after `turn_started` is bound to this terminal's live incarnation, and the tool never sends
input, never acknowledges and never writes anything.

The negative half is the subject. `tui-idle` on a pane that never started a turn is the same
reading as `tui-idle` on a pane that finished one, and this runtime's `--wait-submit` really does
answer `provider: "unsupported"` for at least one provider - so "no turn_started" has to be exit 4,
not a completed wait.
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WRAPPER = ROOT / "wait_pane.py"
TERMINAL = "term_peer"
PTY = "pty_1"
INCARNATION = "inc_1"
PROCESS = f"{PTY}:{INCARNATION}"


def pretty(payload) -> str:
    return json.dumps(payload, indent=2) + "\n"


class FakeCli:
    """A CLI that replays one scripted receipt per command and records the argv it saw."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.path = directory / "fake-orca"
        self.path.write_text(textwrap.dedent('''\
            #!/bin/sh
            printf '%s\\n' "$@" >> "$(dirname "$0")/argv.txt"
            for last in "$@"; do :; done
            case "$1 $2" in
              "terminal show") cat "$(dirname "$0")/show.stdout"; exit "$(cat "$(dirname "$0")/show.exit")" ;;
              "terminal wait") cat "$(dirname "$0")/wait.stdout"; exit "$(cat "$(dirname "$0")/wait.exit")" ;;
            esac
            echo "unexpected command: $*" >&2
            exit 64
            '''))
        self.path.chmod(0o755)
        self.show(terminal_body())
        self.wait(pretty({"ok": True, "result": {"wait": {"handle": TERMINAL,
                                                          "condition": "tui-idle",
                                                          "satisfied": True,
                                                          "status": "running",
                                                          "exitCode": None}}}), 0)

    def show(self, payload, exit_code: int = 0) -> None:
        (self.dir / "show.stdout").write_text(
            payload if isinstance(payload, str) else pretty(payload))
        (self.dir / "show.exit").write_text(str(exit_code))

    def wait(self, payload, exit_code: int = 0) -> None:
        (self.dir / "wait.stdout").write_text(
            payload if isinstance(payload, str) else pretty(payload))
        (self.dir / "wait.exit").write_text(str(exit_code))

    def commands(self) -> list[list[str]]:
        path = self.dir / "argv.txt"
        if not path.exists():
            return []
        lines = path.read_text().splitlines()
        commands, current = [], []
        for line in lines:
            current.append(line)
            if line == "--json":
                commands.append(current)
                current = []
        return commands


def terminal_body(handle=TERMINAL, pty=PTY, incarnation=INCARNATION):
    return {"ok": True, "result": {"terminal": {"handle": handle, "ptyId": pty,
                                                "incarnationId": incarnation,
                                                "connected": True}}}


def send_receipt(stages=("input_accepted", "turn_started"), terminal=TERMINAL,
                 incarnation=PROCESS, request_id="req_1"):
    prompt = {"requestId": request_id, "stages": list(stages),
              "processIncarnation": incarnation}
    if terminal is not None:
        prompt["terminalHandle"] = terminal
    return {"ok": True, "result": {"send": {"accepted": True, "prompt": prompt}}}


class WaitPaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.cli = FakeCli(self.dir)

    def evidence(self, payload=None) -> Path:
        path = self.dir / "evidence.json"
        if payload is None:
            payload = send_receipt()
        path.write_text(payload if isinstance(payload, str)
                        else json.dumps(payload, indent=2) + "\n")
        return path

    def run_wrapper(self, *args):
        return subprocess.run([sys.executable, "-B", str(WRAPPER), "--cli", str(self.cli.path),
                               *args], capture_output=True, text=True, timeout=120)

    def test_a_proven_turn_ends_with_one_bounded_wait(self):
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()),
                                     "--idle-timeout", "2")
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(completed.stdout.strip(), "turn_ended")
        commands = self.cli.commands()
        self.assertEqual([command[:2] for command in commands],
                         [["terminal", "show"], ["terminal", "wait"]])
        wait = commands[1]
        self.assertEqual(wait[wait.index("--for") + 1], "tui-idle")
        self.assertEqual(wait[wait.index("--timeout-ms") + 1], "2000")
        self.assertEqual(wait[wait.index("--terminal") + 1], TERMINAL)

    def test_the_wait_never_sends_acknowledges_or_writes(self):
        # Why: a wait is not authorization. The only two verbs allowed are the identity read and
        # the native wait; anything that submits input or acks a Delivery would be a mutation.
        evidence = str(self.evidence())
        # Warm up the fake CLI's own bookkeeping file, so the comparison is about this tool.
        self.run_wrapper("--terminal", TERMINAL, "--turn-evidence", evidence)
        before = sorted(path.name for path in self.dir.iterdir())
        completed = self.run_wrapper("--terminal", TERMINAL, "--turn-evidence", evidence)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for command in self.cli.commands():
            self.assertIn(command[:2], (["terminal", "show"], ["terminal", "wait"]))
            for forbidden in ("send", "--ack", "--enter", "reply", "worker-start",
                              "worker-release", "worker-abandon", "dispatch"):
                self.assertNotIn(forbidden, command)
        self.assertEqual(sorted(path.name for path in self.dir.iterdir()), before)

    def test_no_turn_evidence_is_unverifiable_and_never_waits(self):
        # The runtime's own unsupported-provider case: input accepted, no `turn_started`.
        completed = self.run_wrapper("--terminal", TERMINAL)
        self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertEqual(completed.stdout.strip(), "unverifiable")
        self.assertEqual(self.cli.commands(), [], "the peer was observed without turn evidence")
        for stages in (("input_accepted",), (), ("submitted",)):
            with self.subTest(stages=stages):
                completed = self.run_wrapper(
                    "--terminal", TERMINAL,
                    "--turn-evidence", str(self.evidence(send_receipt(stages=stages))))
                self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertEqual(self.cli.commands(), [])

    def test_a_missing_or_unreadable_evidence_file_is_unverifiable(self):
        missing = self.dir / "not-there.json"
        for path in (missing, self.evidence("{not json")):
            with self.subTest(path=path.name):
                completed = self.run_wrapper("--terminal", TERMINAL, "--turn-evidence", str(path))
                self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertEqual(self.cli.commands(), [])

    def test_evidence_from_another_incarnation_is_unverifiable(self):
        # Why: the receipt must describe *this* pane's process. A receipt for a replaced or
        # different process says nothing about the pane we would be waiting on, so the identity
        # read may happen but the wait may not start.
        for incarnation in (f"{PTY}:inc_2", "pty_other:inc_1", "nonsense"):
            with self.subTest(incarnation=incarnation):
                completed = self.run_wrapper(
                    "--terminal", TERMINAL,
                    "--turn-evidence", str(self.evidence(send_receipt(incarnation=incarnation))))
                self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
                self.assertIn("incarnation_mismatch", completed.stderr)
        self.assertNotIn(["terminal", "wait"],
                         [command[:2] for command in self.cli.commands()])

    def test_the_pane_live_incarnation_must_match_the_receipt(self):
        self.cli.show(terminal_body(incarnation="inc_2"))
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()))
        self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)

    def test_evidence_naming_another_terminal_is_unverifiable(self):
        completed = self.run_wrapper(
            "--terminal", TERMINAL,
            "--turn-evidence", str(self.evidence(send_receipt(terminal="term_other"))))
        self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertIn("other_terminal", completed.stderr)

    def test_a_rejected_or_unshaped_receipt_is_unverifiable(self):
        payloads = {
            "refused": {"ok": False, "error": {"code": "terminal_not_writable", "message": "x"}},
            "no send": {"ok": True, "result": {"terminal": {}}},
            "not accepted": {"ok": True, "result": {"send": {"accepted": False}}},
            "no request id": {"ok": True, "result": {"send": {"accepted": True, "prompt": {
                "stages": ["turn_started"], "processIncarnation": PROCESS}}}},
            "no incarnation": {"ok": True, "result": {"send": {"accepted": True, "prompt": {
                "requestId": "r", "stages": ["turn_started"]}}}},
        }
        for name, payload in payloads.items():
            with self.subTest(case=name):
                completed = self.run_wrapper(
                    "--terminal", TERMINAL, "--turn-evidence", str(self.evidence(payload)))
                self.assertEqual(completed.returncode, 4, completed.stdout + completed.stderr)
        self.assertEqual(self.cli.commands(), [])

    def test_a_blocked_pane_requires_interaction_and_reports_only_the_reason(self):
        self.cli.wait(pretty({"ok": True, "result": {"wait": {
            "handle": TERMINAL, "condition": "tui-idle", "satisfied": False,
            "status": "running", "exitCode": None, "blockedReason": "agent-trust-workspace"}}}), 1)
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()), "--json")
        self.assertEqual(completed.returncode, 5, completed.stdout + completed.stderr)
        row = json.loads(completed.stdout)
        self.assertEqual(row["outcome"], "interaction_required")
        self.assertEqual(row["reason"], "agent-trust-workspace")
        self.assertIn("agent-trust-workspace", completed.stderr)

    def test_an_unknown_blocked_reason_is_not_guessed(self):
        self.cli.wait(pretty({"ok": True, "result": {"wait": {
            "handle": TERMINAL, "condition": "tui-idle", "satisfied": False,
            "status": "running", "exitCode": None, "blockedReason": "something-new"}}}), 1)
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()))
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)

    def test_a_timeout_is_its_own_status(self):
        self.cli.wait(pretty({"ok": False, "error": {"code": "timeout", "message": "no idle"}}), 1)
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()),
                                     "--idle-timeout", "1")
        self.assertEqual(completed.returncode, 124, completed.stdout + completed.stderr)
        self.assertEqual(completed.stdout, "")
        self.assertIn("re-enter, do not act", completed.stderr)

    def test_a_transport_failure_is_reported_not_swallowed(self):
        self.cli.show(pretty({"ok": False, "error": {"code": "runtime_unavailable",
                                                     "message": "down"}}), 1)
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()))
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)

    def test_the_peer_is_never_seen_as_a_progress_signal(self):
        # A satisfied wait on a pane that is not the target is not "the turn ended".
        self.cli.wait(pretty({"ok": True, "result": {"wait": {
            "handle": "term_other", "condition": "tui-idle", "satisfied": True,
            "status": "running", "exitCode": None}}}), 0)
        completed = self.run_wrapper("--terminal", TERMINAL,
                                     "--turn-evidence", str(self.evidence()))
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)

    def test_the_idle_window_is_capped_at_the_per_call_policy(self):
        for value in ("0", "-1", "301"):
            with self.subTest(value=value):
                completed = self.run_wrapper("--terminal", TERMINAL, "--turn-evidence",
                                             str(self.evidence()), "--idle-timeout", value)
                self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
