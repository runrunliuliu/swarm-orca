import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  assertNoStrictContinuitySeal,
  sealStrictContinuityDatabase
} from '../runtime/orchestration/strict-continuity-store'
import {
  strictCoordinatorHarness,
  COORD,
  OPERATOR,
  OTHER,
  WORKER
} from '../runtime/rpc/strict-coordinator-test-fixture'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'
import { assertOrcadContinuityStartup } from './orcad-continuity-startup'
import { strictCoordinatorPolicy } from '../runtime/orchestration/strict-coordinator-policy'
import { idOf, resultOf } from '../runtime/rpc/orchestration-session-caller-test-fixture'

describe.runIf(process.platform === 'linux')('reviewed planned restart journal', () => {
  let root: string
  let harness: ReturnType<typeof strictCoordinatorHarness>
  let lock: ReturnType<typeof acquireOrcadInstanceLock>
  let journal: ReturnType<typeof openOrcadRuntimeLineage>
  let db: OrchestrationDb
  let databaseClosed: boolean
  let pendingMessage: string
  let pendingDelivery: unknown
  let request: Parameters<typeof journal.plannedRestart.review>[1]

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-planned-consume-'))
    harness = strictCoordinatorHarness()
    const runId = await harness.create()
    pendingMessage = idOf(
      resultOf(
        await harness.call(
          'orchestration.send',
          {
            from: OPERATOR,
            to: `run:${runId}`,
            body: 'Continue the pending action'
          },
          OPERATOR,
          'original-continuation'
        )
      ).message
    )
    pendingDelivery = resultOf(
      await harness.call(
        'orchestration.check',
        {
          terminal: COORD,
          run: runId
        },
        COORD
      )
    ).deliveryId
    await harness.db.db.backup(join(root, 'orchestration.db'))
    db = new OrchestrationDb(join(root, 'orchestration.db'))
    databaseClosed = false
    harness.runtime.setOrchestrationDb(db)
    lock = acquireOrcadInstanceLock(root)
    journal = openOrcadRuntimeLineage(root, lock)
    journal.recordBoot(harness.runtime.getRuntimeId())
    journal.plannedRestart.prepare(
      { runtime: harness.runtime, orchestrationCompatibilityEvidence: harness.evidence(OPERATOR) },
      {
        runId,
        sender: WORKER,
        proposalCanonicalSha256: 'a'.repeat(64)
      }
    )
    journal.recordSourceInventory(continuityInventoryFixture(root))
    const sealed = sealStrictContinuityDatabase(db, {
      runId,
      sourceRuntimeId: harness.runtime.getRuntimeId(),
      expiresAtMs: Date.now() + 60_000
    })
    request = {
      seal: {
        runId,
        databaseId: sealed.seal.databaseId,
        sealCanonicalSha256: sealed.sealCanonicalSha256
      },
      proposalCanonicalSha256: 'a'.repeat(64),
      approved: true,
      reason: 'Reviewed original Run continuation'
    }
    journal.recordDatabaseSeal(db, request.seal)
  })

  afterEach(() => {
    if (!databaseClosed) {
      db.close()
    }
    harness.close()
    journal.close()
    lock.release()
    rmSync(root, { recursive: true, force: true })
  })

  function review(caller = OTHER) {
    return journal.plannedRestart.review(
      { runtime: harness.runtime, orchestrationCompatibilityEvidence: harness.evidence(caller) },
      request
    )
  }

  function restart() {
    db.close()
    databaseClosed = true
    journal.close()
    lock.release()
    lock = acquireOrcadInstanceLock(root)
    journal = openOrcadRuntimeLineage(root, lock, { existingOnly: true })
  }

  function consume(
    reviewCanonicalSha256: string,
    targetRuntimeId = 'successor-runtime',
    commit = true
  ) {
    const resumed = new OrchestrationDb(join(root, 'orchestration.db'), (connection) => {
      journal.plannedRestart.consume(connection, {
        reviewCanonicalSha256,
        proposalCanonicalSha256: request.proposalCanonicalSha256,
        targetRuntimeId
      })
    })
    if (commit) {
      journal.plannedRestart.commit()
      journal.plannedRestart.activate(resumed.db)
    }
    databaseClosed = false
    return resumed
  }

  it('reviews live identity, consumes once, continues the original Run and retains sealed history', () => {
    const original = db.getRun(request.seal.runId)
    const policy = strictCoordinatorPolicy(db, request.seal.runId)
    const receipt = review()
    expect(review()).toEqual(receipt)
    expect(() => assertNoStrictContinuitySeal(db)).toThrow('sealed')
    restart()
    db = consume(receipt.reviewCanonicalSha256)
    expect(() => assertNoStrictContinuitySeal(db)).not.toThrow()
    expect(db.getRun(request.seal.runId)).toEqual(original)
    expect(strictCoordinatorPolicy(db, request.seal.runId)).toEqual(policy)
    db.db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('continued', request.seal.runId)
    expect(db.getRun(request.seal.runId)?.objective).toBe('continued')
    expect(db.db.prepare('SELECT count(*) AS n FROM strict_continuity_seals').get()?.n).toBe(1)
    expect(() => new OrchestrationDb(join(root, 'orchestration.db'))).toThrow(
      'strict_continuity_required'
    )
    expect(() => assertOrcadContinuityStartup(root, lock)).toThrow('strict_continuity_required')
    journal.close()
    expect(() => assertNoStrictContinuitySeal(db)).toThrow('journal closed')
  })

  it('continues through native claim, action, full ACK and replay on a new runtime', async () => {
    const receipt = review()
    const original = db.getRun(request.seal.runId)
    const policy = strictCoordinatorPolicy(db, request.seal.runId)
    restart()
    const successor = strictCoordinatorHarness()
    try {
      expect(successor.runtime.getRuntimeId()).not.toBe(harness.runtime.getRuntimeId())
      db = consume(receipt.reviewCanonicalSha256, successor.runtime.getRuntimeId())
      successor.runtime.setOrchestrationDb(db)
      const check = { terminal: COORD, run: request.seal.runId }
      expect(await successor.call('orchestration.check', check, OPERATOR)).toMatchObject({
        ok: false
      })
      const delivery = resultOf(await successor.call('orchestration.check', check, COORD))
      expect(delivery).toMatchObject({ deliveryId: pendingDelivery, replayed: true, count: 1 })
      expect(db.getMessageById(pendingMessage)?.read).toBe(0)
      const action = {
        run: request.seal.runId,
        callerTerminalHandle: COORD,
        spec: 'Pending action'
      }
      const created = resultOf(
        await successor.call('orchestration.taskCreate', action, COORD, 'pending-action')
      )
      const taskId = idOf(created.task)
      expect(
        resultOf(await successor.call('orchestration.taskCreate', action, COORD, 'pending-action'))
      ).toMatchObject({ task: { id: taskId }, mutation: { replayed: true } })
      expect(
        resultOf(
          await successor.call('orchestration.check', { ...check, ack: pendingDelivery }, COORD)
        )
      ).toMatchObject({ acknowledged: pendingDelivery, count: 0 })
      expect(db.getMessageById(pendingMessage)?.read).toBe(1)
      expect(
        resultOf(
          await successor.call('orchestration.check', { ...check, ack: pendingDelivery }, COORD)
        )
      ).toMatchObject({ acknowledged: pendingDelivery, count: 0 })
      expect(db.getRun(request.seal.runId)).toEqual(original)
      expect(strictCoordinatorPolicy(db, request.seal.runId)).toEqual(policy)
      successor.authorities.get(COORD)!.processIncarnation = 'replacement'
      expect(await successor.call('orchestration.check', check, COORD)).toMatchObject({ ok: false })
    } finally {
      successor.close()
    }
  })

  it.each([COORD, OPERATOR, WORKER])('refuses %s as independent reviewer', (caller) => {
    expect(() => review(caller)).toThrow('independent reviewer')
  })

  it('refuses missing native caller evidence and a rejected review', () => {
    expect(() => journal.plannedRestart.review({ runtime: harness.runtime }, request)).toThrow(
      'live native terminal caller'
    )
    request.approved = false
    expect(() => review()).toThrow('review rejected')
  })

  it('cannot consume without review and does not append a target boot on failure', () => {
    restart()
    expect(() => consume('a'.repeat(64))).toThrow()
    const check = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      expect(check.prepare('SELECT count(*) AS n FROM boots').get()?.n).toBe(1)
    } finally {
      check.close()
    }
  })

  it('refuses changed request and review pins before consuming, then accepts the correct pins', () => {
    const receipt = review()
    restart()
    expect(() => consume('b'.repeat(64))).toThrow('review pin mismatch')
    request.proposalCanonicalSha256 = 'b'.repeat(64)
    expect(() => consume(receipt.reviewCanonicalSha256)).toThrow('review pin mismatch')
    request.proposalCanonicalSha256 = 'a'.repeat(64)
    db = consume(receipt.reviewCanonicalSha256)
  })

  it('does not let the source consume its own receipt or a later runtime consume it again', () => {
    const receipt = review()
    expect(() => consume(receipt.reviewCanonicalSha256)).toThrow('already recorded its boot')
    restart()
    db = consume(receipt.reviewCanonicalSha256)
    restart()
    expect(() => consume(receipt.reviewCanonicalSha256, 'another-runtime')).toThrow(
      'receipt already consumed'
    )
  })

  it('retries an uncommitted startup with a new runtime without permitting interim writes', () => {
    const receipt = review()
    restart()
    db = consume(receipt.reviewCanonicalSha256, 'failed-start', false)
    expect(() => assertNoStrictContinuitySeal(db)).toThrow('sealed')
    expect(() =>
      db.db
        .prepare('UPDATE runs SET objective = ? WHERE id = ?')
        .run('unexpected', request.seal.runId)
    ).toThrow('readonly')
    restart()
    db = consume(receipt.reviewCanonicalSha256, 'retried-start')
    expect(() => assertNoStrictContinuitySeal(db)).not.toThrow()
    expect(journal.plannedRestart.continuation().consumption.target.runtimeId).toBe('retried-start')
    const check = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      expect(
        check.prepare("SELECT count(*) AS n FROM planned_restarts WHERE stage = 'attempt'").get()?.n
      ).toBe(2)
      expect(
        check.prepare("SELECT count(*) AS n FROM planned_restarts WHERE stage = 'consume'").get()?.n
      ).toBe(1)
    } finally {
      check.close()
    }
  })

  it('retains two reviewed cycles for the same Run, owner and generation', () => {
    const receipt = review()
    const original = db.getRun(request.seal.runId)
    const policy = strictCoordinatorPolicy(db, request.seal.runId)
    restart()
    const secondSource = strictCoordinatorHarness()
    try {
      db = consume(receipt.reviewCanonicalSha256, secondSource.runtime.getRuntimeId())
      secondSource.runtime.setOrchestrationDb(db, { deferStartupEffects: true })
      const ctx = {
        runtime: secondSource.runtime,
        orchestrationCompatibilityEvidence: secondSource.evidence(OPERATOR)
      }
      journal.plannedRestart.prepare(ctx, {
        runId: request.seal.runId,
        sender: WORKER,
        proposalCanonicalSha256: 'b'.repeat(64)
      })
      journal.recordSourceInventory({
        monitorStateRoot: join(root, 'monitor'),
        continuationStateRoot: join(root, 'continuation'),
        files: [join(root, 'head.json')]
      })
      const sealed = sealStrictContinuityDatabase(db, {
        runId: request.seal.runId,
        sourceRuntimeId: secondSource.runtime.getRuntimeId(),
        expiresAtMs: Date.now() + 60_000
      })
      expect(sealed.seal.recoveryEpoch).toBe(2)
      expect(() => assertNoStrictContinuitySeal(db)).toThrow('sealed')
      request = {
        ...request,
        proposalCanonicalSha256: 'b'.repeat(64),
        seal: { ...request.seal, sealCanonicalSha256: sealed.sealCanonicalSha256 }
      }
      journal.recordDatabaseSeal(db, request.seal)
      const reviewed = journal.plannedRestart.review(
        {
          runtime: secondSource.runtime,
          orchestrationCompatibilityEvidence: secondSource.evidence(OTHER)
        },
        request
      )
      restart()
      db = consume(reviewed.reviewCanonicalSha256, 'second-successor')
      expect(db.getRun(request.seal.runId)).toEqual(original)
      expect(strictCoordinatorPolicy(db, request.seal.runId)).toEqual(policy)
      expect(db.db.prepare('SELECT count(*) AS n FROM strict_continuity_seals').get()?.n).toBe(2)
      expect(journal.plannedRestart.continuation().consumption.target.runtimeId).toBe(
        'second-successor'
      )
    } finally {
      secondSource.close()
    }
  })

  it('does not extend the original seal deadline when retrying a failed startup', () => {
    const receipt = review()
    restart()
    db = consume(receipt.reviewCanonicalSha256, 'failed-start', false)
    restart()
    const expired = Date.now() + 61_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expired)
    try {
      expect(() => consume(receipt.reviewCanonicalSha256, 'expired-retry')).toThrow('Seal expired')
    } finally {
      clock.mockRestore()
    }
    expect(() => journal.assertNormalStartup()).toThrow()
    const check = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      expect(
        check.prepare("SELECT count(*) AS n FROM planned_restarts WHERE stage = 'attempt'").get()?.n
      ).toBe(1)
      expect(
        check.prepare("SELECT count(*) AS n FROM planned_restarts WHERE stage = 'consume'").get()?.n
      ).toBe(0)
    } finally {
      check.close()
    }
  })

  it('rolls back target boot and consumption together if the sealed database changed', () => {
    const receipt = review()
    db.db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('drift', request.seal.runId)
    restart()
    expect(() => consume(receipt.reviewCanonicalSha256)).toThrow('Database changed after sealing')
    const check = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      expect(
        check.prepare("SELECT 1 FROM planned_restarts WHERE stage = 'consume'").get()
      ).toBeUndefined()
      expect(check.prepare('SELECT count(*) AS n FROM boots').get()?.n).toBe(1)
    } finally {
      check.close()
    }
  })
})
