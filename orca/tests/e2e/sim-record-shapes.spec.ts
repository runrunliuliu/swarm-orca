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
  expandTaskWorkbenchAgentHistory,
  expandTaskWorkbenchHistoryDetails,
  expectNoFalseEmptyState,
  expectUnknownUsage,
  openTaskWorkbenchInPairedClient
} from './helpers/task-workbench-paired-page'
import { startSimulation, type SimRuntime, type Simulation } from './helpers/sim-remote'

const SHAPES = {
  archivedUnknown: 31_581,
  archivedKnown: 31_582,
  liveRuntime: 31_583,
  noRuns: 31_584
} as const
const TRACKER_ROOT = 'https://github.com/runrunliuliu/swarm-orca/issues'

async function registerRepo(runtime: SimRuntime): Promise<Repo> {
  const response = await runtime.client.call<{ repo: Repo }>('repo.add', {
    path: process.cwd(),
    kind: 'git'
  })
  return response.result.repo
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
test('renders four persisted record shapes without inventing empty or zero states @sim-shapes', async ({}, testInfo: TestInfo) => {
  test.setTimeout(90_000)
  let simulation: Simulation | null = null
  let client: PairedElectronClient | null = null
  let repoPromise: Promise<Repo> | null = null
  const outcome: { error?: unknown } = {}
  const runtimeDirs: string[] = []
  const runtimePorts: number[] = []
  try {
    const withRepo = (runtime: SimRuntime): Promise<Repo> => {
      repoPromise ??= registerRepo(runtime)
      return repoPromise
    }
    simulation = await startSimulation({
      runtimes: [{ name: 'shapes' }],
      records: [
        {
          runtime: 'shapes',
          args: async (runtime) => {
            const repo = await withRepo(runtime)
            return {
              repoId: repo.id,
              itemType: 'issue',
              number: SHAPES.archivedUnknown,
              bindings: [
                {
                  worktreeId: `${repo.id}::/sim/archive-unknown`,
                  hostId: 'local',
                  isArchived: true,
                  runs: 2,
                  usage: 'unknown'
                }
              ]
            }
          }
        },
        {
          runtime: 'shapes',
          args: async (runtime) => {
            const repo = await withRepo(runtime)
            return {
              repoId: repo.id,
              itemType: 'issue',
              number: SHAPES.archivedKnown,
              bindings: [
                {
                  worktreeId: `${repo.id}::/sim/archive-known`,
                  hostId: 'local',
                  isArchived: true,
                  runs: 1,
                  usage: { tokens: 432, costUsd: 1.25 }
                }
              ]
            }
          }
        },
        {
          runtime: 'shapes',
          args: async (runtime) => {
            const repo = await withRepo(runtime)
            return {
              repoId: repo.id,
              itemType: 'issue',
              number: SHAPES.liveRuntime,
              bindings: [
                {
                  worktreeId: `${repo.id}::/sim/live-runtime-only`,
                  hostId: 'local',
                  isArchived: false,
                  runs: 1,
                  usage: 'unknown'
                }
              ]
            }
          }
        },
        {
          runtime: 'shapes',
          args: async (runtime) => {
            const repo = await withRepo(runtime)
            return {
              repoId: repo.id,
              itemType: 'issue',
              number: SHAPES.noRuns,
              bindings: [
                {
                  worktreeId: `${repo.id}::/sim/no-runs`,
                  hostId: 'local',
                  isArchived: true,
                  runs: 0
                }
              ]
            }
          }
        }
      ]
    })
    const runtime = simulation.runtime('shapes')
    const repo = await withRepo(runtime)
    runtimeDirs.push(runtime.userDataDir)
    runtimePorts.push(Number(new URL(runtime.baseUrl).port))
    client = await launchPairedElectronClient(
      { pairingUrl: runtime.pairingCode },
      testInfo,
      'Record shapes runtime'
    )
    const openShape = (number: number, title: string) =>
      openTaskWorkbenchInPairedClient(client!, {
        pageRepoId: `sim-shape-client-only-${number}`,
        clientRepoIdsToExclude: [repo.id],
        issueNumber: number,
        title,
        tracker: { state: 'closed', url: `${TRACKER_ROOT}/${number}` }
      })

    const archivedUnknown = await openShape(
      SHAPES.archivedUnknown,
      'Archived record with two unknown-usage runs'
    )
    await expect(archivedUnknown.history).toHaveAttribute('data-trace', 'archived')
    await expandTaskWorkbenchHistoryDetails(archivedUnknown.history)
    await expect(archivedUnknown.history.getByTestId('task-workbench-history-run')).toHaveCount(2)
    await expectUnknownUsage(archivedUnknown.panel)
    await expectNoFalseEmptyState(archivedUnknown.page, archivedUnknown.panel)

    const archivedKnown = await openShape(SHAPES.archivedKnown, 'Archived record with known usage')
    await expect(archivedKnown.history).toHaveAttribute('data-trace', 'archived')
    await expandTaskWorkbenchHistoryDetails(archivedKnown.history)
    await expect(archivedKnown.history.getByTestId('task-workbench-history-run')).toHaveCount(1)
    await expect(archivedKnown.history.getByTestId('task-workbench-history-facts')).toContainText(
      '432 tokens'
    )
    await expect(
      archivedKnown.history.getByTestId('task-workbench-history-facts')
    ).not.toContainText('tokens unknown')
    await expectNoFalseEmptyState(archivedKnown.page, archivedKnown.panel)

    const liveRuntime = await openShape(
      SHAPES.liveRuntime,
      'Live runtime binding absent from the client catalog'
    )
    await expandTaskWorkbenchAgentHistory(liveRuntime.panel)
    await expect(liveRuntime.panel.getByTestId('task-workbench-history-run')).toHaveCount(1)
    await expect(liveRuntime.panel.getByTestId('task-workbench-history')).toHaveCount(0)
    await expect(liveRuntime.panel.getByTestId('task-workbench-history-trace-lost')).toHaveCount(0)
    await expect(liveRuntime.panel).not.toContainText(/Workspace deleted/i)
    await expect(liveRuntime.panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)

    const noRuns = await openShape(SHAPES.noRuns, 'Archived binding without recorded runs')
    await expect(noRuns.history).toHaveAttribute('data-trace', 'archived')
    await expandTaskWorkbenchHistoryDetails(noRuns.history)
    await expect(noRuns.history.getByTestId('task-workbench-history-run')).toHaveCount(0)
    await expect(noRuns.history.getByTestId('task-workbench-history-runs-none')).toHaveText(
      'No run recorded.'
    )
    await expect(noRuns.panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)
    await expectNoFalseEmptyState(noRuns.page, noRuns.panel)

    await testInfo.attach('sim-record-shapes.json', {
      body: JSON.stringify(
        {
          repoId: repo.id,
          issues: SHAPES,
          bindings: {
            archivedUnknown: { archived: true, runs: 2, usage: 'unknown' },
            archivedKnown: { archived: true, runs: 1, tokens: 432, costUsd: 1.25 },
            liveRuntime: { archived: false, runs: 1, clientCatalog: 'absent' },
            noRuns: { archived: true, runs: 0, usage: 'not-recorded' }
          }
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
          'Record-shapes scenario and cleanup failed'
        )
      : outcome.error
  }
  if (teardownFailures.length > 0) {
    throw new AggregateError(teardownFailures, 'Record-shapes fixture cleanup failed')
  }
  expect(leakedPaths).toEqual([])
})
