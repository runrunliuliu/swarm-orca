import { describe, expect, it, vi } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from '../../args'
import { RuntimeClient } from '../../runtime-client'
import { ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './worker-launch-handler'

vi.mock('../../format', () => ({ printResult: vi.fn() }))

describe('worker-start existing workspace creation flags', () => {
  const creationFlags = [
    'name',
    'repo',
    'base-branch',
    'display-name',
    'comment',
    'setup',
    'sparse-dir'
  ]

  for (const worktree of [undefined, 'current', 'id:repo::/worker', 'id:folder', 'name:review']) {
    for (const creationFlag of creationFlags) {
      it(`rejects --${creationFlag} for ${worktree ?? 'implicit current'} before any RPC`, async () => {
        const call = vi.fn()
        const client = new RuntimeClient('/tmp/orca-worker-placement-unit', 60_000, null, null)
        client.call = call
        const flags = new Map<string, string | boolean>([
          ['task', 'task_review'],
          ['agent', 'trae'],
          ['model', 'gpt-5.4'],
          [creationFlag, 'wave1-review']
        ])
        if (worktree) {
          flags.set('worktree', worktree)
        }
        await expect(
          ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
            flags,
            client,
            cwd: '/task',
            json: true
          })
        ).rejects.toMatchObject({
          code: 'invalid_argument',
          message: expect.stringContaining(`--${creationFlag}`)
        })
        expect(call).not.toHaveBeenCalled()
      })
    }
  }

  it('also rejects remote existing placement and gives an explicit title correction', async () => {
    const call = vi.fn()
    const client = new RuntimeClient('/tmp/orca-worker-placement-unit', 60_000, null, null)
    client.call = call
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags: new Map([
          ['worktree', 'id:remote-folder'],
          ['on', 'remote'],
          ['name', 'review']
        ]),
        client,
        cwd: '/task',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('--task-title')
    })
    expect(call).not.toHaveBeenCalled()
  })

  for (const worktree of ['id:repo::/worker', 'id:folder', 'new-child', 'new-top-level']) {
    it(`preserves valid ${worktree} placement and an inline Task title`, async () => {
      const call = vi.fn().mockResolvedValue({ result: { state: 'ready' } })
      const client = new RuntimeClient('/tmp/orca-worker-placement-unit', 60_000, null, null)
      client.call = call
      const flags = new Map<string, string | boolean>([
        ['worktree', worktree],
        ['spec', 'Review code'],
        ['task-title', 'wave1-review'],
        ['agent', 'codex'],
        ['from', 'term_coordinator']
      ])
      if (worktree.startsWith('new-')) {
        flags.set('name', 'new-review')
        flags.set('repo', 'id:repo')
        flags.set('setup', 'skip')
      }
      await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags,
        client,
        cwd: '/task',
        json: true
      })
      expect(call).toHaveBeenCalledExactlyOnceWith(
        'orchestration.workerStart',
        expect.objectContaining({
          worktree,
          spec: 'Review code',
          taskTitle: 'wave1-review',
          name: worktree.startsWith('new-') ? 'new-review' : undefined
        })
      )
    })
  }

  it('forwards repeated sparse directories for new worktree creation', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        result: { capabilities: [ORCHESTRATION_WORKER_SPARSE_CHECKOUT_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({ result: { state: 'ready' } })
    const client = new RuntimeClient('/tmp/orca-worker-placement-unit', 60_000, null, null)
    client.call = call

    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['worktree', 'new-child'],
        ['name', 'new-review'],
        ['task', 'task_review'],
        ['agent', 'codex'],
        ['from', 'term_coordinator'],
        ['sparse-dir', ['packages/web', 'docs'].join(REPEATED_FLAG_SEPARATOR)]
      ]),
      client,
      cwd: '/task',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        sparseDirectories: ['packages/web', 'docs']
      })
    )
  })
})
