// M4 read-only query: it must ask the runtime for the repo's unsettled attempts and print what each
// one actually left behind — without settling, cleaning or retrying anything.
import { describe, expect, it, vi } from 'vitest'
import { formatTaskCreateStatus } from '../workspace-format'
import { handleWorktreeCreateStatus } from './worktree-create-status'

const payload = {
  repoId: 'repo-1',
  repoPath: '/repo',
  attempts: [
    {
      attempt: {
        requestId: 'req-1',
        branch: 'task-a',
        worktreePath: '/repo-wt-a',
        state: 'pending',
        reasons: [],
        pinnedSha: 'a'.repeat(40),
        createdAt: 1
      },
      observation: {
        state: 'partial',
        reasons: ['registered but the directory is missing'],
        ghostRegistration: true,
        directoryExists: false
      }
    }
  ]
}

const flags = (entries: [string, string | boolean][]) => new Map(entries)

describe('worktree create-status', () => {
  it('asks for the repo journal with an optional limit', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: payload }) }

    await handleWorktreeCreateStatus({ flags: flags([['repo', 'path:/repo']]), client, json: true })
    expect(client.call).toHaveBeenCalledWith('worktree.createStatus', { repo: 'path:/repo' })

    client.call.mockClear()
    await handleWorktreeCreateStatus({
      flags: flags([['repo', 'path:/repo'], ['limit', '5']]),
      client,
      json: true
    })
    expect(client.call).toHaveBeenCalledWith('worktree.createStatus', {
      repo: 'path:/repo',
      limit: 5
    })
  })

  it('prints the recorded state and the on-disk state separately, including a ghost', () => {
    const text = formatTaskCreateStatus(payload)

    expect(text).toContain('/repo-wt-a (branch task-a)')
    expect(text).toContain('recorded: pending')
    expect(text).toContain('on disk: partial (directory missing, registration without directory)')
    expect(text).toContain('registered but the directory is missing')
  })

  it('says so plainly when nothing is unsettled', () => {
    expect(formatTaskCreateStatus({ ...payload, attempts: [] })).toBe(
      'no unsettled task creates for /repo'
    )
  })
})
