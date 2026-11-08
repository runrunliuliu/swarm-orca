// Why its own file: `worktree.test.ts` is already at its line budget, and this is a distinct
// contract — what `worktree.show` returns *beside* the record.
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree.show readiness', () => {
  it('returns task workspace readiness beside the record, not inside it', async () => {
    const readiness = {
      state: 'drifted',
      reasons: ['HEAD no longer contains the pinned baseline'],
      pinnedSha: 'a'.repeat(40),
      checkedAt: 1_700_000_000_000
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', path: '/workspace/wt-1' }),
      inspectTaskWorkspaceReadiness: vi.fn().mockResolvedValue(readiness)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('worktree.show', { worktree: 'id:wt-1' }))

    // Why beside: a client that already parses `worktree` keeps working unchanged, while a caller
    // that wants the task contract can read the probe taken now.
    expect(response).toMatchObject({
      ok: true,
      result: { worktree: { id: 'wt-1' }, taskWorkspace: readiness }
    })
    expect(runtime.inspectTaskWorkspaceReadiness).toHaveBeenCalledWith('id:wt-1')
  })
})
