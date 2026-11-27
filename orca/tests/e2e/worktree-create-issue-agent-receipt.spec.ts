import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
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
