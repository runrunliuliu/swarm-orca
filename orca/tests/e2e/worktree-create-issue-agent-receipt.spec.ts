import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test as base } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { startRecording } from './helpers/sim-remote/recorder'
import {
  configureGoldenStubAgent,
  GOLDEN_STUB_READY_MARKER,
  getGoldenStubAgentLaunchEnv
} from './helpers/golden-stub-agent'

/**
 * `orca worktree create --issue` without `--agent` used to be indistinguishable from a create
 * that started an agent: the workspace, the issue link and the bare shell all looked normal, and
 * the JSON receipt carried no field a caller could branch on. This spec drives the compiled CLI
 * from a real Orca terminal against the real runtime, then proves the half outcome in both
 * directions:
 *
 * - no `--agent`: `agentStarted: false` plus a warning, and the workspace's first terminal is an
 *   interactive shell that answers a command;
 * - with `--agent`: `agentStarted: true`, `createdWithAgent` names the requested agent, that
 *   workspace owns a "Golden Stub Agent" tab, and `terminal.read` shows the stub's ready marker.
 *
 * Negative claim: the no-agent workspace never runs an agent, so its pane must answer a shell
 * command. That fact is invisible in the receipt and in a sidebar that lists both workspaces.
 */

const test = base.extend({
  launchEnv: [getGoldenStubAgentLaunchEnv(), { option: true }]
})

const CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')
const EVIDENCE_DIR =
  process.env.ORCA_E2E_EVIDENCE_DIR ?? path.join(process.cwd(), 'test-results', 'issue-77-e2e')

type CliReceipt = {
  ok: boolean
  result: {
    agentStarted?: boolean
    warning?: string
    agentTerminalHandle?: string
    startupTerminal?: { handle?: string }
    worktree: { id: string; linkedIssue?: number | null; createdWithAgent?: string }
  }
}

type CliEnvelope<TResult> = { ok: boolean; result?: TResult }

function evidencePath(name: string): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: evidencePath(name) })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cliPrefix(userDataDir: string): string {
  return `ORCA_USER_DATA_PATH=${shellQuote(userDataDir)} ORCA_DEV_CLI_INVOCATION=1 node ${shellQuote(CLI_ENTRY)}`
}

/** Runs one compiled-CLI read/observation command outside the app terminal. */
function runCli<TResult>(userDataDir: string, args: string[]): CliEnvelope<TResult> {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })
  expect(result.error).toBeUndefined()
  return JSON.parse(result.stdout) as CliEnvelope<TResult>
}

/**
 * One visible CLI invocation in the app's own terminal: the receipt is redirected to a file for
 * deterministic assertions, then printed and grepped so the recording shows what was decided.
 */
function createCommand(userDataDir: string, args: string[], receiptPath: string): string {
  return [
    cliPrefix(userDataDir),
    ...args.map(shellQuote),
    `> ${shellQuote(receiptPath)} 2>&1`,
    '; echo CLI_EXIT:$?',
    `; cat ${shellQuote(receiptPath)}`,
    `; grep -E '"agentStarted"|"warning"|"createdWithAgent"' ${shellQuote(receiptPath)}`,
    '; echo RECEIPT_END'
  ].join(' ')
}

function tryReadReceipt(receiptPath: string): CliReceipt | null {
  try {
    const text = readFileSync(receiptPath, 'utf8').trim()
    return text ? (JSON.parse(text) as CliReceipt) : null
  } catch {
    return null
  }
}

/**
 * Waits on the file, never on the echoed command: the command line itself contains the marker
 * names, so a terminal match would return before the CLI ran.
 */
async function waitForCreateReceipt(receiptPath: string, timeoutMs = 120_000): Promise<CliReceipt> {
  await expect.poll(() => tryReadReceipt(receiptPath), { timeout: timeoutMs }).not.toBeNull()
  const receipt = tryReadReceipt(receiptPath)
  if (!receipt) {
    throw new Error(`CLI receipt never became parseable: ${receiptPath}`)
  }
  return receipt
}

async function runCreate(
  page: Page,
  ptyId: string,
  userDataDir: string,
  args: string[],
  receiptPath: string,
  timeoutMs = 120_000
): Promise<CliReceipt> {
  await execInTerminal(page, ptyId, createCommand(userDataDir, args, receiptPath))
  return waitForCreateReceipt(receiptPath, timeoutMs)
}

async function openWorkspace(page: Page, worktreeId: string): Promise<void> {
  const row = page.locator(`[role="option"][data-worktree-id="${worktreeId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
  await waitForActiveTerminalManager(page)
}

/** The agent's PTY is runtime truth; its tab can be silent in the UI, so read the buffer. */
function agentTail(userDataDir: string, handle: string): string {
  const envelope = runCli<{ terminal: { tail: string[] } }>(userDataDir, [
    'terminal',
    'read',
    '--terminal',
    handle,
    '--limit',
    '1000',
    '--json'
  ])
  return envelope.result?.terminal.tail.join('\n') ?? ''
}

const SKILL_RPC = path.resolve(
  process.cwd(),
  '..',
  'swarm',
  'skills',
  'auto-evolve',
  'scripts',
  'rpc.py'
)

type SkillReceipt = {
  ok: boolean
  result?: {
    agentTerminalHandle?: string
    worktree: {
      id: string
      createdWithAgent?: string
      linkedIssue?: number | null
      linkedWorkItem?: unknown
      linkedTaskSourceContext?: unknown
    }
  }
  error?: { code?: string; message?: string }
}

/** The skill's only execution entry, run exactly as the operator would. */
function autoEvolveCommand(
  metadataPath: string,
  runtimeId: string,
  paramsPath: string,
  stateDir: string,
  outputPath: string
): string {
  return [
    'echo AUTO_EVOLVE_SKILL_EXECUTE',
    `; python3 ${shellQuote(SKILL_RPC)}`,
    '--metadata',
    shellQuote(metadataPath),
    '--runtime-id',
    shellQuote(runtimeId),
    '--method',
    'worktree.create',
    '--params-file',
    shellQuote(paramsPath),
    '--execute',
    '--state-dir',
    shellQuote(stateDir),
    '--timeout',
    '180',
    `> ${shellQuote(outputPath)} 2>&1`,
    '; echo SKILL_EXIT:$?',
    `; cat ${shellQuote(outputPath)}`,
    `; grep -E '"ok"|"agentTerminalHandle"|"createdWithAgent"' ${shellQuote(outputPath)}`,
    '; echo AUTO_EVOLVE_END'
  ].join(' ')
}

async function waitForSkillReceipt(outputPath: string, timeoutMs = 120_000): Promise<SkillReceipt> {
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(readFileSync(outputPath, 'utf8')) as SkillReceipt
        } catch {
          return null
        }
      },
      { timeout: timeoutMs }
    )
    .not.toBeNull()
  return JSON.parse(readFileSync(outputPath, 'utf8')) as SkillReceipt
}

async function resizeWindow(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1500, height: 950 })
  })
}

test('issue create distinguishes a bare shell from a started agent', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await resizeWindow(electronApp)
  await waitForActiveTerminalManager(orcaPage)
  const originalWorktreeId = await waitForActiveWorktree(orcaPage)
  const repoId = originalWorktreeId.split('::')[0]
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 20_000)
  await capture(orcaPage, '01-scenario-app-ready.png')

  const createdWorktreeIds: string[] = []
  // Why a run tag: the evidence directory is reused between local runs, and a stale receipt
  // would satisfy the file poll before this run's CLI ever wrote one.
  const runTag = String(Date.now())
  try {
    // ── No --agent: workspace plus issue link, no agent, and the receipt says so ─────────────
    const noAgentName = `issue-77-no-agent-${runTag}`
    const noAgentReceiptPath = evidencePath(`no-agent-receipt-${runTag}.json`)
    const noAgent = await runCreate(
      orcaPage,
      ptyId,
      userDataDir,
      [
        'worktree',
        'create',
        '--repo',
        `id:${repoId}`,
        '--name',
        noAgentName,
        '--issue',
        '77',
        '--no-parent',
        '--json'
      ],
      noAgentReceiptPath
    )
    createdWorktreeIds.push(noAgent.result.worktree.id)
    expect(noAgent.ok).toBe(true)
    expect(noAgent.result.agentStarted).toBe(false)
    expect(noAgent.result.warning).toContain('--agent')
    expect(noAgent.result.agentTerminalHandle).toBeUndefined()
    expect(noAgent.result.worktree.linkedIssue).toBe(77)
    expect(noAgent.result.worktree.createdWithAgent).toBeUndefined()
    await waitForTerminalOutput(orcaPage, '"agentStarted": false', 15_000)
    await capture(orcaPage, '02-scenario-no-agent-receipt.png')

    // ── The no-agent workspace is a shell, not a silent agent ───────────────────────────────
    await openWorkspace(orcaPage, noAgent.result.worktree.id)
    const noAgentPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, noAgentPtyId, 20_000)
    await execInTerminal(orcaPage, noAgentPtyId, 'echo NO_AGENT_SHELL:$PWD')
    await waitForTerminalOutput(orcaPage, 'NO_AGENT_SHELL:', 20_000)
    await capture(orcaPage, '03-scenario-no-agent-workspace-shell.png')

    // ── With --agent: the same request starts the requested agent ───────────────────────────
    await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
    const agentName = `issue-77-agent-${runTag}`
    const agentReceiptPath = evidencePath(`agent-receipt-${runTag}.json`)
    const agent = await runCreate(
      orcaPage,
      noAgentPtyId,
      userDataDir,
      [
        'worktree',
        'create',
        '--repo',
        `id:${repoId}`,
        '--name',
        agentName,
        '--issue',
        '77',
        '--agent',
        'codex',
        '--prompt',
        'Issue 77 E2E: report ready.',
        '--no-parent',
        '--json'
      ],
      agentReceiptPath
    )
    createdWorktreeIds.push(agent.result.worktree.id)
    expect(agent.ok).toBe(true)
    expect(agent.result.agentStarted).toBe(true)
    expect(agent.result.worktree.createdWithAgent).toBe('codex')
    const agentHandle = agent.result.agentTerminalHandle ?? agent.result.startupTerminal?.handle
    expect(agentHandle).toBeTruthy()
    // A background create leaves the agent terminal off-tab, so the runtime buffer is the proof
    // that the process actually ran; the UI assertion below proves the workspace owns its tab.
    await expect
      .poll(() => agentTail(userDataDir, String(agentHandle)), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)

    await openWorkspace(orcaPage, agent.result.worktree.id)
    await expect(orcaPage.getByText('Golden Stub Agent').first()).toBeVisible({
      timeout: 30_000
    })
    await capture(orcaPage, '04-scenario-agent-workspace-ready.png')

    // ── Back in the shell: show the agent receipt and the agent's own PTY tail ─────────────
    await openWorkspace(orcaPage, noAgent.result.worktree.id)
    const receiptPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, receiptPtyId, 20_000)
    await execInTerminal(
      orcaPage,
      receiptPtyId,
      [
        `grep -E '"agentStarted"|"warning"|"createdWithAgent"' ${shellQuote(agentReceiptPath)}`,
        `; ${cliPrefix(userDataDir)} terminal read --terminal ${shellQuote(String(agentHandle))} --limit 40 --json`
      ].join(' ')
    )
    await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
    await capture(orcaPage, '05-scenario-agent-pty-tail.png')
  } finally {
    await orcaPage
      .locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
      .click()
      .catch(() => undefined)
    for (const worktreeId of createdWorktreeIds) {
      await orcaPage
        .evaluate(async (id) => {
          await window.__store?.getState().removeWorktree(id, true)
        }, worktreeId)
        .catch(() => undefined)
    }
  }
})

test('auto_evolve execute creates the workspace and starts the agent', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await resizeWindow(electronApp)
  await waitForActiveTerminalManager(orcaPage)
  const originalWorktreeId = await waitForActiveWorktree(orcaPage)
  const repoId = originalWorktreeId.split('::')[0]
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const metadataPath = path.join(userDataDir, 'orca-runtime.json')
  const { runtimeId } = JSON.parse(readFileSync(metadataPath, 'utf8')) as { runtimeId: string }
  const baseSha = execFileSync('git', ['-C', seededRepoPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 20_000)
  await capture(orcaPage, '06-scenario-autoevolve-app-ready.png')
  // CDP screencast: the window is unmapped headless, so an X11 grab is black, while Playwright's
  // electron.recordVideo never reached domcontentloaded. Frames arrive only when the page paints.
  const recording = process.env.ORCA_E2E_RECORDING_DIR
    ? await startRecording(orcaPage, { outDir: process.env.ORCA_E2E_RECORDING_DIR })
    : null

  const runTag = String(Date.now())
  const paramsPath = evidencePath(`auto-evolve-create-params-${runTag}.json`)
  const outputPath = evidencePath(`auto-evolve-receipt-${runTag}.json`)
  const stateDir = evidencePath(`auto-evolve-intents-${runTag}`)
  const createdWorktreeIds: string[] = []
  try {
    writeFileSync(
      paramsPath,
      `${JSON.stringify(
        {
          repo: `id:${repoId}`,
          name: `issue-77-autoevolve-${runTag}`,
          baseBranch: baseSha,
          linkedIssue: 77,
          linkedWorkItem: {
            provider: 'github',
            type: 'issue',
            number: 77,
            title: 'Issue 77 E2E',
            url: 'https://github.com/example/project/issues/77',
            repoId
          },
          linkedTaskSourceContext: {
            kind: 'task-source',
            provider: 'github',
            projectId: 'project-e2e',
            hostId: 'local',
            repoId,
            providerIdentity: {
              provider: 'github',
              host: 'github.com',
              owner: 'example',
              repo: 'project'
            }
          },
          noParent: true,
          setupDecision: 'skip',
          activate: false,
          startupAgent: 'codex',
          startupPrompt: 'Issue 77 E2E: auto-evolve created this workspace; report ready.',
          clientMutationId: `issue-77-autoevolve-${runTag}`
        },
        null,
        2
      )}\n`
    )
    await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
    await execInTerminal(
      orcaPage,
      ptyId,
      autoEvolveCommand(metadataPath, runtimeId, paramsPath, stateDir, outputPath)
    )
    // The echoed command contains AUTO_EVOLVE_END, so waiting on the terminal would return
    // before the script ran; wait for the redirected receipt to become complete JSON instead.
    const receipt = await waitForSkillReceipt(outputPath)
    if (!receipt.result) {
      throw new Error(`auto-evolve returned no result: ${JSON.stringify(receipt.error)}`)
    }
    createdWorktreeIds.push(receipt.result.worktree.id)
    // rpc.py exits non-zero on agent_not_started; reaching here means the receipt assertion passed.
    expect(receipt.ok).toBe(true)
    expect(receipt.result.worktree.createdWithAgent).toBe('codex')
    expect(receipt.result.worktree.linkedIssue).toBe(77)
    expect(receipt.result.worktree.linkedWorkItem).toBeTruthy()
    expect(receipt.result.worktree.linkedTaskSourceContext).toBeTruthy()
    const agentHandle = receipt.result.agentTerminalHandle
    expect(agentHandle).toBeTruthy()
    await waitForTerminalOutput(orcaPage, '"ok": true', 15_000)
    await capture(orcaPage, '07-scenario-autoevolve-receipt.png')
    // Evidence runs only: give each final state enough screen time to be readable in a recording.
    const holdMs = Number(process.env.ORCA_E2E_HOLD_MS ?? 0)
    const holdStepMs = holdMs > 0 ? Math.floor(holdMs / 3) : 0
    if (holdStepMs > 0) {
      await orcaPage.waitForTimeout(holdStepMs)
    }

    await expect
      .poll(() => agentTail(userDataDir, String(agentHandle)), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)
    await openWorkspace(orcaPage, receipt.result.worktree.id)
    await expect(orcaPage.getByText('Golden Stub Agent').first()).toBeVisible({
      timeout: 30_000
    })
    await capture(orcaPage, '08-scenario-autoevolve-agent-workspace.png')
    if (holdStepMs > 0) {
      await orcaPage.waitForTimeout(holdStepMs)
    }

    // The agent's tab can be silent (silently adopted background PTY has no scrollback replay),
    // so print its live PTY tail from a shell: the ready marker is the process-level proof.
    await openWorkspace(orcaPage, originalWorktreeId)
    const readPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, readPtyId, 20_000)
    await execInTerminal(
      orcaPage,
      readPtyId,
      `${cliPrefix(userDataDir)} terminal read --terminal ${shellQuote(String(agentHandle))} --limit 40 --json`
    )
    await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
    await capture(orcaPage, '09-scenario-autoevolve-agent-pty-tail.png')
    if (holdStepMs > 0) {
      await orcaPage.waitForTimeout(holdStepMs)
    }
  } finally {
    const artifact = await recording?.stop()
    if (artifact) {
      writeFileSync(
        evidencePath('recording-artifact.json'),
        `${JSON.stringify(artifact, null, 2)}\n`
      )
    }
    await orcaPage
      .locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
      .click()
      .catch(() => undefined)
    for (const worktreeId of createdWorktreeIds) {
      await orcaPage
        .evaluate(async (id) => {
          await window.__store?.getState().removeWorktree(id, true)
        }, worktreeId)
        .catch(() => undefined)
    }
  }
})
