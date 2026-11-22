import { expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

const mocks = vi.hoisted(() => ({ getCliStatus: vi.fn() }))

vi.mock('../runtime-client', () => {
  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeClient {
    getCliStatus = mocks.getCliStatus
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    getDefaultUserDataPath: () => '/tmp/orca-load-boundary'
  }
})

// Why: `orca history backfill` must stay a launcher. The agent session index, the
// backfill write and the profile-state maintenance lock live in the main-process
// graph, which the CLI build project deliberately does not compile
// (`config/tsconfig.cli.json`). Importing any of them here would put the AI-Vault
// scanner back into the CLI bundle — the exact regression this file exists to catch.
vi.mock('../../main/task-records/task-records-session-index-lookup', () => {
  throw new Error('The agent session index loaded in the CLI process')
})
vi.mock('../../main/task-records/task-records-backfill', () => {
  throw new Error('The backfill writer loaded in the CLI process')
})
vi.mock('../../main/startup/history-backfill-preflight', () => {
  throw new Error('The main-process preflight loaded in the CLI process')
})
vi.mock('../../main/persistence/profile-state/profile-state-access', () => {
  throw new Error('Profile-state maintenance loaded in the CLI process')
})
vi.mock('../runtime/history-backfill-launch', () => ({
  canLaunchHistoryBackfill: () => true,
  launchHistoryBackfill: async () => {
    throw new Error('not reached')
  }
}))

import { HISTORY_HANDLERS } from './history'

function context(flags: Record<string, string>): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    client: {} as RuntimeClient,
    cwd: '/',
    json: false
  }
}

it('refuses a running runtime without loading the main-process backfill graph', async () => {
  mocks.getCliStatus.mockResolvedValue({
    result: { runtime: { reachable: true }, app: { running: true } }
  })
  await expect(
    HISTORY_HANDLERS['history backfill']!(context({ task: 'repo-1#53' }))
  ).rejects.toThrow('Stop Orca before `history backfill`')
})

it('rejects a malformed --task without loading the main-process backfill graph', async () => {
  await expect(HISTORY_HANDLERS['history backfill']!(context({ task: 'repo-1' }))).rejects.toThrow(
    '--task expects <repo>#<number>'
  )
})
