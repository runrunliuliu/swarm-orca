import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { HISTORY_HANDLERS } from './history'

const PROFILE_ID = 'profile-history-task-handler'
const TASK_ID = 'task:github:repo-1:issue:53'
const NOW = Date.UTC(2026, 10, 18, 12, 0)
const temporaryDirectories: string[] = []
const previousUserDataPath = process.env.ORCA_USER_DATA_PATH

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.restoreAllMocks()
})

/** A JSON-only profile: the read path must not create or migrate a database. */
function profile(): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-history-task-handler-'))
  temporaryDirectories.push(userDataPath)
  const profileDirectory = join(userDataPath, 'profiles', PROFILE_ID)
  mkdirSync(profileDirectory, { recursive: true })
  writeFileSync(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID }] }),
    'utf8'
  )
  writeFileSync(
    join(profileDirectory, 'orca-data.json'),
    JSON.stringify({
      taskRecords: {
        recordsVersion: 1,
        byId: {
          [TASK_ID]: {
            taskId: TASK_ID,
            hostId: 'local',
            origin: {
              kind: 'external',
              provider: 'github',
              itemType: 'issue',
              number: 53
            },
            bindings: [
              {
                worktreeId: 'wt-archived',
                repoId: 'repo-1',
                hostId: 'local',
                path: '/repos/app',
                isArchived: true,
                boundAt: NOW,
                boundBy: 'created',
                lastVerifiedAt: NOW,
                sessions: []
              }
            ],
            intent: {},
            createdAt: NOW,
            updatedAt: NOW,
            schemaVersion: 2
          }
        },
        externalIndex: { 'github:repo-1:issue:53': TASK_ID }
      },
      repos: [{ id: 'repo-1', path: '/repos/app' }],
      worktreeMeta: { 'wt-archived': { hostId: 'local', isArchived: true } }
    }),
    'utf8'
  )
  process.env.ORCA_USER_DATA_PATH = userDataPath
  return userDataPath
}

function context(flags: Record<string, string>, json: boolean): HandlerContext {
  return {
    // A runtime client is deliberately unusable: this command must never call it.
    client: {} as RuntimeClient,
    cwd: '/',
    flags: new Map(Object.entries(flags)),
    json
  }
}

describe('history task handler', () => {
  it('prints the stable JSON shape without touching the runtime', async () => {
    profile()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HISTORY_HANDLERS['history task']!(context({ task: 'repo-1#53' }, true))

    const printed = JSON.parse(String(output.mock.calls[0]?.[0])) as {
      ok: boolean
      result: {
        trace: string
        historySource: string
        agents: { kind: string; reason?: string }
        wall: { kind: string; reason?: string }
        tokens: { kind: string; reason?: string }
        bindings: { state: string; usage: { kind: string } }[]
      }
    }
    expect(printed.ok).toBe(true)
    expect(printed.result.trace).toBe('archived')
    expect(printed.result.historySource).toBe('record')
    expect(printed.result.agents).toEqual({ kind: 'unknown', reason: 'no_run_recorded' })
    expect(printed.result.wall).toEqual({ kind: 'unknown', reason: 'no_run_recorded' })
    expect(printed.result.tokens).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(printed.result.bindings[0]!.usage.kind).toBe('unknown')
  })

  it('requires the positional task and never spawns a backfill', async () => {
    await expect(HISTORY_HANDLERS['history task']!(context({}, false))).rejects.toThrow(
      'history task requires <repo>#<number>'
    )
    await expect(
      HISTORY_HANDLERS['history task']!(context({ task: 'repo-1' }, false))
    ).rejects.toThrow('history task expects <repo>#<number>')
  })
})
