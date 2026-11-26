import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import type { TestInfo } from '@stablyai/playwright-test'
import type { Repo } from '../../src/shared/repo-types'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  expectArchivedRemoteAgentRow,
  expectNoFalseEmptyState,
  expectSourceNotice,
  expectUnknownUsage,
  openTaskWorkbenchInPairedClient
} from './helpers/task-workbench-paired-page'
import { startSimulation, type SimRuntime, type Simulation } from './helpers/sim-remote'

const ISSUE_NUMBER = 31_572
const TRACKER_URL = `https://github.com/runrunliuliu/swarm-orca/issues/${ISSUE_NUMBER}`

async function registerRepo(runtime: SimRuntime): Promise<Repo> {
  const response = await runtime.client.call<{ repo: Repo }>('repo.add', {
    path: process.cwd(),
    kind: 'git'
  })
  return response.result.repo
}

async function addRuntime(
  client: PairedElectronClient,
  runtime: SimRuntime,
  name: string
): Promise<string> {
  return client.page.evaluate(
    async ({ name, pairingCode }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode
      })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error(`${name} was unreachable immediately after pairing`)
      }
      return result.environment.id
    },
    { name, pairingCode: runtime.pairingCode }
  )
}

async function refreshRuntime(
  client: PairedElectronClient,
  environmentId: string,
  timeoutMs = 2_000
): Promise<boolean> {
  return client.page.evaluate(
    async ({ environmentId, timeoutMs }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      return store.getState().refreshRuntimeEnvironmentStatus(environmentId, timeoutMs)
    },
    { environmentId, timeoutMs }
  )
}

async function expectPortFree(port: number): Promise<void> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () =>
      probe.close((error) => (error ? reject(error) : resolve()))
    )
  })
}

// oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
test('keeps live-host history honest while another paired runtime is down @sim-topology', async ({}, testInfo: TestInfo) => {
  test.setTimeout(90_000)
  let simulation: Simulation | null = null
  let client: PairedElectronClient | null = null
  const seeded: { alphaRepo?: Repo } = {}
  const runtimeDirs: string[] = []
  const runtimePorts: number[] = []
  const outcome: { error?: unknown } = {}
  try {
    simulation = await startSimulation({
      runtimes: [{ name: 'alpha' }, { name: 'beta' }],
      records: [
        {
          runtime: 'alpha',
          args: async (runtime) => {
            const repo = await registerRepo(runtime)
            seeded.alphaRepo = repo
            return {
              repoId: repo.id,
              itemType: 'issue',
              number: ISSUE_NUMBER,
              bindings: [
                {
                  worktreeId: `${repo.id}::${repo.path}`,
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
    const alphaRepo = seeded.alphaRepo
    if (!alphaRepo) {
      throw new Error('Alpha record setup did not register its repository')
    }
    const alpha = simulation.runtime('alpha')
    const beta = simulation.runtime('beta')
    runtimeDirs.push(alpha.userDataDir, beta.userDataDir)
    runtimePorts.push(Number(new URL(alpha.baseUrl).port), Number(new URL(beta.baseUrl).port))
    const betaRepo = await registerRepo(beta)
    expect(betaRepo.gitRemoteIdentity?.canonicalKey).toBe(alphaRepo.gitRemoteIdentity?.canonicalKey)

    client = await launchPairedElectronClient(
      { pairingUrl: alpha.pairingCode },
      testInfo,
      'Alpha runtime'
    )
    const alphaEnvironmentId = client.environmentId
    const betaEnvironmentId = await addRuntime(client, beta, 'Beta runtime')
    const pairedBeforeFailure = await client.page.evaluate(() =>
      window.api.runtimeEnvironments.list()
    )
    expect(pairedBeforeFailure.map((environment) => environment.id).sort()).toEqual(
      [alphaEnvironmentId, betaEnvironmentId].sort()
    )

    await beta.kill()
    expect(await refreshRuntime(client, betaEnvironmentId)).toBe(false)
    const { page, panel } = await openTaskWorkbenchInPairedClient(client, {
      pageRepoId: 'sim-topology-client-only-repo',
      clientRepoIdsToExclude: [alphaRepo.id, betaRepo.id],
      clientRepoIdsToAwait: [alphaRepo.id],
      issueNumber: ISSUE_NUMBER,
      title: 'Two-host partial failure',
      tracker: { state: 'closed', url: TRACKER_URL }
    })
    await expectArchivedRemoteAgentRow(panel, { runKind: /Simulated run 1/i })
    await expectUnknownUsage(panel)
    await expectSourceNotice(panel, /Could not read history from Beta runtime.*did not answer/i)
    await expectSourceNotice(panel, /History also includes what 1 environment\(s\) recorded/i)
    await expectNoFalseEmptyState(page, panel)

    await alpha.kill()
    expect(await refreshRuntime(client, alphaEnvironmentId)).toBe(false)
    await expectSourceNotice(panel, /Could not read history from Alpha runtime.*did not answer/i)
    await expectSourceNotice(panel, /Could not read history from Beta runtime.*did not answer/i)
    await expectNoFalseEmptyState(page, panel)

    const betaPortBeforeRestart = new URL(beta.baseUrl).port
    await beta.start()
    expect(new URL(beta.baseUrl).port).toBe(betaPortBeforeRestart)
    expect(await refreshRuntime(client, betaEnvironmentId, 5_000)).toBe(true)
    await expect(
      panel
        .getByTestId('task-workbench-history-source-unavailable')
        .filter({ hasText: /Beta runtime/i })
    ).toHaveCount(0)
    await expectSourceNotice(panel, /History also includes what 1 environment\(s\) recorded/i)
    await expectNoFalseEmptyState(page, panel)
    const pairedAfterRestart = await client.page.evaluate(() =>
      window.api.runtimeEnvironments.list()
    )
    expect(pairedAfterRestart.map((environment) => environment.id).sort()).toEqual(
      [alphaEnvironmentId, betaEnvironmentId].sort()
    )

    await testInfo.attach('sim-topology-partial-failure.json', {
      body: JSON.stringify(
        {
          recordRuntime: 'alpha',
          unavailableThenRejoined: 'beta',
          environmentIds: [alphaEnvironmentId, betaEnvironmentId],
          runtimePorts
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
  } catch (error) {
    outcome.error = error
  }

  const clientDir = client?.userDataDir
  const cleanup = await Promise.allSettled([
    client?.dispose() ?? Promise.resolve(),
    simulation?.dispose() ?? Promise.resolve()
  ])
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  const leakedPaths = [...runtimeDirs, ...(clientDir ? [clientDir] : [])].filter(existsSync)
  const portChecks = await Promise.allSettled(runtimePorts.map(expectPortFree))
  const portFailures = portChecks.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  const teardownFailures = [...cleanupFailures, ...portFailures]
  if (outcome.error !== undefined) {
    throw teardownFailures.length > 0
      ? new AggregateError(
          [outcome.error, ...teardownFailures],
          'Topology scenario and cleanup failed'
        )
      : outcome.error
  }
  if (teardownFailures.length > 0) {
    throw new AggregateError(teardownFailures, 'Topology scenario fixture cleanup failed')
  }
  expect(leakedPaths).toEqual([])
})
