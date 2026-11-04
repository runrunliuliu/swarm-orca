import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  LEAF_ID,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  SECOND_PANE_KEY,
  TAB_ID,
  TERMINAL_HANDLE,
  temporaryDirectories,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('fresh PTY-owned mailbox routing', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([true, false])(
    'routes fresh direct mail without a renderer (headless=%s)',
    async (headless) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mailbox-headless-direct-')
      const { runtime, write } = createRuntime(db, { headless })
      const run = createBoundRun(db, 'PTY mailbox')
      await driveToLiveIdle(runtime)
      if (!headless) {
        runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      }
      const message = insertDirectRunMessage(db, run.id, 'Fresh mail after park')
      runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
      await vi.advanceTimersByTimeAsync(600)
      expect(pointerCount(write)).toBe(1)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      const checked = await checkBoundMailbox(runtime)
      expect(checked).toMatchObject({ runId: run.id, count: 1 })
      await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
      expect(db.getMessageById(message.id)?.read).toBe(1)
      runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(pointerCount(write)).toBe(1)
      db.close()
    }
  )

  it('delivers and acknowledges an active headless Dispatch', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-headless-dispatch-')
    const { runtime, write } = createRuntime(db, { headless: true })
    const run = db.createRun({
      objective: 'Worker',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const task = db.createTask({ spec: 'Worker task', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    await driveToLiveIdle(runtime)
    const message = db.insertMessage({
      from: 'term_other',
      to: TERMINAL_HANDLE,
      subject: 'Next',
      runId: run.id
    })
    runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(1)
    const checked = await checkBoundMailbox(runtime)
    expect(checked).toMatchObject({ dispatchId: dispatch.id, count: 1 })
    await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
    expect(db.getMessageById(message.id)?.read).toBe(1)
    db.close()
  })

  it('refuses fresh mail when two connected PTYs claim the same pane', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-headless-ambiguous-')
    const { runtime, write } = createRuntime(db, { headless: true })
    const run = createBoundRun(db, 'Ambiguous pane')
    await driveToLiveIdle(runtime)
    runtime.registerPty('duplicate-pty', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'duplicate-incarnation'
    })
    runtime.registerPreAllocatedHandleForPty('duplicate-pty', 'term_duplicate')
    const message = insertDirectRunMessage(db, run.id, 'Do not choose an arbitrary PTY')
    runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
    db.close()
  })

  it.each(['replacement', 'disconnect', 'occupied-pane'])(
    'does not retry across %s',
    async (change) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mailbox-headless-retry-fence-')
      const { runtime, write } = createRuntime(db, { headless: true })
      const run = createBoundRun(db, 'Retry fence')
      runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
      const message = insertDirectRunMessage(db, run.id, 'Old process only')
      runtime.notifyMessageArrived(TERMINAL_HANDLE, message.type)
      await vi.advanceTimersByTimeAsync(100)
      if (change === 'disconnect') {
        runtime.onPtyExit(PTY_ID, 0)
      } else if (change === 'replacement') {
        runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
          tabId: TAB_ID,
          leafId: LEAF_ID,
          incarnationId: 'replacement-incarnation'
        })
      } else {
        runtime.attachWindow(1)
        runtime.syncWindowGraph(1, {
          tabs: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              title: 'Shell',
              activeLeafId: LEAF_ID,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              leafId: LEAF_ID,
              paneRuntimeId: 1,
              ptyId: 'other-pty'
            }
          ]
        })
      }
      await vi.advanceTimersByTimeAsync(6_000)
      expect(write).not.toHaveBeenCalled()
      expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
      db.close()
    }
  )
})
