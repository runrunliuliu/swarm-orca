import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from './worktree-create-params'

describe('WorktreeCreate.sparseCheckout', () => {
  it('keeps the legacy sparse payload byte-identical for a caller that never opted in', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'path:/repo',
      sparseCheckout: { directories: ['swarm'], presetId: 'preset-1' }
    })

    expect(parsed.sparseCheckout).toEqual({ directories: ['swarm'], presetId: 'preset-1' })
  })

  it('carries the task contract selector and its declared required paths', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'path:/repo',
      sparseCheckout: {
        directories: ['swarm'],
        mode: 'task-workspace-v1',
        requiredPaths: ['AGENTS.md']
      }
    })

    expect(parsed.sparseCheckout).toEqual({
      directories: ['swarm'],
      mode: 'task-workspace-v1',
      requiredPaths: ['AGENTS.md']
    })
  })

  it('rejects an unknown mode instead of silently treating it as legacy', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'path:/repo',
      sparseCheckout: { directories: ['swarm'], mode: 'task-workspace-v2' }
    })

    expect(parsed.success).toBe(false)
  })
})
