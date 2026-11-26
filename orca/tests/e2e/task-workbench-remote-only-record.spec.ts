import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead
} from '../../src/shared/runtime-terminal-contracts'
import type {
  RuntimeRepoList,
  RuntimeWorktreeCreateResult
} from '../../src/shared/runtime-worktree-contracts'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { getGoldenStubAgentLaunchEnv, GOLDEN_STUB_READY_MARKER } from './helpers/golden-stub-agent'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
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

const ISSUE_NUMBER = 67
const SESSION_ID = 'issue-67-remote-only-record'
const REMOTE_OWNER = 'orca-e2e'
const REMOTE_REPO = 'remote-only-record'
const REMOTE_URL = `https://github.com/${REMOTE_OWNER}/${REMOTE_REPO}.git`
const PAGE_REPO_ID = 'issue-67-page-repo-absent-from-client'

type RuntimeFixture = { repoPath: string; root: string }
type PairedRuntimeCall = { method?: string; params?: unknown; selector?: string }

function createRuntimeRepo(): RuntimeFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-task-record-'))
  const repoPath = path.join(root, 'source')
  mkdirSync(repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), '# remote-only task record\n')
  execFileSync('git', ['init'], { cwd: repoPath })
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['remote', 'add', 'origin', REMOTE_URL], { cwd: repoPath })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync(
    'git',
    ['-c', 'user.name=Orca E2E', '-c', 'user.email=orca-e2e@example.com', 'commit', '-m', 'seed'],
    { cwd: repoPath }
  )
  return { repoPath, root }
}

async function launchRuntimeWithGoldenStub(): Promise<HeadlessPairedRuntimeHost> {
  // The stub is a real runtime-managed agent process; PATH injection is the only opt-in.
  const launchEnv = getGoldenStubAgentLaunchEnv()
  const pathKey = Object.keys(launchEnv)[0]!
  const previousPath = process.env[pathKey]
  process.env[pathKey] = launchEnv[pathKey]
  try {
    return await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey]
    } else {
      process.env[pathKey] = previousPath
    }
  }
}

async function terminalOutput(host: HeadlessPairedRuntimeHost, handle: string): Promise<string> {
  const read = await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: handle,
    limit: 300
  })
  return read.result.terminal.tail.join('\n')
}

async function emitCodexRun(
  host: HeadlessPairedRuntimeHost,
  paneKey: string,
  worktreeId: string,
  transcriptPath: string
): Promise<void> {
  const endpoint = await readHookEndpoint(host.app)
  const [tabId] = paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId,
      worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        prompt: 'Record issue 67 without calling a model.'
      }
    })
  })
  if (response.status !== 204) {
    throw new Error(`Codex hook POST returned ${response.status}`)
  }
}

async function captureClientCatalog(
  page: Page,
  pageRepoId: string,
  runtimeRepoId: string
): Promise<{
  environmentIds: string[]
  pageRepoKnown: boolean
  runtimeEnvironmentCatalogHydrated: boolean
  runtimeEnvironmentCatalogSettled: boolean
  runtimeRepoKnown: boolean
  statusEnvironmentIds: string[]
}> {
  return page.evaluate(
    ({ pageRepoId, runtimeRepoId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      const finalState = store.getState()
      return {
        environmentIds: finalState.runtimeEnvironments.map((environment) => environment.id),
        pageRepoKnown: finalState.repos.some((repo) => repo.id === pageRepoId),
        runtimeEnvironmentCatalogHydrated: finalState.runtimeEnvironmentCatalogHydrated,
        runtimeEnvironmentCatalogSettled: finalState.runtimeEnvironmentCatalogSettled,
        runtimeRepoKnown: finalState.repos.some((repo) => repo.id === runtimeRepoId),
        statusEnvironmentIds: [...finalState.runtimeStatusByEnvironmentId.keys()]
      }
    },
    { pageRepoId, runtimeRepoId }
  )
}

async function capturePairedEnvironmentEvidence(
  page: Page,
  environmentId: string,
  owner: string,
  repo: string
): Promise<{
  environmentId: string
  environmentIds: string[]
  runtimeEnvironmentCatalogHydrated: boolean
  runtimeEnvironmentCatalogSettled: boolean
  runtimeRepoId: string
  statusKnown: boolean
}> {
  return page.evaluate(
    async ({ environmentId, owner, repo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      const state = store.getState()
      const status = state.runtimeStatusByEnvironmentId.get(environmentId)
      const repoListResponse = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'repo.list'
      })
      if (repoListResponse.ok === false) {
        throw new Error(
          `paired runtime repo.list failed: ${JSON.stringify(repoListResponse.error)}`
        )
      }
      const repoList = repoListResponse.result as RuntimeRepoList
      const runtimeRepo = repoList.repos.find(
        (candidate) =>
          candidate.gitRemoteIdentity?.remoteUrl === `https://github.com/${owner}/${repo}.git`
      )
      if (!runtimeRepo) {
        throw new Error(`paired runtime repo.list had no row for ${owner}/${repo}`)
      }
      return {
        environmentId,
        environmentIds: state.runtimeEnvironments.map((environment) => environment.id),
        runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
        runtimeEnvironmentCatalogSettled: state.runtimeEnvironmentCatalogSettled,
        runtimeRepoId: runtimeRepo.id,
        statusKnown: status !== undefined
      }
    },
    { environmentId, owner, repo }
  )
}

function requireSetup(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Issue 67 setup guard failed: ${message}`)
  }
}

async function installPairedRuntimeCallProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, args: PairedRuntimeCall) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's invocation registry is test instrumentation already used by neighboring E2E probes.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const original = handlers?.get('runtimeEnvironments:call')
    const originalLocal = handlers?.get('taskRecords:get')
    if (!handlers || !original || !originalLocal) {
      throw new Error('task record IPC handlers are unavailable')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test-owned global is written and read only inside the Electron main process.
    const probe = globalThis as typeof globalThis & { __issue67RuntimeCalls?: PairedRuntimeCall[] }
    probe.__issue67RuntimeCalls = []
    handlers.set('runtimeEnvironments:call', (event, args) => {
      probe.__issue67RuntimeCalls!.push(args)
      return original(event, args)
    })
    handlers.set('taskRecords:get', (event, args) => {
      probe.__issue67RuntimeCalls!.push({ method: 'taskRecords:get-local', params: args })
      return originalLocal(event, args)
    })
  })
}

async function readPairedRuntimeCalls(app: ElectronApplication): Promise<PairedRuntimeCall[]> {
  return app.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The paired-runtime call probe owns this main-process global.
    const probe = globalThis as typeof globalThis & { __issue67RuntimeCalls?: PairedRuntimeCall[] }
    return probe.__issue67RuntimeCalls ?? []
  })
}

// oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
test('reads an archived task record that exists only on a paired runtime', async ({}, testInfo: TestInfo) => {
  test.setTimeout(300_000)
  const fixture = createRuntimeRepo()
  let host: HeadlessPairedRuntimeHost | null = null
  let client: PairedElectronClient | null = null
  let testError: unknown
  try {
    host = await launchRuntimeWithGoldenStub()
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: fixture.repoPath,
      kind: 'git'
    })
    const remoteRepoId = added.result.repo.id
    const created = await host.client.call<RuntimeWorktreeCreateResult>('worktree.create', {
      repo: `id:${remoteRepoId}`,
      name: 'issue-67-remote-only',
      noParent: true,
      linkedIssue: ISSUE_NUMBER,
      setupDecision: 'skip',
      activate: false,
      startupAgent: 'codex',
      startupPrompt: 'Record issue 67 without calling a model.'
    })
    const worktreeId = created.result.worktree.id
    const worktreePath = created.result.worktree.path
    const agentHandle = created.result.agentTerminalHandle
    if (!agentHandle) {
      throw new Error('Runtime did not return the startup agent terminal handle')
    }
    await expect
      .poll(() => terminalOutput(host!, agentHandle), {
        timeout: 60_000,
        message: 'golden stub agent never became ready on the runtime'
      })
      .toContain(GOLDEN_STUB_READY_MARKER)
    const terminals = await host.client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: `id:${worktreeId}`,
      limit: 20
    })
    const agentTerminal = terminals.result.terminals.find(
      (terminal) => terminal.handle === agentHandle
    )
    if (!agentTerminal) {
      throw new Error(`Runtime did not list startup terminal ${agentHandle}`)
    }
    const transcriptPath = path.join(worktreePath, 'issue-67-session.jsonl')
    writeFileSync(transcriptPath, '{"type":"session_meta"}\n')
    await emitCodexRun(
      host,
      makePaneKey(agentTerminal.tabId, agentTerminal.leafId),
      worktreeId,
      transcriptPath
    )
    await host.client.call('worktree.set', {
      worktree: `id:${worktreeId}`,
      isArchived: true
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Issue 67 runtime')
    const pairedEnvironmentEvidence = await capturePairedEnvironmentEvidence(
      client.page,
      client.environmentId,
      REMOTE_OWNER,
      REMOTE_REPO
    )
    await testInfo.attach('issue-67-paired-environment.json', {
      body: JSON.stringify(pairedEnvironmentEvidence, null, 2),
      contentType: 'application/json'
    })
    requireSetup(
      pairedEnvironmentEvidence.runtimeRepoId === remoteRepoId,
      `repo.list resolved ${pairedEnvironmentEvidence.runtimeRepoId}, expected runtime row ${remoteRepoId}`
    )
    requireSetup(
      remoteRepoId !== PAGE_REPO_ID,
      'page repo id must be distinct from runtime repo id'
    )
    requireSetup(
      pairedEnvironmentEvidence.runtimeEnvironmentCatalogHydrated,
      'runtime environment catalog was not hydrated'
    )
    requireSetup(
      pairedEnvironmentEvidence.runtimeEnvironmentCatalogSettled,
      'runtime environment catalog was not settled'
    )
    requireSetup(
      pairedEnvironmentEvidence.environmentIds.includes(client.environmentId),
      'paired environment was absent from the client environment list'
    )
    requireSetup(pairedEnvironmentEvidence.statusKnown, 'paired runtime status was unavailable')
    await installPairedRuntimeCallProbe(client.app)
    const { page, panel } = await openTaskWorkbenchInPairedClient(client, {
      pageRepoId: PAGE_REPO_ID,
      clientRepoIdsToExclude: [pairedEnvironmentEvidence.runtimeRepoId],
      issueNumber: ISSUE_NUMBER,
      projectId: 'remote-only-e2e',
      title: 'Remote-only archived task record',
      tracker: {
        state: 'closed',
        url: `https://github.com/${REMOTE_OWNER}/${REMOTE_REPO}/issues/${ISSUE_NUMBER}`
      }
    })
    const clientCatalog = await captureClientCatalog(
      page,
      PAGE_REPO_ID,
      pairedEnvironmentEvidence.runtimeRepoId
    )
    requireSetup(
      !clientCatalog.pageRepoKnown,
      `client store unexpectedly contained ${PAGE_REPO_ID}`
    )
    requireSetup(
      !clientCatalog.runtimeRepoKnown,
      `client store unexpectedly contained the runtime repository ${REMOTE_OWNER}/${REMOTE_REPO}`
    )
    requireSetup(clientCatalog.runtimeEnvironmentCatalogHydrated, 'catalog hydration regressed')
    requireSetup(clientCatalog.runtimeEnvironmentCatalogSettled, 'catalog settlement regressed')
    requireSetup(
      clientCatalog.environmentIds.includes(client.environmentId),
      'paired environment disappeared before the task opened'
    )
    requireSetup(
      clientCatalog.statusEnvironmentIds.includes(client.environmentId),
      'paired environment status disappeared before the task opened'
    )
    await expect
      .poll(
        async () => {
          const calls = await readPairedRuntimeCalls(client!.app)
          const forwardedPageId = calls.find(
            (call) =>
              call.method === 'taskRecords.get' &&
              (call.params as { repoId?: string } | undefined)?.repoId === PAGE_REPO_ID
          )
          if (forwardedPageId) {
            throw new Error(`task page repo id ${PAGE_REPO_ID} was forwarded to the paired runtime`)
          }
          return calls.find(
            (call) =>
              call.method === 'taskRecords.get' &&
              (call.params as { repoId?: string } | undefined)?.repoId ===
                pairedEnvironmentEvidence.runtimeRepoId
          )
        },
        {
          timeout: 45_000,
          message:
            'the task tab never called taskRecords.get with the repo id parsed from paired repo.list'
        }
      )
      .toMatchObject({
        selector: client.environmentId,
        method: 'taskRecords.get',
        params: {
          repoId: pairedEnvironmentEvidence.runtimeRepoId,
          itemType: 'issue',
          number: ISSUE_NUMBER,
          provider: 'github'
        }
      })
    expect(
      (await readPairedRuntimeCalls(client.app)).find(
        (call) =>
          call.method === 'taskRecords.get' &&
          (call.params as { repoId?: string } | undefined)?.repoId === PAGE_REPO_ID
      )
    ).toBeUndefined()
    await expectArchivedRemoteAgentRow(panel, { runKind: new RegExp(SESSION_ID) })
    await expectUnknownUsage(panel)
    await expectSourceNotice(panel, /History also includes what 1 environment\(s\) recorded/i)
    await expectNoFalseEmptyState(page, panel)

    await host.restartServeProcess({
      betweenProcesses: async () => {
        await expectSourceNotice(panel, /did not answer|lost connection/i)
        await expectNoFalseEmptyState(page, panel)
      }
    })
  } catch (error) {
    testError = error
  }
  const cleanup = await Promise.allSettled([
    client?.dispose() ?? Promise.resolve(),
    host?.dispose() ?? Promise.resolve(),
    Promise.resolve().then(() => rmSync(fixture.root, { recursive: true, force: true }))
  ])
  const failures = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (testError !== undefined) {
    throw failures.length > 0
      ? new AggregateError([testError, ...failures], 'Issue 67 test and fixture cleanup failed')
      : testError
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Issue 67 fixture cleanup failed')
  }
})
