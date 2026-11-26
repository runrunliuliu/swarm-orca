import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { startSimulation, type Simulation } from './helpers/sim-remote'
import {
  expectArchivedRemoteAgentRow,
  expectNoFalseEmptyState,
  expectSourceNotice,
  expectUnknownUsage,
  openTaskWorkbenchInPairedClient
} from './helpers/task-workbench-paired-page'

const RUNTIME_NAME = 'network-degraded'
const RUNTIME_LABEL = 'Network degraded runtime'
const ISSUE_NUMBER = 3101
const PAGE_REPO_ID = 'network-degraded-page-repo-absent'
const TRACKER_URL = `https://github.com/runrunliuliu/swarm-orca/issues/${ISSUE_NUMBER}`

type PairedRuntimeCall = {
  method?: string
  params?: unknown
  selector?: string
  settlement?: 'fulfilled' | 'rejected'
}

async function installPairedRuntimeCallProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, args: PairedRuntimeCall) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's test-owned invocation registry is the narrow observable seam for paired RPC traffic.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const original = handlers?.get('runtimeEnvironments:call')
    if (!handlers || !original) {
      throw new Error('paired runtime call handler is unavailable')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test-owned global is written and read only inside the Electron main process.
    const probe = globalThis as typeof globalThis & {
      __networkDegradedRuntimeCalls?: PairedRuntimeCall[]
    }
    probe.__networkDegradedRuntimeCalls = []
    handlers.set('runtimeEnvironments:call', async (event, args) => {
      const call = { ...args }
      probe.__networkDegradedRuntimeCalls!.push(call)
      try {
        const result = await original(event, args)
        call.settlement = 'fulfilled'
        return result
      } catch (error) {
        call.settlement = 'rejected'
        throw error
      }
    })
  })
}

async function readPairedRuntimeCalls(app: ElectronApplication): Promise<PairedRuntimeCall[]> {
  return app.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The paired-runtime call probe owns this main-process global.
    const probe = globalThis as typeof globalThis & {
      __networkDegradedRuntimeCalls?: PairedRuntimeCall[]
    }
    return probe.__networkDegradedRuntimeCalls ?? []
  })
}

function fulfilledTaskRecordReads(calls: readonly PairedRuntimeCall[]): number {
  return calls.filter(
    (call) => call.method === 'taskRecords.get' && call.settlement === 'fulfilled'
  ).length
}

// oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
test('reads archived task history through a degraded link @sim-network', async ({}, testInfo: TestInfo) => {
  test.setTimeout(90_000)
  let simulation: Simulation | null = null
  let client: PairedElectronClient | null = null
  let testError: unknown
  try {
    let runtimeRepoId = ''
    simulation = await startSimulation({
      runtimes: [{ name: RUNTIME_NAME }],
      network: {
        target: RUNTIME_NAME,
        faults: { latencyMs: 120, jitterMs: 40 }
      },
      records: [
        {
          runtime: RUNTIME_NAME,
          args: async (runtime) => {
            const added = await runtime.client.call<{ repo: { id: string } }>('repo.add', {
              path: process.cwd(),
              kind: 'git'
            })
            runtimeRepoId = added.result.repo.id
            return {
              repoId: runtimeRepoId,
              itemType: 'issue',
              number: ISSUE_NUMBER,
              bindings: [
                {
                  worktreeId: `${runtimeRepoId}::${process.cwd()}`,
                  hostId: 'local',
                  isArchived: true,
                  runs: 1,
                  usage: 'unknown'
                }
              ]
            }
          }
        }
      ]
    })
    const proxy = simulation.proxy
    if (!proxy || runtimeRepoId === '') {
      throw new Error('Network-degraded simulation did not create its proxy and record')
    }
    const runtime = simulation.runtime(RUNTIME_NAME)
    client = await launchPairedElectronClient(
      { pairingUrl: runtime.pairingCode },
      testInfo,
      RUNTIME_LABEL
    )
    await installPairedRuntimeCallProbe(client.app)

    const pageArgs = {
      pageRepoId: PAGE_REPO_ID,
      clientRepoIdsToExclude: [runtimeRepoId],
      issueNumber: ISSUE_NUMBER,
      projectId: 'network-degraded-read-e2e',
      title: 'Archived history across a degraded link',
      tracker: { state: 'closed' as const, url: TRACKER_URL }
    }
    const { page, panel } = await openTaskWorkbenchInPairedClient(client, pageArgs)
    await expect
      .poll(async () => fulfilledTaskRecordReads(await readPairedRuntimeCalls(client!.app)), {
        timeout: 45_000,
        message: 'the degraded runtime never completed taskRecords.get'
      })
      .toBeGreaterThan(0)
    await expectArchivedRemoteAgentRow(panel)
    await expectUnknownUsage(panel)
    await expectSourceNotice(panel, /History also includes what 1 environment\(s\) recorded/i)
    await expectNoFalseEmptyState(page, panel)
    await expect
      .poll(
        () => {
          const stats = proxy.stats()
          return stats.connections > 0 && stats.bytesUp > 0 && stats.bytesDown > 0
        },
        { message: 'the accepted task-history read did not cross the degraded proxy' }
      )
      .toBe(true)

    const callsBeforeRaisedLatency = await readPairedRuntimeCalls(client.app)
    const fulfilledBeforeRaisedLatency = fulfilledTaskRecordReads(callsBeforeRaisedLatency)
    const statsBeforeRaisedLatency = proxy.stats()
    proxy.setFaults({ latencyMs: 240, jitterMs: 40 })
    const raisedLatencyView = await openTaskWorkbenchInPairedClient(client, pageArgs)
    await expect
      .poll(async () => fulfilledTaskRecordReads(await readPairedRuntimeCalls(client!.app)), {
        timeout: 45_000,
        message: 'the task page did not complete a fresh read after latency increased'
      })
      .toBeGreaterThan(fulfilledBeforeRaisedLatency)
    await expectArchivedRemoteAgentRow(raisedLatencyView.panel)
    await expectUnknownUsage(raisedLatencyView.panel)
    await expectNoFalseEmptyState(raisedLatencyView.page, raisedLatencyView.panel)
    await expect
      .poll(
        () => {
          const stats = proxy.stats()
          return (
            stats.bytesUp > statsBeforeRaisedLatency.bytesUp &&
            stats.bytesDown > statsBeforeRaisedLatency.bytesDown
          )
        },
        { message: 'the raised-latency reread did not exchange bytes in both directions' }
      )
      .toBe(true)

    await testInfo.attach('network-degraded-read-evidence.json', {
      body: JSON.stringify(
        {
          faults: [
            { phase: 'initial-read', latencyMs: 120, jitterMs: 40 },
            { phase: 'fresh-read', latencyMs: 240, jitterMs: 40 }
          ],
          proxy: {
            beforeRaisedLatency: statsBeforeRaisedLatency,
            final: proxy.stats()
          },
          runtimeCalls: await readPairedRuntimeCalls(client.app)
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
  } catch (error) {
    testError = error
  } finally {
    const cleanup = await Promise.allSettled([
      client?.dispose() ?? Promise.resolve(),
      simulation?.dispose() ?? Promise.resolve()
    ])
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (cleanupFailures.length > 0) {
      testError =
        testError === undefined
          ? new AggregateError(cleanupFailures, 'Network-degraded fixture cleanup failed')
          : new AggregateError(
              [testError, ...cleanupFailures],
              'Network-degraded run and cleanup failed'
            )
    }
  }
  if (testError !== undefined) {
    throw testError
  }
})
