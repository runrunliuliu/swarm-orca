import '../daemon/mock-descendant-sweep'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  COORD,
  OPERATOR,
  OTHER,
  WORKER,
  strictCoordinatorHarness
} from '../runtime/rpc/strict-coordinator-test-fixture'
import {
  idOf,
  resultOf,
  orchestrationRequest
} from '../runtime/rpc/orchestration-session-caller-test-fixture'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import {
  installPlannedRestartMaintenance,
  installPlannedRestartHandlers
} from '../runtime/rpc/planned-restart-admission'
import { DaemonServer } from '../daemon/daemon-server'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { createMockSubprocess } from '../daemon/daemon-pty-adapter-test-harness'
import { getDaemonSocketPath, getDaemonTokenPath } from '../daemon/daemon-spawner'
import {
  disconnectDaemon,
  getDaemonProvider,
  replaceDaemonProvider
} from '../daemon/daemon-provider-state'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { plannedRestartSourceMaintenance } from './orcad-planned-maintenance'
import { admitPlannedSuccessor, type PlannedSuccessor } from './orcad-planned-successor'
import {
  plannedSourceFixture,
  nextPlannedSourceFixture,
  restoredPlannedRuntime,
  writeRestartFixture
} from './orcad-planned-maintenance-test-fixture'

describe.runIf(process.platform === 'linux')('planned restart connected maintenance', () => {
  let root: string
  let source: ReturnType<typeof strictCoordinatorHarness>
  let fixture: Awaited<ReturnType<typeof plannedSourceFixture>>
  let db: OrchestrationDb | undefined
  let lock: ReturnType<typeof acquireOrcadInstanceLock>
  let lineage: ReturnType<typeof openOrcadRuntimeLineage>
  let daemon: DaemonServer
  let adapter: DaemonPtyAdapter
  let successor: PlannedSuccessor | undefined
  let spawn: ReturnType<typeof vi.fn<() => ReturnType<typeof createMockSubprocess>>>
  let freezeProfile: ReturnType<typeof vi.fn<() => Promise<void>>>
  let idle: MockInstance<typeof source.runtime.waitForTerminal>

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-maintenance-'))
    source = strictCoordinatorHarness()
    fixture = await plannedSourceFixture(root, source)
    await source.db.db.backup(join(root, 'orchestration.db'))
    db = new OrchestrationDb(join(root, 'orchestration.db'))
    source.runtime.setOrchestrationDb(db, { deferStartupEffects: true })
    lock = acquireOrcadInstanceLock(root)
    lineage = openOrcadRuntimeLineage(root, lock)
    lineage.recordBoot(source.runtime.getRuntimeId())
    const runtimeDir = join(root, 'daemon')
    mkdirSync(runtimeDir, { mode: 0o700 })
    const paths = {
      socketPath: getDaemonSocketPath(runtimeDir),
      tokenPath: getDaemonTokenPath(runtimeDir)
    }
    spawn = vi.fn(() => createMockSubprocess())
    daemon = new DaemonServer({ ...paths, spawnSubprocess: spawn })
    await daemon.start()
    adapter = new DaemonPtyAdapter({ ...paths, runtimeDir })
    await adapter.establishLifecycleLease()
    for (const authority of source.authorities.values()) {
      await adapter.spawn({ sessionId: authority.ptyId, cols: 80, rows: 24 })
    }
    replaceDaemonProvider(adapter)
    freezeProfile = vi.fn(async () => {})
    idle = vi.spyOn(source.runtime, 'waitForTerminal').mockResolvedValue({
      handle: COORD,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    installPlannedRestartMaintenance(
      source.runtime,
      plannedRestartSourceMaintenance(lineage, freezeProfile)
    )
  })

  afterEach(async () => {
    await successor?.close()
    successor = undefined
    await adapter.disconnectOnly()
    await disconnectDaemon()
    await daemon.shutdown()
    db?.close()
    source.close()
    lineage.close()
    lock.release()
    rmSync(root, { recursive: true, force: true })
  })

  const maintenance = (request: Record<string, unknown>, caller = OPERATOR) =>
    source.call('orchestration.plannedRestart', { from: caller, request }, caller)

  async function prepare() {
    return resultOf(
      await maintenance({
        phase: 'prepare',
        runId: fixture.runId,
        sender: WORKER,
        proposal: fixture.proposal,
        proposalCanonicalSha256: hashCanonical(fixture.proposal)
      })
    )
  }

  async function seal() {
    const prepared = await prepare()
    const request = {
      phase: 'seal',
      preparationCanonicalSha256: prepared.preparationCanonicalSha256,
      expiresAtMs: Date.now() + 60_000
    }
    const sealed = resultOf(await maintenance(request))
    expect(resultOf(await maintenance(request))).toEqual(sealed)
    return sealed
  }

  it('completes two reviewed cycles with the same Run, daemon and full pending ACKs', async () => {
    const original = db!.getRun(fixture.runId)
    const originalSessions = (await adapter.listProcesses()).map((item) => item.id).sort()
    const sealed = await seal()
    expect(freezeProfile).toHaveBeenCalledOnce()
    expect(idle).toHaveBeenCalledTimes(2)
    expect(
      await source.call('orchestration.check', { terminal: COORD, run: fixture.runId }, COORD)
    ).toMatchObject({ ok: false })
    const sealRef = writeRestartFixture(join(root, 'seal.json'), sealed)
    const request = {
      phase: 'review',
      seal: {
        runId: fixture.runId,
        databaseId: z.object({ databaseId: z.string() }).parse(sealed.seal).databaseId,
        sealCanonicalSha256: sealed.sealCanonicalSha256
      },
      proposalCanonicalSha256: hashCanonical(fixture.proposal),
      approved: true,
      reason: 'Independent fixture review'
    }
    for (const actor of [COORD, OPERATOR, WORKER]) {
      expect(await maintenance(request, actor)).toMatchObject({ ok: false })
    }
    expect(await maintenance({ ...request, approved: false }, OTHER)).toMatchObject({ ok: false })
    const reviewed = resultOf(await maintenance(request, OTHER))
    expect(resultOf(await maintenance(request, OTHER))).toEqual(reviewed)
    const pins = {
      reviewCanonicalSha256: String(reviewed.reviewCanonicalSha256),
      proposalCanonicalSha256: hashCanonical(fixture.proposal)
    }
    await adapter.disconnectOnly()
    db!.close()
    db = undefined
    lineage.close()
    lock.release()
    lock = acquireOrcadInstanceLock(root)
    lineage = openOrcadRuntimeLineage(root, lock, { existingOnly: true })
    await expect(
      admitPlannedSuccessor(root, lineage, { ...pins, reviewCanonicalSha256: 'f'.repeat(64) })
    ).rejects.toThrow('review pin mismatch')
    successor = await admitPlannedSuccessor(root, lineage, pins)
    const restored = restoredPlannedRuntime(source, successor.runtimeId)
    restored.runtime.setOrchestrationDb(successor.db, { deferStartupEffects: true })
    await successor.activate(restored.runtime)
    await successor.commit()
    expect((await getDaemonProvider()!.listProcesses()).map((item) => item.id).sort()).toEqual(
      originalSessions
    )
    expect(spawn).toHaveBeenCalledTimes(4)
    installPlannedRestartMaintenance(restored.runtime, successor.maintenance)
    const call = (
      method: string,
      params: Record<string, unknown>,
      actor = COORD,
      requestId?: string
    ) =>
      restored.dispatcher.dispatch(
        orchestrationRequest(method, params, { evidence: source.evidence(actor), requestId })
      )
    const transition = resultOf(
      await call(
        'orchestration.plannedRestart',
        {
          request: { phase: 'transition', seal: sealRef }
        },
        OPERATOR
      )
    )
    expect(transition).toMatchObject({
      source_runtime: source.runtime.getRuntimeId(),
      target_runtime: successor.runtimeId
    })
    for (const [operation, actor] of [
      ['prepare', OPERATOR],
      ['run', WORKER],
      ['begin', COORD],
      ['finish', COORD],
      ['complete', OPERATOR]
    ]) {
      expect(
        resultOf(
          await call(
            'orchestration.plannedRestart',
            {
              request: { phase: 'boundary', transition, operation }
            },
            actor
          )
        )
      ).toMatchObject({ phase: operation, transition_canonical_sha256: hashCanonical(transition) })
    }
    const params = { terminal: COORD, run: fixture.runId }
    const delivery = resultOf(await call('orchestration.check', params))
    expect(delivery).toMatchObject({ count: 1 })
    const action = { run: fixture.runId, callerTerminalHandle: COORD, spec: 'Resume once' }
    const taskId = idOf(
      resultOf(await call('orchestration.taskCreate', action, COORD, 'pending-action')).task
    )
    expect(
      resultOf(await call('orchestration.taskCreate', action, COORD, 'pending-action'))
    ).toMatchObject({ task: { id: taskId }, mutation: { replayed: true } })
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        resultOf(await call('orchestration.check', { ...params, ack: delivery.deliveryId }))
      ).toMatchObject({ acknowledged: delivery.deliveryId, count: 0 })
    }
    expect(successor.db.getMessageById(fixture.messageId)?.read).toBe(1)
    expect(successor.db.getRun(fixture.runId)).toEqual(original)
    expect(successor.db.db.prepare('SELECT count(*) AS n FROM dispatch_contexts').get()?.n).toBe(0)
    expect(
      successor.db.db.prepare('SELECT count(*) AS n FROM strict_continuity_seals').get()?.n
    ).toBe(1)
    expect(restored.attest).toHaveBeenCalledWith(
      expect.objectContaining({ terminalProvenance: 'restored' })
    )
    // Repeat through the restored runtime (no fresh launch secret) and the same surviving daemon.
    fixture = await nextPlannedSourceFixture(root, fixture, restored, source, transition)
    vi.spyOn(restored.runtime, 'waitForTerminal').mockImplementation(source.runtime.waitForTerminal)
    installPlannedRestartHandlers(
      restored.runtime,
      plannedRestartSourceMaintenance(lineage, freezeProfile),
      successor.maintenance
    )
    const secondPrepare = resultOf(
      await call(
        'orchestration.plannedRestart',
        {
          request: {
            phase: 'prepare',
            runId: fixture.runId,
            sender: WORKER,
            proposal: fixture.proposal,
            proposalCanonicalSha256: hashCanonical(fixture.proposal)
          }
        },
        OPERATOR
      )
    )
    const secondSeal = resultOf(
      await call(
        'orchestration.plannedRestart',
        {
          request: {
            phase: 'seal',
            preparationCanonicalSha256: secondPrepare.preparationCanonicalSha256,
            expiresAtMs: Date.now() + 60_000
          }
        },
        OPERATOR
      )
    )
    const secondReview = resultOf(
      await call(
        'orchestration.plannedRestart',
        {
          request: {
            ...request,
            seal: { ...request.seal, sealCanonicalSha256: secondSeal.sealCanonicalSha256 },
            proposalCanonicalSha256: hashCanonical(fixture.proposal)
          }
        },
        OTHER
      )
    )
    await successor.close()
    successor = undefined
    lineage.close()
    lock.release()
    lock = acquireOrcadInstanceLock(root)
    lineage = openOrcadRuntimeLineage(root, lock, { existingOnly: true })
    successor = await admitPlannedSuccessor(root, lineage, {
      reviewCanonicalSha256: String(secondReview.reviewCanonicalSha256),
      proposalCanonicalSha256: hashCanonical(fixture.proposal)
    })
    const again = restoredPlannedRuntime(source, successor.runtimeId)
    again.runtime.setOrchestrationDb(successor.db, { deferStartupEffects: true })
    await successor.activate(again.runtime)
    await successor.commit()
    expect(successor.db.getRun(fixture.runId)).toEqual(original)
    expect(
      successor.db.db.prepare('SELECT count(*) AS n FROM strict_continuity_seals').get()?.n
    ).toBe(2)
    expect(spawn).toHaveBeenCalledTimes(4)
    const secondDelivery = resultOf(
      await again.dispatcher.dispatch(
        orchestrationRequest('orchestration.check', params, { evidence: source.evidence(COORD) })
      )
    )
    expect(secondDelivery).toMatchObject({ count: 1 })
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        resultOf(
          await again.dispatcher.dispatch(
            orchestrationRequest(
              'orchestration.check',
              {
                ...params,
                ack: secondDelivery.deliveryId
              },
              { evidence: source.evidence(COORD) }
            )
          )
        )
      ).toMatchObject({ acknowledged: secondDelivery.deliveryId, count: 0 })
    }
    expect(successor.db.getMessageById(fixture.messageId)?.read).toBe(1)
    restored.attest.mockReturnValue(null)
    expect(await call('orchestration.check', params)).toMatchObject({ ok: false })
  })

  it.each(['journal-commit', 'release-reply'] as const)(
    'retries after lost %s without a daemon effect or a second action',
    async (stage) => {
      const sealed = await seal()
      const reviewed = resultOf(
        await maintenance(
          {
            phase: 'review',
            seal: {
              runId: fixture.runId,
              databaseId: z.object({ databaseId: z.string() }).parse(sealed.seal).databaseId,
              sealCanonicalSha256: sealed.sealCanonicalSha256
            },
            proposalCanonicalSha256: hashCanonical(fixture.proposal),
            approved: true,
            reason: 'Independent failure-injection review'
          },
          OTHER
        )
      )
      const pins = {
        reviewCanonicalSha256: String(reviewed.reviewCanonicalSha256),
        proposalCanonicalSha256: hashCanonical(fixture.proposal)
      }
      await adapter.disconnectOnly()
      db!.close()
      db = undefined
      lineage.close()
      lock.release()
      lock = acquireOrcadInstanceLock(root)
      lineage = openOrcadRuntimeLineage(root, lock, { existingOnly: true })
      successor = await admitPlannedSuccessor(root, lineage, pins)
      const failedRuntimeId = successor.runtimeId
      const restored = restoredPlannedRuntime(source, failedRuntimeId)
      restored.runtime.setOrchestrationDb(successor.db, { deferStartupEffects: true })
      await successor.activate(restored.runtime)
      const commit = lineage.plannedRestart.commit.bind(lineage.plannedRestart)
      const release = DaemonPtyAdapter.prototype.plannedRestart
      const fault =
        stage === 'journal-commit'
          ? vi.spyOn(lineage.plannedRestart, 'commit').mockImplementationOnce(() => {
              commit()
              throw new Error('injected lost journal commit response')
            })
          : vi
              .spyOn(DaemonPtyAdapter.prototype, 'plannedRestart')
              .mockImplementationOnce(async function (this: DaemonPtyAdapter, operation, pin) {
                const result = await release.call(this, operation, pin)
                expect(operation).toBe('Release')
                throw new Error(`injected lost ${result.state} reply`)
              })
      try {
        await expect(successor.commit()).rejects.toThrow('injected lost')
      } finally {
        fault.mockRestore()
      }
      expect(successor.db.db.pragma('query_only', { simple: true })).toBe(1)
      await successor.close()
      successor = undefined
      lineage.close()
      lock.release()
      lock = acquireOrcadInstanceLock(root)
      lineage = openOrcadRuntimeLineage(root, lock, { existingOnly: true })
      successor = await admitPlannedSuccessor(root, lineage, pins)
      expect(successor.runtimeId).not.toBe(failedRuntimeId)
      const retry = restoredPlannedRuntime(source, successor.runtimeId)
      retry.runtime.setOrchestrationDb(successor.db, { deferStartupEffects: true })
      await successor.activate(retry.runtime)
      await successor.commit()
      expect(successor.db.getMessageById(fixture.messageId)?.read).toBe(0)
      expect(successor.db.db.prepare('SELECT count(*) AS n FROM deliveries').get()?.n).toBe(0)
      expect(spawn).toHaveBeenCalledTimes(4)
    }
  )

  it('rejects already-consumed pending messages before preparation or freeze', async () => {
    resultOf(
      await source.call('orchestration.check', { terminal: COORD, run: fixture.runId }, COORD)
    )
    await expect(prepare()).rejects.toThrow('pending_already_consumed')
    expect(lineage.plannedRestart.existingPreparation()).toBeUndefined()
    expect(freezeProfile).not.toHaveBeenCalled()
  })

  it('refuses busy after freeze and preserves the stopped attempt without a seal', async () => {
    idle
      .mockResolvedValueOnce({
        handle: COORD,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
      .mockResolvedValueOnce({
        handle: COORD,
        condition: 'tui-idle',
        satisfied: false,
        status: 'running',
        exitCode: null
      })
    await expect(seal()).rejects.toThrow('not_idle_after_freeze')
    expect(db!.db.prepare('SELECT count(*) AS n FROM strict_continuity_seals').get()?.n).toBe(0)
    const pin = lineage.plannedRestart.preparation().daemon!
    expect(await adapter.plannedRestart('Inspect', pin)).toMatchObject({ state: 'frozen' })
    expect(
      await source.call('orchestration.check', { terminal: COORD, run: fixture.runId }, COORD)
    ).toMatchObject({ ok: false })
  })
})
