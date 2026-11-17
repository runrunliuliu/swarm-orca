import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import type { AppEnvironment } from '../../shared/app-environment'

const { authorizeExternalPathMock } = vi.hoisted(() => ({
  authorizeExternalPathMock: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
}))

import { ensureTaskDraftDirectory } from './task-draft-directory'

const DRAFT_KEY = '3f2c1a44-8d5b-4c1e-9a77-0b6c1d2e3f40'

// Why the port and not an `electron` mock: the module must stay electron-free so the runtime
// graph keeps building for plain Node; the test installs the same host port a Node host does.
function appEnvironmentFor(userDataDir: string): AppEnvironment {
  return {
    getPath: (name) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected app path: ${name}`)
    },
    getAppPath: () => userDataDir,
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  }
}

describe('ensureTaskDraftDirectory', () => {
  let tempRoot: string
  let userDataDir: string
  let repoDir: string
  let draftsRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-task-draft-'))
    userDataDir = path.join(tempRoot, 'user-data')
    repoDir = path.join(tempRoot, 'repo')
    draftsRoot = path.join(userDataDir, 'task-drafts')
    setAppEnvironment(appEnvironmentFor(userDataDir))
    authorizeExternalPathMock.mockClear()
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('creates the per-draft scratch directory under app-owned userData', async () => {
    const directory = await ensureTaskDraftDirectory(DRAFT_KEY)

    expect(directory).toBe(path.join(userDataDir, 'task-drafts', DRAFT_KEY))
    expect(statSync(directory).isDirectory()).toBe(true)
    // Why: a draft is never a repository checkout, so the path must not sit under one.
    expect(directory.startsWith(`${repoDir}${path.sep}`)).toBe(false)
  })

  it('authorizes the leaf only, never the drafts root or userData', async () => {
    const directory = await ensureTaskDraftDirectory(DRAFT_KEY)

    expect(authorizeExternalPathMock).toHaveBeenCalledTimes(1)
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(directory)
    expect(authorizeExternalPathMock).not.toHaveBeenCalledWith(draftsRoot)
    expect(authorizeExternalPathMock).not.toHaveBeenCalledWith(userDataDir)
  })

  it('reuses the same directory for a repeated key instead of adding a second one', async () => {
    const first = await ensureTaskDraftDirectory(DRAFT_KEY)
    const second = await ensureTaskDraftDirectory(DRAFT_KEY)

    expect(second).toBe(first)
    expect(readdirSync(draftsRoot)).toEqual([DRAFT_KEY])
  })

  it('creates sibling leaves for different keys', async () => {
    const first = await ensureTaskDraftDirectory('11111111-1111-4111-8111-111111111111')
    const second = await ensureTaskDraftDirectory('22222222-2222-4222-8222-222222222222')

    expect(path.dirname(first)).toBe(draftsRoot)
    expect(path.dirname(second)).toBe(draftsRoot)
    expect(readdirSync(draftsRoot).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ])
  })

  it.each(['', '../escape', 'a/b', '..', 'x'.repeat(80), 'uuid-with-space '])(
    'rejects the untrusted key %j without creating anything',
    async (draftKey) => {
      await expect(ensureTaskDraftDirectory(draftKey)).rejects.toThrow('task_draft_key_invalid')

      expect(() => statSync(draftsRoot)).toThrow()
      expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    }
  )
})
