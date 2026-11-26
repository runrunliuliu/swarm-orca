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

const RUNTIME_NAME = 'network-cut'
const RUNTIME_LABEL = 'Network cut runtime'
const ISSUE_NUMBER = 3102
const PAGE_REPO_ID = 'network-cut-page-repo-absent'
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
      __networkCutRuntimeCalls?: PairedRuntimeCall[]
    }
    probe.__networkCutRuntimeCalls = []
    handlers.set('runtimeEnvironments:call', async (event, args) => {
      const call = { ...args }
      probe.__networkCutRuntimeCalls!.push(call)
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
      __networkCutRuntimeCalls?: PairedRuntimeCall[]
    }
    return probe.__networkCutRuntimeCalls ?? []
  })
}

function fulfilledTaskRecordReads(calls: readonly PairedRuntimeCall[]): number {
  return calls.filter(
    (call) => call.method === 'taskRecords.get' && call.settlement === 'fulfilled'
  ).length
}

// oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
test('degrades explicitly on a cut link and recovers after reconnect @sim-network', async ({}, testInfo: TestInfo) => {
  test.setTimeout(90_000)
  let simulation: Simulation | null = null
  let client: PairedElectronClient | null = null
  let testError: unknown
  try {
    let runtimeRepoId = ''
    simulation = await startSimulation({
      runtimes: [{ name: RUNTIME_NAME }],
      network: { target: RUNTIME_NAME },
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
      throw new Error('Network-cut simulation did not create its proxy and record')
    }
    const runtime = simulation.runtime(RUNTIME_NAME)
    client = await launchPairedElectronClient(
      { pairingUrl: runtime.pairingCode },
      testInfo,
      RUNTIME_LABEL
    )
    const originalEnvironmentId = client.environmentId
    await installPairedRuntimeCallProbe(client.app)

    const pageArgs = {
      pageRepoId: PAGE_REPO_ID,
      clientRepoIdsToExclude: [runtimeRepoId],
      issueNumber: ISSUE_NUMBER,
      projectId: 'network-cut-degrade-e2e',
      title: 'Archived history across a cut link',
      tracker: { state: 'closed' as const, url: TRACKER_URL }
    }
    const healthyView = await openTaskWorkbenchInPairedClient(client, pageArgs)
    await expect
      .poll(async () => fulfilledTaskRecordReads(await readPairedRuntimeCalls(client!.app)), {
        timeout: 45_000,
        message: 'the healthy runtime never completed taskRecords.get'
      })
      .toBeGreaterThan(0)
    await expectArchivedRemoteAgentRow(healthyView.panel)
    await expectUnknownUsage(healthyView.panel)
    await expectNoFalseEmptyState(healthyView.page, healthyView.panel)
    const fulfilledBeforeCut = fulfilledTaskRecordReads(await readPairedRuntimeCalls(client.app))
    const healthyStats = proxy.stats()
    expect(healthyStats.connections).toBeGreaterThan(0)
    expect(healthyStats.bytesUp).toBeGreaterThan(0)
    expect(healthyStats.bytesDown).toBeGreaterThan(0)

    proxy.cut()
    await expect
      .poll(() => proxy.stats().resets, {
        message: 'cut() did not reset the live proxied connection'
      })
      .toBeGreaterThan(healthyStats.resets)

    let cutRefreshFailure: unknown
    try {
      await openTaskWorkbenchInPairedClient(client, pageArgs)
    } catch (error) {
      cutRefreshFailure = error
    }
    expect(String(cutRefreshFailure)).toContain(
      'Paired runtime status did not refresh for the task page'
    )
    await expectSourceNotice(
      healthyView.panel,
      new RegExp(
        `Could not read history from ${RUNTIME_LABEL}: it did not answer \\(timeout or lost connection\\)`,
        'i'
      )
    )
    await expect(healthyView.page.getByTestId('task-workbench-empty-state')).toHaveCount(0)
    await expect(healthyView.panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)
    const cutStats = proxy.stats()

    proxy.restore()
    await expect
      .poll(
        async () => {
          try {
            await runtime.client.call('status.get')
            return true
          } catch {
            return false
          }
        },
        {
          timeout: 20_000,
          intervals: [100, 250, 500, 1_000],
          message: 'restore() never rebound the proxy listener for a fresh connection'
        }
      )
      .toBe(true)
    const listenerRestoredStats = proxy.stats()
    const recoveredView = await openTaskWorkbenchInPairedClient(client, pageArgs)
    expect(client.environmentId).toBe(originalEnvironmentId)
    await expect
      .poll(async () => fulfilledTaskRecordReads(await readPairedRuntimeCalls(client!.app)), {
        timeout: 45_000,
        message: 'the unchanged paired client never completed taskRecords.get after restore()'
      })
      .toBeGreaterThan(fulfilledBeforeCut)
    await expectArchivedRemoteAgentRow(recoveredView.panel)
    await expectUnknownUsage(recoveredView.panel)
    await expectSourceNotice(
      recoveredView.panel,
      /History also includes what 1 environment\(s\) recorded/i
    )
    await expectNoFalseEmptyState(recoveredView.page, recoveredView.panel)
    await expect
      .poll(() => proxy.stats().connections, {
        message: 'the paired client did not create a new socket after restore()'
      })
      .toBeGreaterThan(listenerRestoredStats.connections)

    await testInfo.attach('network-cut-degrade-evidence.json', {
      body: JSON.stringify(
        {
          environmentId: originalEnvironmentId,
          environmentIdAfterRestore: client.environmentId,
          restoreContract:
            'restore() rebinds the listener but does not resurrect sockets reset by cut(); the unchanged paired client reconnected.',
          proxy: {
            healthy: healthyStats,
            cut: cutStats,
            listenerRestored: listenerRestoredStats,
            recovered: proxy.stats()
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
          ? new AggregateError(cleanupFailures, 'Network-cut fixture cleanup failed')
          : new AggregateError(
              [testError, ...cleanupFailures],
              'Network-cut run and cleanup failed'
            )
    }
  }
  if (testError !== undefined) {
    throw testError
  }
})
