"""Missing Worker bindings must be visible, independently of token semantics."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError, digest
from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger
from core.test_ledger import START, END, run, worker, sample


class BindingCoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.ledger = Ledger(self.root / 'state')
        self.addCleanup(self.ledger.close)
        self.workers = [worker(), worker('dispatch-2')]
        self.ledger.sync('rt', run(), self.workers)
        self.stdout, self.stderr = io.StringIO(), io.StringIO()

    def sync(self, agents=None, *, strict=False, output=False, scan_effect=None):
        args = ['--state', str(self.root / 'state'), 'sync', '--runtime-id', 'rt', '--run', 'run-1',
                '--cli', 'unused']
        if agents is not None:
            bindings = [{"provider": "codex", "agent_id": aid, "file": "unused",
                         "session_id": aid, "since": START, "until": END} for aid in agents]
            path = self.root / 'bindings.json'
            path.write_text(json.dumps(bindings))
            args += ['--bindings', str(path)]
        if strict:
            args += ['--require-worker-bindings']
        if output:
            args += ['--output', str(self.root / 'out')]
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        with patch('swarm_ledger.__main__.Reader') as reader, \
                patch('swarm_ledger.__main__.scan', side_effect=scan_effect or (lambda _, sid, *a: sample(sid))) as scan, \
                redirect_stdout(self.stdout), redirect_stderr(self.stderr):
            self.scan_mock = scan
            reader.return_value.collect.return_value = run(), self.workers
            self.assertEqual(main(args), 0)
        return json.loads(self.stdout.getvalue())

    def test_omitted_empty_and_coordinator_only_bindings_warn_and_persist(self):
        for agents in (None, [], ['coordinator']):
            with self.subTest(agents=agents):
                result = self.sync(agents)
                coverage = result['usage_binding_coverage']
                self.assertEqual(coverage['missing_worker_ids'], ['dispatch-1', 'dispatch-2'])
                self.assertEqual(coverage['warnings'], ['worker_usage_bindings_missing'])
                self.assertIn('worker_usage_bindings_missing', self.stderr.getvalue())
                self.assertEqual(self.ledger.report('rt', 'run-1')['usage_binding_coverage'], coverage)

    def test_all_workers_bound_pass_strict_without_warning(self):
        result = self.sync(['dispatch-1', 'dispatch-2'], strict=True)
        self.assertEqual(result['usage_binding_coverage']['missing_worker_ids'], [])
        self.assertEqual(result['usage_binding_coverage']['warnings'], [])
        self.assertEqual(self.stderr.getvalue(), '')
        self.assertEqual(result['summary']['known_tokens']['total_tokens'], 300)

    def test_old_partial_samples_do_not_hide_missing_checkpoint_binding(self):
        self.sync(['dispatch-1', 'dispatch-2'])
        result = self.sync(['coordinator', 'dispatch-1'])
        self.assertEqual(result['usage_binding_coverage']['missing_worker_ids'], ['dispatch-2'])
        self.assertEqual(result['agents'][2]['usage_status'], 'partial')

    def test_strict_missing_bindings_rolls_back_before_collecting_or_exporting(self):
        before = self.ledger.get('rt', 'run-1')
        for agents in (None, [], ['coordinator'], ['dispatch-1']):
            with self.subTest(agents=agents), self.assertRaisesRegex(SafetyError, 'worker_usage_bindings_missing'):
                self.sync(agents, strict=True, output=True)
            self.assertEqual(before, self.ledger.get('rt', 'run-1'))
            self.assertFalse((self.root / 'out').exists())
            self.scan_mock.assert_not_called()

    def test_unknown_binding_target_rejected_without_partial_commit(self):
        before = self.ledger.get('rt', 'run-1')
        with self.assertRaisesRegex(SafetyError, 'unknown Agent'):
            self.sync(['dispatch-1', 'foreign-dispatch'])
        self.assertEqual(before, self.ledger.get('rt', 'run-1'))

    def test_later_scan_failure_rolls_back_new_coverage_and_first_sample(self):
        self.sync([])
        before = self.ledger.get('rt', 'run-1')
        with self.assertRaisesRegex(SafetyError, 'test scan failure'):
            self.sync(['dispatch-1', 'dispatch-2'], strict=True, output=True,
                      scan_effect=[sample('dispatch-1'), SafetyError('test scan failure')])
        self.assertEqual(self.scan_mock.call_count, 2)
        self.assertEqual(before, self.ledger.get('rt', 'run-1'))
        self.assertFalse((self.root / 'out').exists())

    def test_final_workers_need_not_remain_in_active_bindings(self):
        self.ledger.usage('rt', 'run-1', 'dispatch-1', sample('dispatch-1'), final=True)
        result = self.sync(['dispatch-2'], strict=True)
        self.assertEqual(result['usage_binding_coverage']['required_worker_ids'], ['dispatch-2'])
        self.assertEqual(result['usage_binding_coverage']['missing_worker_ids'], [])

    def test_no_workers_does_not_require_bindings(self):
        # A fresh Run checkpoint is legitimate before any dispatch exists.
        self.ledger.sync('rt', run('empty'), [])
        result = self.ledger.sync('rt', run('empty'), [], binding_agent_ids=[])
        self.assertEqual(result['usage_binding_coverage']['missing_worker_ids'], [])

    def test_export_explains_missing_binding_instead_of_only_unknown_tokens(self):
        result = self.sync(['coordinator'], output=True)
        target = self.root / 'out' / 'runs' / digest(['rt', 'run-1'])
        exported = json.loads((target / 'ledger.json').read_text())
        self.assertEqual(exported['usage_binding_coverage'], result['run']['usage_binding_coverage'])
        markdown = (target / 'ledger.md').read_text()
        self.assertIn('Worker 用量采集绑定缺失', markdown)
        self.assertIn('- dispatch-1', markdown)
        self.assertIn('- dispatch-2', markdown)


if __name__ == '__main__':
    unittest.main()
