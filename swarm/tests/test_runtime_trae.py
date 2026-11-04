import copy
from contextlib import redirect_stdout
import io
import hashlib
import json
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError
from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger
from swarm_ledger import runtime_binding as binding
from swarm_ledger.report import export
from test_runtime_binding import RuntimeBindingFixture, NOW
from test_trae_jsonl import meta, event, mirror, counts, complete


class RuntimeTraeTests(RuntimeBindingFixture, unittest.TestCase):
    cli_version = '0.209.1'

    def setUp(self):
        super().setUp()
        self.ledger.close()
        self.ledger = Ledger(self.root / 'trae-state', clock=lambda: NOW)
        self.native.terminal['agentIdentity'] = 'trae'
        self.native.worker['worker']['startOptions']['launch']['effective']['agent'] = 'trae'
        self.native.worker['dispatch']['hostScope'] = {'kind': 'local', 'hostId': 'local'}
        self.options.update(provider='trae', agent_id='dispatch-1', since='2026-10-13T00:01:00Z')
        self.launch_hash = hashlib.sha256(b'SECRET launch bearer').hexdigest()
        self.entry.update(source='trae', launchTokenHash=self.launch_hash)
        self.entry['payload']['agentType'] = 'trae'
        self.entry['providerSession']['id'] = 'thread-1'
        self.native.worker['providerSession'] = {
            'agent': 'trae', 'paneKey': 'tab-1:leaf-1', 'processIncarnation': 'pty-1:incarnation-1',
            'connectionId': None, 'providerSession': copy.deepcopy(self.entry['providerSession']),
            'launchTokenHash': self.launch_hash,
            'observedAt': self.entry['receivedAt']}
        self.meta = meta(cli_version=self.cli_version)
        self.records = [self.meta, event(), event(), mirror(), event(thread_id='child'), complete()]
        self.write_log()
        self.write_states()
        self.ledger.sync('rt', self.native.run, [self.native.worker])

    def test_raw_counters_once_without_normalizing_or_reopening(self):
        with patch('swarm_ledger.trae_jsonl.read_prefix', side_effect=AssertionError('reopen')):
            result = self.import_sample()
        self.assertEqual(result['raw_usage']['counts'], counts())
        self.assertEqual(len(result['raw_usage']['requests']), 1)
        self.assertEqual(result['tokens'], {})
        self.assertEqual(result['trae_provenance']['thread_cli_version'], self.cli_version)
        self.assertEqual(result['raw_usage']['contract'], 'trae-jsonl-' + self.cli_version + '-token_usage_record')
        self.assertFalse(result['complete'])
        self.assertIn('counter_semantics_unverified', result['warnings'])
        self.assertIn('runtime_state_not_process_attested', result['warnings'])
        self.assertEqual(result['raw_usage']['binding']['session_id'], 'tree-1')
        self.assertEqual(result['session_id'], 'thread-1')
        self.assertNotIn('launchToken', self.entry)
        self.assertNotIn('SECRET', json.dumps(self.ledger.store.entries('runtime-state-')))
        self.assertIsNone(self.ledger.report('rt', 'run-1')['summary']['total_tokens'])
        export(self.ledger, self.root / 'out')
        self.assertNotIn('SECRET', ''.join(p.read_text() for p in (self.root / 'out').rglob('*') if p.is_file()))

    def test_native_composite_incarnation_preserves_full_pty_id(self):
        # Native PTY IDs include repository/workspace delimiters, not just a UUID.
        self.native.terminal.update(
            ptyId='repo-id::/example/orca-server/smoke@@175a70d6',
            incarnationId='825e865d-e8d1-4f08-b792-df25cbe8f789')
        exact = self.native.worker['providerSession']
        exact['processIncarnation'] = (
            'repo-id::/example/orca-server/smoke@@175a70d6:'
            '825e865d-e8d1-4f08-b792-df25cbe8f789')
        result = self.import_sample()
        self.assertEqual(result['raw_usage']['counts'], counts())
        receipts = self.ledger.store.entries('runtime-state-receipt:')
        self.assertEqual(len(receipts), 1)
        receipt = next(iter(receipts.values()))
        self.assertEqual(receipt['native_scope']['provider_session'], exact)
        for field in ('ptyId', 'incarnationId'):
            self.assertEqual(receipt['identity']['terminal'][field], self.native.terminal[field])

    def test_wrong_or_incomplete_composite_incarnation_rolls_back(self):
        before = copy.deepcopy(self.ledger.get('rt', 'run-1'))
        for incarnation in ('other-pty:incarnation-1', 'pty-1:other-incarnation',
                            'pty-1', ':incarnation-1', 'pty-1:',
                            'pty-1:incarnation-1:extra', '', None, 123, 'incarnation-1'):
            self.native.worker['providerSession']['processIncarnation'] = incarnation
            with self.subTest(incarnation=incarnation):
                with self.assertRaisesRegex(SafetyError, 'runtime_state_exact_provider_session_mismatch'):
                    self.import_sample()
                self.assertFalse(self.ledger.store.entries('runtime-state-'))
                self.assertEqual(self.ledger.get('rt', 'run-1'), before)

    def test_exact_native_session_is_mandatory(self):
        exact = self.native.worker['providerSession']
        mutations = [('agent', 'codex'), ('paneKey', 'other'), ('processIncarnation', 'old'),
                     ('connectionId', 'ssh:other'), ('wslDistro', 'Ubuntu'), ('observedAt', NOW * 1000),
                     ('launchTokenHash', None), ('launchTokenHash', '0' * 64),
                     ('providerSession', {**exact['providerSession'], 'id': 'other'}),
                     ('providerSession', {**exact['providerSession'], 'transcriptPath': '/other.jsonl'})]
        for key, value in mutations:
            self.native.worker['providerSession'] = {**exact, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(SafetyError, 'exact_provider'):
                self.import_sample()
        self.native.worker.pop('providerSession')
        with self.assertRaisesRegex(SafetyError, 'missing_exact_provider'):
            self.import_sample()
        self.assertFalse(self.ledger.store.entries('runtime-state-receipt:'))

    def test_appending_usage_keeps_binding_and_updates_one_subtotal(self):
        first = self.import_sample()
        self.records.extend([event(response='resp-2', at='2026-10-13T00:03:00Z'), event()])
        self.write_log()
        second = self.import_sample()
        self.assertEqual(first['raw_usage']['binding'], second['raw_usage']['binding'])
        self.assertGreater(second['raw_usage']['capture']['bytes'], first['raw_usage']['capture']['bytes'])
        self.assertNotEqual(first['source'], second['source'])
        self.assertEqual(len(second['raw_usage']['requests']), 2)
        self.assertEqual(second['raw_usage']['counts'], {k: v * 2 for k, v in counts().items()})
        samples = self.ledger.get('rt', 'run-1')['agents']['dispatch-1']['samples']
        self.assertEqual(len(samples), 1)
        self.assertEqual(next(iter(samples.values()))['raw_usage']['counts'], second['raw_usage']['counts'])

    def test_parent_hook_only_and_no_remote_or_replay_mapping(self):
        for key, value in [('launchTokenHash', None), ('connectionId', 'ssh:host'), ('isReplay', True),
                           ('providerSessionOnly', True), ('toolAgentId', 'child'), ('restoredUnconfirmed', True)]:
            old = copy.deepcopy(self.entry)
            self.entry[key] = value
            self.write_states()
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.import_sample()
            self.entry.clear()
            self.entry.update(old)

    def test_launch_commitment_is_required_and_strictly_validated(self):
        for value in (None, '', 'a' * 63, 'A' * 64, 'g' * 64, 123):
            self.entry['launchTokenHash'] = value
            self.write_states()
            with self.subTest(value=value), self.assertRaisesRegex(SafetyError, 'invalid_launch_commitment'):
                self.import_sample()
        self.entry.pop('launchTokenHash')
        self.entry['launchToken'] = 'SECRET legacy bearer'
        self.write_states()
        with self.assertRaisesRegex(SafetyError, 'invalid_launch_commitment'):
            self.import_sample()
        self.assertFalse(self.ledger.store.entries('runtime-state-'))
    def test_launch_commitment_change_cannot_rebind_a_pinned_capture(self):
        before = self.capture()
        self.entry['launchTokenHash'] = '0' * 64
        self.write_states()
        with self.assertRaisesRegex(SafetyError, 'session_or_incarnation_changed'):
            self.capture(previous=before)

    def test_unsupported_or_child_metadata_rejected(self):
        for key, value in [('id', 'tree-1'), ('model_provider', 'codex'), ('cli_version', 'future'),
                           ('originator', 'other'), ('source', {'subagent': 'worker'}),
                           ('agent_id', 'child'), ('agent_id', ''), ('agent_id', 0)]:
            self.records[0] = meta(**{key: value})
            self.write_log()
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.import_sample()

    def test_empty_usage_is_unknown_not_zero(self):
        self.records = [self.meta]
        self.write_log()
        result = self.import_sample()
        self.assertIn('no_usage_events_in_window', result['warnings'])
        self.assertIsNone(result['raw_usage']['counts']['total_tokens'])

    def test_native_session_change_during_capture_rolls_back(self):
        reads = 0

        def change(argv):
            nonlocal reads
            if argv[:2] == ('orchestration', 'worker-show'):
                reads += 1
                if reads == 2:
                    self.native.worker['providerSession']['processIncarnation'] = 'changed'

        self.native.on_read = change
        with self.assertRaisesRegex(SafetyError, 'scope_changed'):
            self.import_sample()
        self.assertFalse(self.ledger.store.entries('runtime-state-'))

    def test_cli_routes_trae_runtime_state_and_repeated_sync_deduplicates(self):
        path = self.root / 'bindings.json'
        self.write_json(path, [self.options])
        args = ['--state', str(self.root / 'cli-state'), 'sync', '--runtime-id', 'rt', '--run', 'run-1',
                '--cli', '/explicit-orca', '--bindings', str(path)]
        with patch('swarm_ledger.__main__.Reader', return_value=self.native), \
                patch('swarm_ledger.__main__.Ledger',
                      side_effect=lambda path: Ledger(path, clock=lambda: NOW)), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(main(args), 0)
            self.assertEqual(main(args), 0)
        ledger = Ledger(self.root / 'cli-state')
        self.addCleanup(ledger.close)
        samples = ledger.get('rt', 'run-1')['agents']['dispatch-1']['samples']
        self.assertEqual(len(samples), 1)
        self.assertEqual(next(iter(samples.values()))['raw_usage']['counts'], counts())

    def test_rewrite_inside_parser_rejected_without_persisting_usage(self):
        from swarm_ledger import runtime_trae
        original = runtime_trae.sample

        def changed(*args):
            result = original(*args)
            self.records[1] = event(usage=counts(999))
            self.write_log()
            return result

        with patch.object(runtime_trae, 'sample', side_effect=changed), \
                self.assertRaisesRegex(SafetyError, 'changed_during_capture'):
            self.import_sample()
        self.assertFalse(self.ledger.store.entries('runtime-state-'))


class RuntimeTrae02101Tests(RuntimeTraeTests):
    """The new producer passes the same exact native-binding fences as the old one."""
    cli_version = '0.210.1'


class RuntimeTrae02111Tests(RuntimeTraeTests):
    cli_version = '0.211.1'


class RuntimeTrae02121Tests(RuntimeTraeTests):
    cli_version = '0.212.1'


class RuntimeTrae02131Tests(RuntimeTraeTests):
    cli_version = '0.213.1'
