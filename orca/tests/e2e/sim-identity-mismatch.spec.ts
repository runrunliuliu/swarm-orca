import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import type { Repo } from '../../src/shared/repo-types'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { openTaskWorkbenchInPairedClient } from './helpers/task-workbench-paired-page'
import { startSimulation, type Simulation } from './helpers/sim-remote'

const METADATA_FILE = path.join(process.cwd(), 'tests/e2e/fixtures/run3-issue-67-identity.json')
const OTHER_OWNER = 'identity-mismatch'

type PairedRuntimeCall = { method?: string; params?: unknown; selector?: string }

function cloneDifferentOwnerRegistration(identity: NonNullable<Simulation['identity']>): string {
  const root = path.dirname(identity.bareRepoPath)
  const clonePath = path.join(root, 'different-owner-worktree')
  const hooksPath = path.join(root, 'empty-hooks')
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  const git = (cwd: string, args: string[]): void => {
    execFileSync(
      'git',
      [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.file.allow=always',
        '-c',
        `core.hooksPath=${hooksPath}`,
        ...args
      ],
      { cwd, env: environment, stdio: 'pipe' }
    )
  }
  git(root, ['clone', identity.bareRepoPath, clonePath])
  git(clonePath, [
    'remote',
    'set-url',
    'origin',
    `git@github.com:${OTHER_OWNER}/${identity.repo}.git`
  ])
  return clonePath
}

async function installPairedRuntimeCallProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, args: PairedRuntimeCall) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's invocation registry is test instrumentation already used by the issue-67 acceptance.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const original = handlers?.get('runtimeEnvironments:call')
    if (!handlers || !original) {
      throw new Error('paired runtime call handler is unavailable')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test-owned global is written and read only inside the Electron main process.
    const probe = globalThis as typeof globalThis & {
      __identityMismatchRuntimeCalls?: PairedRuntimeCall[]
    }
    probe.__identityMismatchRuntimeCalls = []
    handlers.set('runtimeEnvironments:call', (event, args) => {
      probe.__identityMismatchRuntimeCalls!.push(args)
      return original(event, args)
    })
  })
}

async function readPairedRuntimeCalls(app: ElectronApplication): Promise<PairedRuntimeCall[]> {
  return app.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The paired-runtime call probe owns this main-process global.
    const probe = globalThis as typeof globalThis & {
      __identityMismatchRuntimeCalls?: PairedRuntimeCall[]
    }
    return probe.__identityMismatchRuntimeCalls ?? []
  })
}

// oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
test('a different repository with the same name is refused, not matched @sim-identity', async ({}, testInfo: TestInfo) => {
  test.setTimeout(90_000)
  let simulation: Simulation | null = null
  let client: PairedElectronClient | null = null
  const outcome: { error?: unknown } = {}
  try {
    simulation = await startSimulation({
      runtimes: [{ name: 'identity-host' }],
      identity: {
        owner: 'runrunliuliu',
        repo: 'swarm-orca',
        metadataFile: METADATA_FILE
      }
    })
    const identity = simulation.identity
    if (!identity) {
      throw new Error('Simulation did not prepare its requested identity')
    }
    const runtime = simulation.runtime('identity-host')
    const differentOwnerPath = cloneDifferentOwnerRegistration(identity)
    const differentOwner = await runtime.client.call<{ repo: Repo }>('repo.add', {
      path: differentOwnerPath,
      kind: 'git'
    })
    const differentPath = await runtime.client.call<{ repo: Repo }>('repo.add', {
      path: identity.worktreePath,
      kind: 'git'
    })
    expect(differentOwner.result.repo.id).not.toBe(differentPath.result.repo.id)
    expect(differentOwner.result.repo.gitRemoteIdentity?.canonicalKey).toBe(
      `github.com/${OTHER_OWNER}/${identity.repo}`
    )
    expect(differentPath.result.repo.gitRemoteIdentity?.canonicalKey).toBe(identity.canonicalKey)
    expect(differentOwner.result.repo.path).not.toBe(differentPath.result.repo.path)

    client = await launchPairedElectronClient(
      { pairingUrl: runtime.pairingCode },
      testInfo,
      'Identity mismatch runtime'
    )
    await installPairedRuntimeCallProbe(client.app)
    const { catalogEvidence, page, panel } = await openTaskWorkbenchInPairedClient(client, {
      pageRepoId: differentOwner.result.repo.id,
      clientRepoIdsToExclude: [differentOwner.result.repo.id, differentPath.result.repo.id],
      issueNumber: identity.tracker.number,
      title: identity.tracker.title,
      tracker: { state: identity.tracker.state, url: identity.tracker.url }
    })
    await testInfo.attach('identity-mismatch-catalog.json', {
      body: JSON.stringify(catalogEvidence, null, 2),
      contentType: 'application/json'
    })

    const undetermined = panel.getByTestId('task-workbench-history-source-undetermined')
    await expect(undetermined).toBeVisible()
    await expect(undetermined).toHaveAttribute('data-source-state', 'undetermined')
    await expect(page.getByTestId('task-workbench-empty-state')).toHaveCount(0)
    await expect(panel.getByTestId('task-workbench-history-run')).toHaveCount(0)
    await expect(panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)

    await expect
      .poll(
        async () =>
          (await readPairedRuntimeCalls(client!.app)).some((call) => call.method === 'repo.list'),
        { message: 'the paired repository catalog was never read' }
      )
      .toBe(true)
    const calls = await readPairedRuntimeCalls(client.app)
    expect(calls.filter((call) => call.method === 'taskRecords.get')).toEqual([])
    await testInfo.attach('identity-mismatch-evidence.json', {
      body: JSON.stringify(
        {
          pageRepoId: differentOwner.result.repo.id,
          pageRepoCanonicalKey: differentOwner.result.repo.gitRemoteIdentity?.canonicalKey,
          trackerCanonicalKey: identity.canonicalKey,
          sameOwnerNameDifferentPathRepoId: differentPath.result.repo.id,
          paths: [differentOwner.result.repo.path, differentPath.result.repo.path],
          runtimeCalls: calls
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
  } catch (error) {
    outcome.error = error
  }
  const cleanup = await Promise.allSettled([
    client?.dispose() ?? Promise.resolve(),
    simulation?.dispose() ?? Promise.resolve()
  ])
  const cleanupFailures = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (outcome.error !== undefined) {
    throw cleanupFailures.length > 0
      ? new AggregateError(
          [outcome.error, ...cleanupFailures],
          'Identity mismatch run and cleanup failed'
        )
      : outcome.error
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Identity mismatch fixture cleanup failed')
  }
})
