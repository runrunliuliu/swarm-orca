import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import type { AppEnvironment } from '../../shared/app-environment'

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: vi.fn()
}))

import { removeTaskDraftDirectory } from './task-draft-directory'

const LEAF_KEY = '3f2c1a44-8d5b-4c1e-9a77-0b6c1d2e3f40'

// Why the host port instead of an `electron` mock: the module must stay electron-free so the
// runtime graph keeps building for plain Node.
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

describe('removeTaskDraftDirectory', () => {
  let tempRoot: string
  let userDataDir: string
  let draftsRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-task-draft-delete-'))
    userDataDir = path.join(tempRoot, 'user-data')
    draftsRoot = path.join(userDataDir, 'task-drafts')
    mkdirSync(draftsRoot, { recursive: true })
    setAppEnvironment(appEnvironmentFor(userDataDir))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('deletes the owned leaf and leaves every sibling draft alone', async () => {
    const leaf = path.join(draftsRoot, LEAF_KEY)
    const sibling = path.join(draftsRoot, '11111111-1111-4111-8111-111111111111')
    mkdirSync(leaf, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(path.join(leaf, 'task-draft-proposal.json'), '{}')

    await expect(removeTaskDraftDirectory(leaf)).resolves.toBe(true)

    expect(existsSync(leaf)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })

  it('refuses the drafts root itself so no other draft is collateral', async () => {
    const leaf = path.join(draftsRoot, LEAF_KEY)
    mkdirSync(leaf, { recursive: true })

    await expect(removeTaskDraftDirectory(draftsRoot)).resolves.toBe(false)

    expect(existsSync(draftsRoot)).toBe(true)
    expect(existsSync(leaf)).toBe(true)
  })

  it('refuses a sibling of the drafts root', async () => {
    const other = path.join(userDataDir, 'other')
    mkdirSync(other, { recursive: true })

    await expect(removeTaskDraftDirectory(path.join(draftsRoot, '..', 'other'))).resolves.toBe(
      false
    )

    expect(existsSync(other)).toBe(true)
  })

  it('refuses a path outside userData entirely', async () => {
    const outside = path.join(tempRoot, 'outside')
    mkdirSync(outside, { recursive: true })

    await expect(removeTaskDraftDirectory(outside)).resolves.toBe(false)

    expect(existsSync(outside)).toBe(true)
  })

  it('refuses a prefix lookalike of the drafts root', async () => {
    const lookalikeLeaf = path.join(`${draftsRoot}-evil`, 'leaf')
    mkdirSync(lookalikeLeaf, { recursive: true })

    await expect(removeTaskDraftDirectory(lookalikeLeaf)).resolves.toBe(false)

    expect(existsSync(lookalikeLeaf)).toBe(true)
  })

  it.each(['', '   '])(
    'refuses the blank path %j without touching the drafts root',
    async (value) => {
      await expect(removeTaskDraftDirectory(value)).resolves.toBe(false)

      expect(existsSync(draftsRoot)).toBe(true)
    }
  )

  it('removes a symlinked leaf without touching its target', async () => {
    const target = path.join(tempRoot, 'target')
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, 'keep.txt'), 'keep')
    const link = path.join(draftsRoot, LEAF_KEY)
    symlinkSync(target, link, 'junction')

    await expect(removeTaskDraftDirectory(link)).resolves.toBe(true)

    expect(existsSync(link)).toBe(false)
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true)
  })
})
