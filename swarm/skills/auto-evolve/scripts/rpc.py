#!/usr/bin/env python3
"""Bounded direct-RPC tool for auto_evolve. Read SKILL.md before --execute.

Only worktree.create can mutate; preview is its default. A durable per-issue
intent prevents repeat submissions from this tool's shared state directory.
This does not implement approval, global locking or a background scheduler.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from rpc_transport import RpcError, call

READ_METHODS = frozenset({
    'status.get', 'repo.show', 'github.repoSlug', 'github.repoUpstream',
    'github.listWorkItems', 'github.workItem', 'github.workItemDetails',
    'worktree.list', 'worktree.show', 'worktree.createStatus',
    'terminal.list', 'terminal.show', 'terminal.read',
})
CREATE_FIELDS = frozenset({
    'repo', 'name', 'baseBranch', 'linkedIssue', 'linkedWorkItem',
    'linkedTaskSourceContext', 'startupAgent', 'startupPrompt',
    'clientMutationId', 'noParent', 'setupDecision', 'activate', 'sparseCheckout',
})


def require(condition, message):
    if not condition:
        raise RpcError(message)


def validate(method, params):
    require(isinstance(params, dict), 'params must be an object')
    require(method in READ_METHODS or method == 'worktree.create', 'method_not_allowed')
    if method != 'worktree.create':
        return
    require(not (params.keys() - CREATE_FIELDS), 'unsupported_create_fields')
    for field in ('repo', 'name', 'baseBranch', 'startupAgent', 'startupPrompt', 'clientMutationId'):
        require(isinstance(params.get(field), str) and params[field].strip(), f'missing_{field}')
    repo = params['repo']
    require(repo.startswith('id:') and len(repo) > 3 and '::' not in repo, 'explicit_repo_id_required')
    require(re.fullmatch(r'[0-9a-f]{40}', params['baseBranch']), 'pinned_base_sha_required')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', params['name']), 'unsafe_workspace_name')
    require(len(params['clientMutationId']) <= 128, 'invalid_client_mutation_id')
    number = params.get('linkedIssue')
    require(type(number) is int and 0 < number <= 9007199254740991, 'positive_github_issue_required')
    require(params.get('noParent') is True, 'independent_workspace_required')
    require(params.get('setupDecision') == 'skip', 'setup_skip_required')
    require(params.get('activate', False) is False, 'background_create_required')
    item = params.get('linkedWorkItem')
    context = params.get('linkedTaskSourceContext')
    require(isinstance(item, dict) and isinstance(context, dict), 'explicit_task_source_required')
    require(item.get('provider') == 'github' and item.get('type') == 'issue'
            and item.get('number') == number and item.get('repoId') == repo[3:], 'issue_identity_mismatch')
    require(all(isinstance(item.get(k), str) and item[k].strip() for k in ('title', 'url')),
            'issue_title_and_url_required')
    require(context.get('kind') == 'task-source' and context.get('provider') == 'github'
            and context.get('repoId') == repo[3:] and context.get('hostId') == 'local'
            and isinstance(context.get('projectId'), str) and context['projectId'].strip(),
            'local_owner_task_source_required')
    identity = context.get('providerIdentity', {})
    require(isinstance(identity, dict) and identity.get('provider') == 'github'
            and all(isinstance(identity.get(k), str) and identity[k].strip()
                    for k in ('host', 'owner', 'repo')), 'github_provider_identity_required')
    from urllib.parse import urlsplit
    url = urlsplit(item['url'])
    require(url.scheme == 'https' and url.netloc.casefold() == identity['host'].casefold()
            and url.path.casefold() == f"/{identity['owner']}/{identity['repo']}/issues/{number}".casefold()
            and not url.query and not url.fragment, 'issue_url_identity_mismatch')
    if 'sparseCheckout' in params:
        sparse = params['sparseCheckout']
        require(isinstance(sparse, dict) and sparse.get('mode') == 'task-workspace-v1',
                'task_sparse_mode_required')
        for key in ('directories', 'requiredPaths'):
            require(isinstance(sparse.get(key), list) and sparse[key]
                    and all(isinstance(p, str) and p for p in sparse[key]), f'sparse_{key}_required')
        # Canonical path/tree/cone checks remain the server's job, not a second Git implementation.


def intent_path(state_dir, runtime_id, params):
    # Exclude runtime generation: a restart must NOT reset the issue lock.
    # Use the same private state directory for this runtime/profile across restarts.
    identity = params['linkedTaskSourceContext']['providerIdentity']
    key = json.dumps([params['repo'], identity['host'].casefold(), identity['owner'].casefold(),
                      identity['repo'].casefold(), params['linkedIssue']], separators=(',', ':'))
    return Path(state_dir) / (hashlib.sha256(key.encode()).hexdigest() + '.json')


def sync_directory(path):
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def prepare_state_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A file fsync cannot persist a newly created directory's entry in its parent.
    # Sync bottom-up through existing ancestors too: an earlier failed preparation
    # may have left a visible but not yet durably linked directory hierarchy.
    # Failure is fatal before any intent or RPC; never downgrade unsupported fsync.
    for directory in (path, *path.parents):
        sync_directory(directory)


def record_exclusive(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def invoke(args, params, transport=call):
    validate(args.method, params)
    if args.method in READ_METHODS:
        require(not args.execute, '--execute is only for worktree.create')
        return transport(args.metadata, args.runtime_id, args.method, params, args.timeout)
    if not args.execute:
        return {'mode': 'preview', 'sent': False, 'method': args.method, 'params': params}
    require(args.state_dir and Path(args.state_dir).is_absolute(), 'absolute_state_dir_required')
    root = Path(args.state_dir).resolve()
    prepare_state_directory(root)
    path = intent_path(root, args.runtime_id, params)
    intent = {'state': 'intent_outcome_unknown', 'runtimeId': args.runtime_id,
              'method': args.method, 'params': params}
    # Intent survives refusal, timeout, process crash and restart. Never auto-delete it.
    record_exclusive(path, intent)
    response = transport(args.metadata, args.runtime_id, args.method, params, args.timeout)
    record_exclusive(path.with_suffix('.response.json'), response)
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', required=True, help='Explicit owner profile orca-runtime.json; never print it')
    parser.add_argument('--runtime-id', required=True, help='Runtime identity verified for this invocation')
    parser.add_argument('--method', required=True)
    parser.add_argument('--params-file', required=True, help='JSON object; task data stays out of shell argv')
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--state-dir', help='Private, persistent, shared across invocations of this launcher')
    args = parser.parse_args()
    try:
        require(0 < args.timeout <= 600, 'invalid_timeout')
        result = invoke(args, json.loads(Path(args.params_file).read_text()))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get('ok', True) else 1
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Never dump metadata/request/credentials in a traceback. Native failures are returned above.
        message = str(error) if isinstance(error, (RpcError, OSError)) else type(error).__name__
        print(json.dumps({'ok': False, 'error': {'code': type(error).__name__, 'message': message},
                          'recovery': 'Stop. If executing, inspect the retained intent and native state; do not resubmit.'}),
              file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
