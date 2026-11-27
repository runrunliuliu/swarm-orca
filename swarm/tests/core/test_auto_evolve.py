"""Deterministic auto_evolve tool tests; no Orca process, CLI or Agent starts."""
import copy
import importlib.util
import json
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills' / 'auto-evolve' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
try:
    spec = importlib.util.spec_from_file_location('auto_evolve_rpc', SCRIPTS / 'rpc.py')
    rpc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rpc)
finally:
    sys.path.remove(str(SCRIPTS))
from rpc_transport import RpcError, call


def request():
    return {
        'repo': 'id:repo-test', 'name': 'issue-123-example', 'baseBranch': 'a' * 40,
        'linkedIssue': 123,
        'linkedWorkItem': {'provider': 'github', 'type': 'issue', 'number': 123,
                           'title': 'Example', 'url': 'https://github.com/example/project/issues/123',
                           'repoId': 'repo-test'},
        'linkedTaskSourceContext': {'kind': 'task-source', 'provider': 'github',
                                   'hostId': 'local', 'projectId': 'project-test', 'repoId': 'repo-test',
                                   'providerIdentity': {'provider': 'github', 'host': 'github.com',
                                                        'owner': 'example', 'repo': 'project'}},
        'startupAgent': 'pi', 'startupPrompt': 'Bounded fixture only',
        'noParent': True, 'setupDecision': 'skip', 'activate': False,
        'clientMutationId': 'fixture-intent-1',
    }


def args(root, execute=False):
    return SimpleNamespace(method='worktree.create', metadata='/not/read/in/preview',
                           runtime_id='runtime-test', timeout=1, execute=execute,
                           state_dir=str(root / 'intents'))


class AutoEvolvePolicyTests(unittest.TestCase):
    def test_skill_name_and_relative_links(self):
        import re
        skill = SCRIPTS.parent / 'SKILL.md'
        text = skill.read_text()
        name = re.search(r'^name: (.+)$', text, re.M).group(1)
        self.assertEqual(name, skill.parent.name)
        self.assertRegex(name, r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
        for document in (skill, skill.parent / 'references' / 'rpc.md'):
            for target in re.findall(r'\]\(([^)]+)\)', document.read_text()):
                self.assertTrue((document.parent / target.split('#')[0]).exists(), target)

    def test_preview_has_no_io(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            transport = Mock(side_effect=AssertionError('network in preview'))
            output = rpc.invoke(args(root), request(), transport)
            self.assertEqual(output['mode'], 'preview')
            self.assertIs(output['sent'], False)
            self.assertEqual(list(root.iterdir()), [])
            transport.assert_not_called()

    def test_unknown_and_other_mutation_methods_denied(self):
        for method in ('terminal.create', 'terminal.send', 'repo.update', 'github.updateIssue', 'bogus'):
            with self.subTest(method=method), self.assertRaises(RpcError):
                rpc.validate(method, {})

    def test_read_does_not_create_intent(self):
        with tempfile.TemporaryDirectory() as folder:
            a = args(Path(folder))
            a.method = 'status.get'
            transport = Mock(return_value={'ok': True, 'result': {}})
            rpc.invoke(a, {}, transport)
            transport.assert_called_once()
            self.assertEqual(list(Path(folder).iterdir()), [])
            a.execute = True
            with self.assertRaises(RpcError):
                rpc.invoke(a, {}, transport)
            self.assertEqual(transport.call_count, 1)

    def test_unsafe_or_incomplete_create_denied(self):
        changes = [('repo', 'current'), ('repo', 'id:r::/checkout'), ('baseBranch', 'origin/main'),
                   ('name', '../escape'), ('linkedIssue', True), ('linkedIssue', 0),
                   ('startupPrompt', ''), ('noParent', False), ('setupDecision', 'run'),
                   ('activate', True), ('clientMutationId', 'x' * 129),
                   ('startupCommand', 'sh -c danger'), ('startupDraft', 'not submitted')]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(RpcError):
                params = request()
                params[key] = value
                rpc.validate('worktree.create', params)

    def test_issue_and_host_must_match(self):
        changes = [('linkedWorkItem', 'number', 124), ('linkedWorkItem', 'repoId', 'other'),
                   ('linkedWorkItem', 'url', 'https://github.com/other/project/issues/123'),
                   ('linkedTaskSourceContext', 'hostId', 'runtime:other'),
                   ('linkedTaskSourceContext', 'repoId', 'other'),
                   ('linkedTaskSourceContext', 'providerIdentity', None)]
        for field, key, value in changes:
            with self.subTest(field=field, key=key), self.assertRaises(RpcError):
                params = request()
                params[field][key] = value
                rpc.validate('worktree.create', params)

    def test_sparse_requires_task_mode_and_required_paths(self):
        params = request()
        for sparse in ({'directories': ['swarm/skills']},
                       {'mode': 'task-workspace-v1', 'directories': ['swarm/skills'], 'requiredPaths': []}):
            params['sparseCheckout'] = sparse
            with self.assertRaises(RpcError):
                rpc.validate('worktree.create', params)
        params['sparseCheckout'] = {'mode': 'task-workspace-v1', 'directories': ['swarm/skills'],
                                    'requiredPaths': ['AGENTS.md']}
        rpc.validate('worktree.create', params)

    def test_intent_precedes_send_and_duplicate_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            a, params = args(Path(folder), True), request()
            path = rpc.intent_path(a.state_dir, a.runtime_id, params)

            def transport(*unused):
                self.assertEqual(json.loads(path.read_text())['params'], params)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                return {'ok': True, 'result': {'worktree': {'id': 'fixture'}}}

            send = Mock(side_effect=transport)
            rpc.invoke(a, params, send)
            self.assertTrue(path.with_suffix('.response.json').exists())
            params['clientMutationId'] = 'new-key-does-not-bypass'
            a.runtime_id = 'restarted-runtime'
            with self.assertRaises(FileExistsError):
                rpc.invoke(a, params, send)
            send.assert_called_once()

    def test_unwritable_intent_stops_before_network(self):
        with tempfile.TemporaryDirectory() as folder:
            a = args(Path(folder), True)
            send = Mock()
            with patch.object(rpc, 'record_exclusive', side_effect=OSError('fixture fsync failure')):
                with self.assertRaises(OSError):
                    rpc.invoke(a, request(), send)
            send.assert_not_called()

    def test_directory_hierarchy_is_synced_before_sending(self):
        with tempfile.TemporaryDirectory() as folder:
            a = args(Path(folder) / 'new-parent' / 'new-child', True)
            root = Path(a.state_dir).resolve()
            events = []

            def transport(*unused):
                events.append(('send', None))
                return {'ok': True, 'result': {}}

            with patch.object(rpc, 'sync_directory', side_effect=lambda p: events.append(('sync', p))):
                rpc.invoke(a, request(), transport)
            before_send = events[:events.index(('send', None))]
            self.assertEqual(before_send, [('sync', p) for p in (root, *root.parents, root)])
            self.assertEqual(events[-1], ('sync', root))  # response directory entry

    def test_parent_sync_failure_blocks_even_if_directory_already_exists(self):
        for exists in (False, True):
            with self.subTest(exists=exists), tempfile.TemporaryDirectory() as folder:
                a = args(Path(folder) / 'parent', True)
                root = Path(a.state_dir).resolve()
                if exists:
                    root.mkdir(parents=True)
                send = Mock()

                def fail_on_parent(path):
                    if path == root.parent:
                        raise OSError('parent persistence failed')

                with patch.object(rpc, 'sync_directory', side_effect=fail_on_parent):
                    with self.assertRaisesRegex(OSError, 'parent persistence failed'):
                        rpc.invoke(a, request(), send)
                send.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])

    def test_actual_parent_fsync_failure_prevents_transport(self):
        with tempfile.TemporaryDirectory() as folder:
            a = args(Path(folder), True)
            parent = Path(folder).stat()
            real_fsync = rpc.os.fsync
            send = Mock(return_value={'ok': True, 'result': {}})

            def fail_parent_fd(fd):
                info = rpc.os.fstat(fd)
                if (info.st_dev, info.st_ino) == (parent.st_dev, parent.st_ino):
                    raise OSError('ancestor fsync refused')
                return real_fsync(fd)

            with patch.object(rpc.os, 'fsync', side_effect=fail_parent_fd):
                with self.assertRaisesRegex(OSError, 'ancestor fsync refused'):
                    rpc.invoke(a, request(), send)
            send.assert_not_called()

    def test_directory_sync_closes_fd_on_failure(self):
        with patch.object(rpc.os, 'open', return_value=99), \
                patch.object(rpc.os, 'fsync', side_effect=OSError('sync failed')), \
                patch.object(rpc.os, 'close') as close:
            with self.assertRaises(OSError):
                rpc.sync_directory(Path('/fixture'))
            close.assert_called_once_with(99)

    def test_symlink_state_root_syncs_canonical_ancestors(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            target = base / 'real'
            target.mkdir()
            link = base / 'alias'
            link.symlink_to(target, target_is_directory=True)
            a = args(base, True)
            a.state_dir = str(link / 'intents')
            with patch.object(rpc, 'sync_directory') as sync:
                rpc.invoke(a, request(), Mock(return_value={'ok': True, 'result': {}}))
            self.assertEqual(sync.call_args_list[0].args[0], (target / 'intents').resolve())
            self.assertNotIn(link, [c.args[0] for c in sync.call_args_list])

    def test_unknown_result_retains_intent_without_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            a, params = args(Path(folder), True), request()
            send = Mock(side_effect=TimeoutError('fixture timeout'))
            with self.assertRaises(TimeoutError):
                rpc.invoke(a, params, send)
            path = rpc.intent_path(a.state_dir, a.runtime_id, params)
            self.assertTrue(path.exists())
            self.assertFalse(path.with_suffix('.response.json').exists())
            with self.assertRaises(FileExistsError):
                rpc.invoke(a, params, send)
            send.assert_called_once()

    def test_native_failure_is_recorded_not_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            a, params = args(Path(folder), True), request()
            failure = {'ok': False, 'error': {'code': 'access_denied'}}
            send = Mock(return_value=failure)
            self.assertEqual(rpc.invoke(a, params, send), failure)
            path = rpc.intent_path(a.state_dir, a.runtime_id, params)
            self.assertEqual(json.loads(path.with_suffix('.response.json').read_text()), failure)
            send.assert_called_once()

    def test_concurrent_intent_has_one_winner(self):
        with tempfile.TemporaryDirectory() as folder:
            a, params = args(Path(folder), True), request()
            barrier = threading.Barrier(2)
            outcomes = []
            send = Mock(return_value={'ok': True, 'result': {}})

            def attempt():
                barrier.wait()
                try:
                    rpc.invoke(a, copy.deepcopy(params), send)
                    outcomes.append('sent')
                except FileExistsError:
                    outcomes.append('blocked')

            threads = [threading.Thread(target=attempt) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(3)
                self.assertFalse(thread.is_alive())
            self.assertCountEqual(outcomes, ['sent', 'blocked'])
            send.assert_called_once()


class AutoEvolveTransportTests(unittest.TestCase):
    def exchange(self, respond, timeout=1):
        with tempfile.TemporaryDirectory(prefix='ae-', dir='/tmp') as folder:
            endpoint = str(Path(folder) / 'rpc.sock')
            metadata = Path(folder) / 'metadata.json'
            metadata.write_text(json.dumps({'runtimeId': 'runtime-test', 'authToken': 'fixture-secret',
                                           'transports': [{'kind': 'unix', 'endpoint': endpoint}]}))
            errors = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(endpoint)
                server.listen(1)
                server.settimeout(2)

                def serve():
                    try:
                        conn, _ = server.accept()
                        with conn:
                            conn.settimeout(2)
                            with conn.makefile('rb') as stream:
                                req = json.loads(stream.readline())
                            self.assertEqual(req['authToken'], 'fixture-secret')
                            self.assertEqual(req['method'], 'status.get')
                            respond(conn, req)
                    except Exception as error:
                        errors.append(error)

                thread = threading.Thread(target=serve)
                thread.start()
                try:
                    return call(metadata, 'runtime-test', 'status.get', {}, timeout)
                finally:
                    thread.join(3)
                    self.assertFalse(thread.is_alive())
                    if errors:
                        raise errors[0]

    @staticmethod
    def frame(req):
        return {'id': req['id'], 'ok': True, 'result': {'ready': True},
                '_meta': {'runtimeId': 'runtime-test'}}

    def test_keepalive_and_split_frame(self):
        def respond(conn, req):
            wire = (json.dumps(self.frame(req)) + '\n').encode()
            conn.sendall(b'{"_keepalive":true}\n' + wire[:12])
            conn.sendall(wire[12:])
        self.assertTrue(self.exchange(respond)['result']['ready'])

    def test_mismatched_request_and_runtime_and_envelope(self):
        for kind in ('id', '_meta', 'ok'):
            def respond(conn, req):
                frame = self.frame(req)
                frame[kind] = 'bad'
                conn.sendall((json.dumps(frame) + '\n').encode())
            with self.subTest(kind=kind), self.assertRaises(RpcError):
                self.exchange(respond)

    def test_eof_is_unknown(self):
        with self.assertRaisesRegex(RpcError, 'outcome unknown'):
            self.exchange(lambda conn, req: None)

    def test_connect_send_and_receive_share_one_deadline(self):
        connection = Mock()
        connection.recv.return_value = (json.dumps(self.frame({'id': 'fixture-id'})) + '\n').encode()
        with patch('rpc_transport.read_metadata', return_value=('/fixture.sock', 'fixture')), \
                patch('rpc_transport.uuid.uuid4', return_value='fixture-id'), \
                patch('rpc_transport.time.monotonic', side_effect=[100, 100, 102, 104]), \
                patch('rpc_transport.socket.socket') as socket_factory:
            socket_factory.return_value.__enter__.return_value = connection
            self.assertTrue(call('/fixture', 'runtime-test', 'status.get', {}, timeout=5)['ok'])
        self.assertEqual([c.args[0] for c in connection.settimeout.call_args_list], [5, 3, 1])

    def test_no_send_after_connect_exhausts_deadline(self):
        connection = Mock()
        with patch('rpc_transport.read_metadata', return_value=('/fixture.sock', 'fixture')), \
                patch('rpc_transport.time.monotonic', side_effect=[100, 100, 106]), \
                patch('rpc_transport.socket.socket') as socket_factory:
            socket_factory.return_value.__enter__.return_value = connection
            with self.assertRaisesRegex(RpcError, 'runtime_timeout'):
                call('/fixture', 'runtime-test', 'status.get', {}, timeout=5)
        connection.connect.assert_called_once()
        connection.sendall.assert_not_called()

    def test_deadline_is_not_extended_by_keepalives(self):
        def respond(conn, req):
            for _ in range(30):
                try:
                    conn.sendall(b'{"_keepalive":true}\n')
                except BrokenPipeError:
                    return
                threading.Event().wait(0.01)
        with self.assertRaises((TimeoutError, RpcError)):
            self.exchange(respond, timeout=0.03)

    def test_oversized_and_invalid_frames_fail_closed(self):
        with patch('rpc_transport.MAX_FRAME', 32):
            with self.assertRaisesRegex(RpcError, 'frame_too_large'):
                self.exchange(lambda conn, req: conn.sendall(b'x' * 33 + b'\n'))
        with self.assertRaises(ValueError):
            self.exchange(lambda conn, req: conn.sendall(b'not-json\n'))

    def test_native_error_envelope_preserved(self):
        def respond(conn, req):
            frame = self.frame(req)
            frame.pop('result')
            frame.update(ok=False, error={'code': 'runtime_access_denied'})
            conn.sendall((json.dumps(frame) + '\n').encode())
        self.assertEqual(self.exchange(respond)['error']['code'], 'runtime_access_denied')

    def test_metadata_identity_refused_before_connect(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'meta.json'
            path.write_text(json.dumps({'runtimeId': 'other', 'authToken': 'do-not-print'}))
            with self.assertRaisesRegex(RpcError, 'runtime_identity_mismatch') as caught:
                call(path, 'runtime-test', 'status.get', {})
            self.assertNotIn('do-not-print', str(caught.exception))

    def test_legacy_metadata_and_no_unix(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'meta.json'
            meta = {'runtimeId': 'r', 'authToken': 'fixture',
                    'transport': {'kind': 'unix', 'endpoint': '/tmp/fixture.sock'}}
            path.write_text(json.dumps(meta))
            from rpc_transport import read_metadata
            self.assertEqual(read_metadata(path, 'r')[0], '/tmp/fixture.sock')
            meta['transport']['kind'] = 'websocket'
            path.write_text(json.dumps(meta))
            with self.assertRaises(RpcError):
                read_metadata(path, 'r')


if __name__ == '__main__':
    unittest.main()
