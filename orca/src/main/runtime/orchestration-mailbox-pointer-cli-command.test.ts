import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localOrchestrationCliCommand } from './orchestration/cli-command'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration mailbox pointer CLI command', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['native', { isWsl: false }, null],
    ['dev WSL', { isWsl: true }, 'orca-dev'],
    ['SSH', { connectionId: 'ssh-target', isWsl: true }, 'orca']
  ])('renders the %s CLI command in a mailbox pointer', async (_name, options, command) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-cli-command-')
    const harness = createRuntime(db, options)
    const run = createBoundRun(db, 'CLI command Run')
    insertDirectRunMessage(db, run.id, 'Command-aware pointer')

    await driveToLiveIdle(harness.runtime)

    const cli = command ?? localOrchestrationCliCommand()
    if (command === null && process.platform !== 'win32') {
      expect(cli).toMatch(/^'\//)
    }
    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`${cli} orchestration check --run ${run.id}`)
    )
    db.close()
  })
})
