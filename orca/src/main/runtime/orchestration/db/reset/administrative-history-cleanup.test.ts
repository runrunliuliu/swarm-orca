import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { assertNoAdministrativeHistoryFence } from '../../administrative-history-fence'
import {
  cleanupAdministrativeHistory,
  inspectHistoryCleanup
} from './administrative-history-cleanup'

describe('offline administrative history cleanup', () => {
  let directory: string
  let db: OrchestrationDb
  const authority = {
    terminalHandle: 'term_coordinator',
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    processIncarnation: 'pty:1',
    launchTokenHash: 'secret-hash',
    hostScope: { kind: 'local', hostId: 'local' }
  } as const
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-admin-history-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const run = db.createRun({
      objective: 'historical',
      coordinatorHandle: authority.terminalHandle,
      coordinatorPaneKey: authority.paneKey,
      strictCoordinator: authority
    })
    db.db
      .prepare(`INSERT INTO dispatch_contexts
      (id,run_id,task_id,status,assignee_handle,assignee_pane_key,assignee_orca_session_id)
      VALUES ('ctx_old',?,'task_old','completed','term_worker','worker-pane','old-session')`)
      .run(run.id)
    db.db.exec(`INSERT INTO worker_terminal_resources
      (id,origin_dispatch_id,owner_dispatch_id,terminal_handle,ownership_state,release_state)
      VALUES ('wtr_old','ctx_old','ctx_old','term_worker','user_owned','retained');
      INSERT INTO mutation_receipts (caller_fingerprint,request_id,method,payload_hash)
      VALUES ('old-caller','old-request','orchestration.send','hash');`)
  })
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = () => ({
    operation: 'archive-all-orchestration-history',
    reason: 'user requested force cleanup',
    stateSHA256: inspectHistoryCleanup(db).stateSHA256,
    runIds: inspectHistoryCleanup(db).runIds,
    workers: [{ dispatchId: 'ctx_old', verdict: 'unverifiable' }],
    acknowledgeUnverifiable: ['ctx_old'],
    evidenceSHA256: 'a'.repeat(64)
  })
  const cleanup = (value = input(), stopped = () => {}) =>
    cleanupAdministrativeHistory(db, value, join(directory, 'backup.db'), stopped)

  it('backs up then atomically removes history, retaining receipts and quarantined identities', async () => {
    const original = inspectHistoryCleanup(db)
    const receipt = await cleanup()
    expect(receipt.processExitProvenByCleanup).toBe(false)
    expect(receipt.acknowledgeUnverifiable).toEqual(['ctx_old'])
    expect(inspectHistoryCleanup(db)).toMatchObject({ runIds: [], dispatchIds: [] })
    expect(db.db.prepare('SELECT 1 FROM mutation_receipts').get()).toBeTruthy()
    expect(db.db.prepare('SELECT 1 FROM administrative_history_permits').get()).toBeUndefined()
    const backup = new OrchestrationDb(join(directory, 'backup.db'))
    try {
      expect(inspectHistoryCleanup(backup)).toEqual(original)
      expect(
        backup.db.prepare('SELECT release_state FROM worker_terminal_resources').get()
      ).toMatchObject({ release_state: 'retained' })
    } finally {
      backup.close()
    }
    for (const address of [
      authority.terminalHandle,
      'term_worker',
      'old-session',
      'session:old-session',
      'ctx_old',
      `run:${original.runIds[0]}`
    ]) {
      expect(() => assertNoAdministrativeHistoryFence(db, [address], [])).toThrow(
        'archived history'
      )
    }
    expect(() => assertNoAdministrativeHistoryFence(db, [], ['worker-pane'])).toThrow()
    expect(() => assertNoAdministrativeHistoryFence(db, ['term_new'], ['new-pane'])).not.toThrow()
    db.resetAll()
    expect(() => assertNoAdministrativeHistoryFence(db, ['ctx_old'], [])).toThrow()
    db.close()
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    expect(() => assertNoAdministrativeHistoryFence(db, ['term_worker'], [])).toThrow()
  })
  it('leaves ordinary strict reset and immutable policy refusal unchanged', () => {
    const before = inspectHistoryCleanup(db)
    expect(() => db.resetAll()).toThrow('strict_coordinator_required')
    expect(() => db.db.exec('DELETE FROM strict_run_coordinators')).toThrow(
      'strict_coordinator_required'
    )
    expect(inspectHistoryCleanup(db)).toEqual(before)
  })
  it('refuses a non-administrator before invoking maintenance or backup', async () => {
    vi.mocked(process.getuid!).mockReturnValue(1000)
    const stopped = vi.fn()
    await expect(cleanup(input(), stopped)).rejects.toThrow('requires_local_root')
    expect(stopped).not.toHaveBeenCalled()
  })
  it('requires explicit acknowledgement of every unverifiable Worker', async () => {
    await expect(cleanup({ ...input(), acknowledgeUnverifiable: [] })).rejects.toThrow(
      'review_mismatch'
    )
  })
  it('rejects duplicate and incomplete Worker observations', async () => {
    const worker = input().workers[0]!
    await expect(cleanup({ ...input(), workers: [worker, worker] })).rejects.toThrow(
      'review_mismatch'
    )
    await expect(cleanup({ ...input(), workers: [] })).rejects.toThrow('review_mismatch')
  })
  it('rejects a live verdict rather than relabeling it', async () => {
    await expect(
      cleanup({ ...input(), workers: [{ dispatchId: 'ctx_old', verdict: 'live' }] })
    ).rejects.toThrow()
  })
  it('refuses unsettled work even with a claimed exited observation', async () => {
    db.db.exec("UPDATE dispatch_contexts SET status = 'dispatched'")
    await expect(cleanup()).rejects.toThrow('unsettled_dispatch')
  })
  it('refuses stale review before mutation', async () => {
    const stale = input()
    db.db.exec('UPDATE dispatch_contexts SET failure_count = 1')
    await expect(cleanup(stale)).rejects.toThrow('review_mismatch')
  })
  it('detects mutation while the asynchronous backup is pending', async () => {
    const stopped = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        db.db.exec('UPDATE dispatch_contexts SET failure_count = 1')
      })
    await expect(cleanup(input(), stopped)).rejects.toThrow('review_mismatch')
    expect(db.db.prepare('SELECT 1 FROM strict_run_coordinators').get()).toBeTruthy()
    expect(db.db.prepare('SELECT 1 FROM administrative_history_receipts').get()).toBeUndefined()
  })
  it('rolls back permits, fences and deletions together on a storage error', async () => {
    db.db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON dispatch_contexts
      BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`)
    const before = inspectHistoryCleanup(db)
    await expect(cleanup()).rejects.toThrow('injected_failure')
    expect(inspectHistoryCleanup(db)).toEqual(before)
    expect(db.db.prepare('SELECT 1 FROM administrative_history_permits').get()).toBeUndefined()
  })
  it('rolls back all history changes if Orca restarts before commit', async () => {
    const before = inspectHistoryCleanup(db)
    const stopped = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('administrative_history_service_not_down')
      })
    await expect(cleanup(input(), stopped)).rejects.toThrow('service_not_down')
    expect(stopped).toHaveBeenCalledTimes(3)
    expect(inspectHistoryCleanup(db)).toEqual(before)
    expect(db.db.prepare('SELECT 1 FROM administrative_history_permits').get()).toBeUndefined()
  })
  it('rejects replay instead of erasing work created after the first cleanup', async () => {
    const oldInput = input()
    await cleanup(oldInput)
    const run = db.createRun({
      objective: 'new',
      coordinatorHandle: 'term_new',
      coordinatorPaneKey: 'new-pane'
    })
    await expect(cleanup(oldInput)).rejects.toThrow('review_mismatch')
    expect(db.getRun(run.id)).toBeDefined()
  })
})
