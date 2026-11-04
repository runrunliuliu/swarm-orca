import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppEnvironment } from '../../shared/app-environment'
import { getAppEnvironment, hasAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { MAILBOX_POINTER_ENTER_ATTEMPTED } from './orchestration/db/messages/mailbox-pointer-enter-state'

class StartupRecoveryRuntime extends OrcaRuntimeService {
  readonly repointed: string[] = []

  protected override repointPendingMessagesForHandle(handle: string): void {
    this.repointed.push(handle)
  }

  closeOpenedOrchestrationDb(): void {
    this._orchestrationDb?.close()
  }
}

function installStartupRecoveryEnvironment(userData: string): AppEnvironment | null {
  const previous = hasAppEnvironment() ? getAppEnvironment() : null
  setAppEnvironment({
    getPath: () => userData,
    getAppPath: () => userData,
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  return previous
}

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration mailbox crash recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not replay Enter when Enter was accepted before settlement', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-enter-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Enter crash Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Visible before Enter crash')
    const recordWrite = first.write as unknown as (id: string, payload: string) => unknown
    const write = vi.fn((ptyId: string, data: string) => {
      recordWrite(ptyId, data)
      if (data === '\r') {
        firstDb.close()
      }
      return true
    })
    first.runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)

    const restartedDb = new OrchestrationDb(dbPath)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_ENTER_ATTEMPTED
    })
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })
  it('rescans mailboxes a crash left mid-pointer, including dispatch mailboxes', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-restart-scan-')
    const run = createBoundRun(db, 'restart scan')
    const parked = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'parked mid-pointer',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    // The crash left the reservation durable, which hides the row from the undelivered scan.
    expect(
      db.stageMailboxPointerEnter([parked.id], { ptyId: 'pty-gone', processIncarnation: 'gone:1' })
    ).toBe(true)
    db.insertMessage({
      from: 'term_coordinator',
      to: 'dispatch:dispatch_restart_scan',
      subject: 'dispatch mail',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    const { runtime } = createRuntime(db)
    const repointed: string[] = []
    vi.spyOn(
      runtime as unknown as { repointPendingMessagesForHandle: (handle: string) => void },
      'repointPendingMessagesForHandle'
    ).mockImplementation((handle: string) => {
      repointed.push(handle)
    })
    runtime.setOrchestrationDb(db)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(repointed).toContain(`run:${run.id}`)
    expect(repointed).toContain('dispatch:dispatch_restart_scan')
    db.close()
  })
  it('opens an existing orchestration database during restored authority recovery', async () => {
    vi.useFakeTimers()
    const userData = mkdtempSync(join(tmpdir(), 'orca-startup-existing-orch-db-'))
    temporaryDirectories.push(userData)
    const previousEnvironment = installStartupRecoveryEnvironment(userData)
    const dbPath = join(userData, 'orchestration.db')
    const seeded = new OrchestrationDb(dbPath)
    const run = createBoundRun(seeded, 'startup restored mail')
    seeded.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'restored pending mail',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    seeded.close()
    expect(existsSync(dbPath)).toBe(true)

    const runtime = new StartupRecoveryRuntime(null, undefined, {
      canRecoverPersistentLocalPtys: () => true
    })
    runtime.setPtyController({
      write: vi.fn(() => true),
      writeWithSettlement: settledWriteStub(vi.fn(() => true)),
      kill: vi.fn(),
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })

    try {
      await runtime.refreshRestoredOrchestrationAuthority()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(runtime.repointed).toEqual([`run:${run.id}`])
    } finally {
      runtime.closeOpenedOrchestrationDb()
      if (previousEnvironment) {
        setAppEnvironment(previousEnvironment)
      }
    }
  })
})
