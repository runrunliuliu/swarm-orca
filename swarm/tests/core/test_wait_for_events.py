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

import wait_for_events

ROOT = Path(__file__).resolve().parents[2]


def pretty(payload) -> str:
    """The CLI's `--json` output is pretty-printed, not one line per result."""
    return json.dumps(payload, indent=2) + "\n"
WRAPPER = ROOT / "wait_for_events.py"


class FakeCli:
    """A CLI that prints the argv it received, then the scripted response."""

    def __init__(self, directory: Path, delay: float = 0.0) -> None:
        self.path = directory / "fake-orca"
        self.path.write_text(textwrap.dedent('''\
            #!/bin/sh
            printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"
        ''') + (f'    sleep {delay}\n' if delay else "") + textwrap.dedent('''\
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
                              capture_output=True, text=True, timeout=120)

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

    def test_this_runtime_timeout_shape_is_a_timeout(self):
        # Why: the measured answer to an elapsed `check --wait` here is `ok:true`, `count:0`, no
        # `timedOut` key and exit 0. Classifying that as an empty batch is how a caller concludes
        # "a batch was delivered empty" after waiting out the whole window.
        self.cli = FakeCli(self.dir, delay=1.0)
        self.cli.respond(stdout=pretty({"ok": True, "result": {"messages": [], "count": 0}}),
                         stderr="_keepalive 15s\n")
        completed = self.run_wrapper("--timeout-ms", "1000")
        self.assertEqual(completed.returncode, 124, completed.stdout + completed.stderr)
        self.assertIn("timeout", completed.stderr)
        self.assertEqual(completed.stdout, "")

    def test_the_documented_window_is_what_the_wrapper_asks_for(self):
        self.cli.respond(stdout=pretty({"ok": True, "result": {"messages": [], "count": 0}}))
        self.run_wrapper("--timeout-ms", "1000")
        argv = self.cli.argv()
        self.assertEqual(argv[argv.index("--timeout-ms") + 1], "1000")


class ElapsedTimeoutInferenceTests(unittest.TestCase):
    """The boundary of the elapsed guess, pinned exactly and without a subprocess.

    A wrong `124` turns "nothing was delivered" into a failure a caller retries, so each edge is
    asserted on both sides instead of being described in prose.
    """

    WINDOW = 300_000

    def receipt(self, **body):
        return pretty({"ok": True, "result": {"messages": [], "count": 0, **body}})

    def classify(self, stdout, elapsed_ms, timeout_ms=None, returncode=0):
        return wait_for_events.classify(returncode, stdout, elapsed_ms=elapsed_ms,
                                        timeout_ms=self.WINDOW if timeout_ms is None else timeout_ms)[0]

    def test_a_spent_window_is_a_timeout(self):
        self.assertEqual(self.classify(self.receipt(), self.WINDOW), wait_for_events.TIMEOUT)

    def test_the_tolerance_only_loosens_toward_a_spent_window(self):
        self.assertEqual(self.classify(self.receipt(), self.WINDOW - wait_for_events.TOLERANCE_MS),
                         wait_for_events.TIMEOUT)
        self.assertEqual(self.classify(self.receipt(), self.WINDOW - wait_for_events.TOLERANCE_MS - 1),
                         wait_for_events.EMPTY)

    def test_an_early_empty_batch_is_not_a_timeout(self):
        # Ten milliseconds early is inside the tolerance band on purpose: the timing slack exists
        # because a window that spent itself must not be reported as a delivery. An early answer
        # far outside the band stays an empty batch, not a retryable failure.
        self.assertEqual(self.classify(self.receipt(), self.WINDOW * 0.1), wait_for_events.EMPTY)

    def test_an_explicit_not_timed_out_wins_over_the_clock(self):
        # `timedOut: false` is the CLI stating a fact; the wrapper's clock is only a fallback for
        # the runtime that omits the key.
        for key in ("timedOut", "timeout"):
            with self.subTest(key=key):
                self.assertEqual(self.classify(self.receipt(**{key: False}), self.WINDOW),
                                 wait_for_events.EMPTY)

    def test_a_message_batch_is_never_a_timeout(self):
        stdout = pretty({"ok": True, "result": {"messages": [{"type": "worker_done"}],
                                                   "count": 1}})
        self.assertEqual(self.classify(stdout, self.WINDOW * 2), wait_for_events.MESSAGES)

    def test_an_incomplete_or_unrecognised_receipt_is_not_a_timeout(self):
        cases = {
            "no ok": pretty({"result": {"messages": [], "count": 0}}),
            "not ok": pretty({"ok": False, "result": {"messages": [], "count": 0}}),
            "ok is not bool": pretty({"ok": 1, "result": {"messages": [], "count": 0}}),
            "only count": pretty({"ok": True, "result": {"count": 0}}),
            "only messages": pretty({"ok": True, "result": {"messages": []}}),
            "count is not zero": pretty({"ok": True, "result": {"messages": [], "count": 7}}),
            "messages is not a list": pretty({"ok": True, "result": {"messages": None,
                                                                     "count": 0}}),
            "truncated": pretty({"ok": True, "result": {"messages": [], "count": 0}})[:-12],
            "empty stdout": "",
            "keepalive only": "_keepalive 15s\n",
        }
        for name, stdout in cases.items():
            with self.subTest(case=name):
                self.assertNotEqual(self.classify(stdout, self.WINDOW * 2), wait_for_events.TIMEOUT)

    def test_a_failed_or_signal_killed_cli_is_transport_not_timeout(self):
        # A child that was killed never answered, so its elapsed time is not evidence about the
        # wait. An outer `timeout` around this wrapper has the same shape.
        for code in (-15, -9, 2, 1, 127):
            with self.subTest(returncode=code):
                self.assertEqual(
                    self.classify(self.receipt(), self.WINDOW * 2, returncode=code),
                    wait_for_events.USAGE_OR_TRANSPORT)

    def test_without_a_measurement_the_old_classification_is_untouched(self):
        payload = self.receipt()
        self.assertEqual(wait_for_events.classify(0, payload)[0], wait_for_events.EMPTY)


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
