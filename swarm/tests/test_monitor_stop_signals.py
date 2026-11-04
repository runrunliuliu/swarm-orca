"""Real isolated process-group signals, never an Orca CLI/session/Run.

The fake CLI/adapter blocks at a ready file so SIGINT arrives during I/O, not
at a timing guess. Only per-test temporary paths and child process groups are used.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

from coordinator_io import file_ref, publish_new, read_json
import operator_monitor as monitor


CHILD = '''
import json, os, signal, sys, time
from pathlib import Path
root = Path(os.environ["MONITOR_SIGNAL_TEST_ROOT"])
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
(root / "ready.tmp").write_text(str(os.getpgrp()))
os.replace(root / "ready.tmp", root / "ready")
deadline = time.monotonic() + 5
while not (root / "release").exists():
    if time.monotonic() > deadline:
        sys.exit(3)
    time.sleep(0.01)
kind = os.environ["MONITOR_SIGNAL_TEST_RESULT"]
if kind == "invalid":
    print("not-json", flush=True)
elif kind == "denied":
    print(json.dumps(dict(ok=False, error=dict(code="runtime_access_denied"))), flush=True)
    sys.exit(1)
else:
    print(json.dumps(dict(ok=True, _meta=dict(runtimeId="test-runtime"), result={})), flush=True)
'''


def fixture(root, route, result):
    """Run production signal handling and subprocess I/O with a fake tick/CLI."""
    root = Path(root)
    os.environ['MONITOR_SIGNAL_TEST_ROOT'] = str(root)
    os.environ['MONITOR_SIGNAL_TEST_RESULT'] = result
    cli = root / 'fake-cli'
    publish_new(cli, ('#!' + sys.executable + '\n' + CHILD).encode())
    cli.chmod(0o700)
    monitor.watch.CLI = str(cli)
    adapter = root / 'adapter.py'
    publish_new(adapter, CHILD.encode())
    state = root / 'state'
    state.mkdir(mode=0o700)
    config = SimpleNamespace(root=state, ref={'test': 'signal'},
                             data={'enabled': True, 'schema_version': 2, 'poll_seconds': 1})
    children = []
    original_popen = subprocess.Popen
    def track_child(*args, **kwargs):
        process = original_popen(*args, **kwargs)
        children.append(process)
        return process
    subprocess.Popen = track_child
    def tick(_):
        timeout = 2 if result == 'timeout' else 6
        if route == 'adapter':
            monitor.invoke(file_ref(adapter), {'method': 'query'}, cwd=str(root), timeout=timeout)
        else:
            args = ['status'] if route == 'inventory' else ['terminal', 'show', '--terminal', 'test']
            monitor.native(args, 'test-runtime', timeout=timeout)
        publish_new(root / 'tick-finished.json', {'complete': True})
        return 'monitoring'
    monitor.tick = tick
    def observe(event, status):
        if event == 'exited':
            publish_new(root / 'exited.json', {'event': event})
    previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    code = monitor.run(config, observer=observe)
    assert previous == {s: signal.getsignal(s) for s in previous}
    if result == 'timeout':
        assert len(children) == 1 and children[0].returncode == -signal.SIGKILL
    return code


class MonitorSignalTests(unittest.TestCase):
    def run_signal_case(self, route, sig, result='ok'):
        with tempfile.TemporaryDirectory(prefix='monitor-signal-test-') as directory:
            root = Path(directory).resolve()
            child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()),
                                      '--fixture', str(root), route, result],
                                     start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not (root / 'ready').exists():
                    self.assertIsNone(child.poll(), 'fixture exited before I/O')
                    self.assertLess(time.monotonic(), deadline, 'fixture I/O not ready')
                    time.sleep(0.01)
                # This group belongs only to the fixture, never the test runner/TUI.
                child_group = int((root / 'ready').read_text())
                os.killpg(child.pid, sig)
                if result != 'timeout':
                    publish_new(root / 'release', b'continue')
                out, err = child.communicate(timeout=8)
                expected = 0 if result == 'ok' else 2
                self.assertEqual(child.returncode, expected, (out.decode(), err.decode()))
                self.assertNotEqual(child_group, child.pid, 'I/O child inherited monitor signal group')
                self.assertTrue((root / 'exited.json').exists())
                if result == 'ok':
                    self.assertTrue((root / 'tick-finished.json').exists())
                    self.assertFalse((root / 'state/monitor-stop.json').exists())
                else:
                    self.assertFalse((root / 'tick-finished.json').exists())
                    reason = ('query_invalid_json' if result == 'invalid' else
                              'query_timeout' if result == 'timeout' and route == 'inventory' else
                              'TimeoutExpired' if result == 'timeout' else 'runtime_access_denied')
                    self.assertEqual(read_json(root / 'state/monitor-stop.json')['reason'], reason)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=8)

    def test_sigint_during_native_query_finishes_tick_without_latch(self):
        self.run_signal_case('native', signal.SIGINT)

    def test_sigterm_during_native_query_finishes_tick_without_latch(self):
        self.run_signal_case('native', signal.SIGTERM)

    def test_sigint_during_inventory_query_finishes_tick_without_latch(self):
        self.run_signal_case('inventory', signal.SIGINT)

    def test_sigint_during_adapter_query_finishes_tick_without_latch(self):
        self.run_signal_case('adapter', signal.SIGINT)

    def test_real_invalid_json_still_latches_even_when_stopping(self):
        self.run_signal_case('native', signal.SIGINT, 'invalid')

    def test_permission_failure_still_latches_even_when_stopping(self):
        self.run_signal_case('inventory', signal.SIGTERM, 'denied')

    def test_native_deadline_still_kills_and_reaps_child_when_stopping(self):
        self.run_signal_case('native', signal.SIGINT, 'timeout')

    def test_inventory_deadline_still_kills_and_reaps_child_when_stopping(self):
        self.run_signal_case('inventory', signal.SIGINT, 'timeout')

    def test_adapter_deadline_still_kills_and_reaps_child_when_stopping(self):
        self.run_signal_case('adapter', signal.SIGINT, 'timeout')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--fixture':
        raise SystemExit(fixture(*sys.argv[2:]))
    unittest.main()
