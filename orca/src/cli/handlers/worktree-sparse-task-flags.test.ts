// The CLI is the first shipped caller of the task sparse contract; these cases are about what it
// refuses to send, and what it must not silently default.
import { describe, expect, it, vi } from 'vitest'
import {
  assertSparseTaskSetupDecision,
  assertSparseTaskWorkspaceCapability,
  readSparseTaskCheckoutFlags
} from './worktree-sparse-task-flags'

const flags = (entries: [string, string | boolean][]) => new Map(entries)

describe('readSparseTaskCheckoutFlags', () => {
  it('sends no task payload for a create that did not ask for one', () => {
    expect(readSparseTaskCheckoutFlags(flags([['name', 'plain']]))).toBeUndefined()
    expect(
      readSparseTaskCheckoutFlags(flags([['sparse-task-dir', 'swarm']]))
    ).toMatchObject({ mode: 'task-workspace-v1', directories: ['swarm'] })
  })

  it('collects repeated directories and required paths', () => {
    expect(
      readSparseTaskCheckoutFlags(
        flags([
          ['sparse-task-dir', 'swarm\u0000orca/src'],
          ['sparse-task-required', 'AGENTS.md\u0000swarm/skills/SKILL.md']
        ])
      )
    ).toEqual({
      mode: 'task-workspace-v1',
      directories: ['swarm', 'orca/src'],
      requiredPaths: ['AGENTS.md', 'swarm/skills/SKILL.md']
    })
  })

  it('refuses required paths without a directory, because nothing would be pinned', () => {
    expect(() =>
      readSparseTaskCheckoutFlags(flags([['sparse-task-required', 'AGENTS.md']]))
    ).toThrow(/sparse-task-dir/)
  })
})

describe('assertSparseTaskSetupDecision', () => {
  const request = { mode: 'task-workspace-v1' as const, directories: ['swarm'] }

  it('requires the caller to say --setup skip', () => {
    expect(() => assertSparseTaskSetupDecision(flags([]), request)).toThrow(/--setup skip/)
    expect(() => assertSparseTaskSetupDecision(flags([['setup', 'run']]), request)).toThrow()
    expect(() => assertSparseTaskSetupDecision(flags([['setup', 'skip']]), request)).not.toThrow()
  })

  it('leaves legacy creates alone', () => {
    expect(() => assertSparseTaskSetupDecision(flags([['setup', 'run']]), undefined)).not.toThrow()
  })
})

describe('assertSparseTaskWorkspaceCapability', () => {
  const request = { mode: 'task-workspace-v1' as const, directories: ['swarm'] }

  it('refuses an older host that would strip the mode and answer as legacy sparse', async () => {
    const client = { call: vi.fn().mockResolvedValue({ result: { capabilities: [] } }) }

    await expect(assertSparseTaskWorkspaceCapability(client, request)).rejects.toThrow(
      /does not support task sparse workspaces/
    )
  })

  it('passes when the host advertises the capability, and never asks for a legacy create', async () => {
    const client = {
      call: vi.fn().mockResolvedValue({
        result: { capabilities: ['worktree.sparse-task-workspace.v1'] }
      })
    }

    await expect(assertSparseTaskWorkspaceCapability(client, request)).resolves.toBeUndefined()
    expect(client.call).toHaveBeenCalledWith('status')
    // A legacy create must not spend a status round trip.
    client.call.mockClear()
    await expect(assertSparseTaskWorkspaceCapability(client, undefined)).resolves.toBeUndefined()
    expect(client.call).not.toHaveBeenCalled()
  })
})
