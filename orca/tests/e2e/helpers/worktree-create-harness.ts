import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'
import { waitForPtyShellEcho } from '../terminal-pty-readiness'

export type WorktreeCreateHarness = {
  originalWorktreeId: string
  repoId: string
  userDataDir: string
  metadataPath: string
  runtimeId: string
  /** The seeded worktree's shell, used for the visible commands. */
  shellPtyId: string
  /** Mutated by each scenario; cleanup removes exactly these and returns to the original. */
  createdWorktreeIds: string[]
  cleanup(): Promise<void>
}

async function resizeWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1500, height: 950 })
  })
}

/** The runtime identity the skill would get from its operator, read from the launched profile. */
export function readRuntimeMetadata(userDataDir: string): { path: string; runtimeId: string } {
  const metadataPath = path.join(userDataDir, 'orca-runtime.json')
  const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const runtimeId =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'runtimeId') : null
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    throw new Error(`runtime metadata has no runtimeId: ${metadataPath}`)
  }
  return { path: metadataPath, runtimeId }
}

/** The seeded repo's HEAD, so a create request carries a pinned commit instead of a moving ref. */
export function seededBaseSha(seededRepoPath: string): string {
  return execFileSync('git', ['-C', seededRepoPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
}

/**
 * The prelude every worktree-create scenario needs: a ready session, a deterministic window size,
 * the seeded worktree and its shell, and the isolated profile the CLI must point at. Cleanup
 * returns to the original worktree before removing the created ones, so force-removal never hits
 * the workspace a pane is currently rendering.
 */
export async function prepareWorktreeCreateHarness(args: {
  page: Page
  electronApp: ElectronApplication
  seededRepoPath: string
}): Promise<WorktreeCreateHarness> {
  const { page, electronApp } = args
  await waitForSessionReady(page)
  await resizeWindow(electronApp)
  await waitForActiveTerminalManager(page)
  const originalWorktreeId = await waitForActiveWorktree(page)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const metadata = readRuntimeMetadata(userDataDir)
  const shellPtyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, shellPtyId, 20_000)
  const createdWorktreeIds: string[] = []
  return {
    originalWorktreeId,
    repoId: originalWorktreeId.split('::')[0],
    userDataDir,
    metadataPath: metadata.path,
    runtimeId: metadata.runtimeId,
    shellPtyId,
    createdWorktreeIds,
    async cleanup() {
      await page
        .locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
        .click()
        .catch(() => undefined)
      for (const worktreeId of createdWorktreeIds) {
        await page
          .evaluate(async (id) => {
            await window.__store?.getState().removeWorktree({ id, executionHostId: null }, true)
          }, worktreeId)
          .catch(() => undefined)
      }
    }
  }
}
