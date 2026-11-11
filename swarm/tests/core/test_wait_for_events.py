"""The wait wrapper's contract: keepalive is not a message, and a timeout is not "nothing happened".

These run a fake CLI instead of Orca, so they pin the classification the session depends on
without a live runtime. The negative half is the point: on an empty batch or a timeout the only
allowed next steps are "enumerate" and "wait again", so the wrapper must never print a row that
looks like a message and must expose a status the caller cannot confuse with one.
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


def pretty(payload) -> str:
    """The CLI's `--json` output is pretty-printed, not one line per result."""
    return json.dumps(payload, indent=2) + "\n"
WRAPPER = ROOT / "wait_for_events.py"


class FakeCli:
    """A CLI that prints the argv it received, then the scripted response."""

    def __init__(self, directory: Path) -> None:
        self.path = directory / "fake-orca"
        self.path.write_text(textwrap.dedent('''\
            #!/bin/sh
            printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"
            cat "$(dirname "$0")/stdout.txt"
            cat "$(dirname "$0")/stderr.txt" >&2
            exit "$(cat "$(dirname "$0")/exit.txt")"
            '''))
        self.path.chmod(0o755)
        self.dir = directory

    def respond(self, stdout: str = "", stderr: str = "", exit_code: int = 0) -> None:
        (self.dir / "stdout.txt").write_text(stdout)
        (self.dir / "stderr.txt").write_text(stderr)
        (self.dir / "exit.txt").write_text(str(exit_code))

    def argv(self) -> list[str]:
        return (self.dir / "argv.txt").read_text().split()


class WaitWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cli = FakeCli(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def run_wrapper(self, *args):
        return subprocess.run([sys.executable, "-B", str(WRAPPER), "--cli", str(self.cli.path), *args],
                              capture_output=True, text=True, timeout=60)

    def test_messages_are_printed_one_row_each(self):
        self.cli.respond(stdout=pretty({"ok": True, "result": {
            "messages": [{"type": "worker_done", "id": "d1"}, {"type": "question", "id": "q1"}],
            "count": 2, "deliveryId": "dlv_1", "timedOut": False}}))
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        lines = completed.stdout.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith("worker_done\t"))
        self.assertIn('"q1"', lines[1])

    def test_keepalive_never_reaches_the_message_stream(self):
        # Why: a 15 s keepalive line is CLI liveness. Parsing it as a message is how an idle
        # session starts acting on nothing.
        self.cli.respond(stdout=pretty({"ok": True, "result": {
                             "messages": [{"type": "worker_done", "id": "d1"}], "count": 1}}),
                         stderr="_keepalive 15s\n_keepalive 30s\n")
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("_keepalive", completed.stdout)
        self.assertEqual(len(completed.stdout.splitlines()), 1)

    def test_the_result_envelope_is_unwrapped(self):
        # Why: the CLI wraps every result in {id, ok, result, _meta}; reading payload["deliveries"]
        # would report a real batch as empty.
        self.cli.respond(stdout=pretty({"id": "r1", "ok": True,
                                        "result": {"messages": [{"type": "worker_done", "id": "m1"}],
                                                   "count": 1}}))
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(len(completed.stdout.splitlines()), 1)
        self.assertIn("worker_done", completed.stdout)

    def test_an_unknown_receipt_shape_is_not_reported_as_empty(self):
        # Why: "unknown" and "nothing happened" must not collapse. An unrecognised non-empty body
        # is surfaced as one row so the caller reads it instead of acting on an empty batch.
        self.cli.respond(stdout=pretty({"ok": True, "result": {"unexpected": {"a": 1}}}))
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("unexpected", completed.stdout)

    def test_an_empty_batch_is_its_own_status(self):
        self.cli.respond(stdout=pretty({"ok": True, "result": {
                             "messages": [], "count": 0, "timedOut": False}}),
                         stderr="_keepalive 15s\n")
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn("do not act", completed.stderr)
        self.assertEqual(completed.stdout, "")

    def test_a_timeout_is_not_an_empty_batch(self):
        self.cli.respond(stdout=pretty({"ok": True, "result": {
                             "messages": [], "count": 0, "timedOut": True}}),
                         stderr="_keepalive 300s\n")
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 124)
        self.assertIn("do not act", completed.stderr)

    def test_an_empty_stdout_with_exit_zero_is_empty_not_a_pass(self):
        self.cli.respond(stdout="", stderr="")
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(completed.stdout, "")

    def test_the_call_is_bounded_and_never_mutates_anything(self):
        self.cli.respond(stdout=pretty({"ok": True, "result": {"messages": [], "count": 0}}))
        self.run_wrapper("--timeout-ms", "120000", "--types", "worker_done")
        argv = self.cli.argv()
        self.assertEqual(argv[:3], ["orchestration", "check", "--wait"])
        self.assertIn("--timeout-ms", argv)
        self.assertEqual(argv[argv.index("--timeout-ms") + 1], "120000")
        self.assertEqual(argv[argv.index("--types") + 1], "worker_done")
        for forbidden in ("worker-start", "worker-release", "worker-abandon", "retry", "dispatch"):
            self.assertNotIn(forbidden, argv)

    def test_a_transport_failure_is_reported_not_swallowed(self):
        self.cli.respond(stdout="", stderr="runtime_unavailable\n", exit_code=2)
        completed = self.run_wrapper()
        self.assertEqual(completed.returncode, 2)
        self.assertIn("runtime_unavailable", completed.stderr)


class WaitRuleIsDocumentedTests(unittest.TestCase):
    """A command that is not described where the session reads it does not change behaviour."""

    def test_the_skill_states_the_one_allowed_waiting_form(self):
        skill = (ROOT / "skills" / "swarm-orchestration" / "SKILL.md").read_text()
        self.assertIn("check --wait", skill)
        self.assertIn("sleep", skill)
        self.assertIn("_keepalive", skill)
        self.assertIn("300 s", skill)
        self.assertIn("never authorizes", skill)


if __name__ == "__main__":
    unittest.main()
