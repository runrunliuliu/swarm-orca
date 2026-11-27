import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../src/cli/runtime-client'
import type { RuntimeTerminalRead } from '../../../src/shared/runtime-types'
import { execInTerminal, waitForActiveTerminalManager } from './terminal'
import { shellQuote } from './shell-quote'

/** The compiled CLI the E2E build produces; every command below targets it explicitly. */
export const CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')

export type CliEnvelope<TResult> = { ok: boolean; result?: TResult; error?: unknown }

/** The subset of a `worktree.create` receipt these specs judge. */
export type CliReceipt = {
  ok: boolean
  result: {
    agentStarted?: boolean
    warning?: string
    agentTerminalHandle?: string
    startupTerminal?: { handle?: string; tabId?: string }
    worktree: {
      id: string
      linkedIssue?: number | null
      createdWithAgent?: string
      linkedWorkItem?: unknown
      linkedTaskSourceContext?: unknown
    }
  }
  error?: { code?: string; message?: string }
}

/** Environment prefix that points the CLI at the launched app's isolated profile. */
export function cliPrefix(userDataDir: string): string {
  return `ORCA_USER_DATA_PATH=${shellQuote(userDataDir)} ORCA_DEV_CLI_INVOCATION=1 node ${shellQuote(CLI_ENTRY)}`
}

/**
 * Runs one compiled-CLI command outside the app terminal. A non-zero exit or non-JSON stdout is a
 * failure here: swallowing either turns a broken CLI into a confusing receipt parse error later.
 */
export function runCli<TResult>(
  userDataDir: string,
  args: string[],
  timeoutMs = 60_000
): CliEnvelope<TResult> {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: timeoutMs
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `cli ${args.join(' ')} exited ${String(result.status)}: ${result.stderr || result.stdout}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`cli ${args[0] ?? ''} printed non-JSON: ${result.stdout.slice(0, 400)}`)
  }
  const ok = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'ok') : null
  if (typeof ok !== 'boolean') {
    throw new Error(`cli ${args[0] ?? ''} printed no envelope: ${result.stdout.slice(0, 400)}`)
  }
  const payload = Reflect.get(parsed, 'result')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the envelope (ok/error) is checked above; each caller owns the result type it asked the command for.
  return { ok, result: payload as TResult | undefined, error: Reflect.get(parsed, 'error') }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    const text = readFileSync(file, 'utf8').trim()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers pass the receipt type for the command whose file this is; a malformed file still throws and reads as null.
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

/**
 * Waits on the redirected file, never on the echoed command: the command line itself contains its
 * marker names, so a terminal match would return before the command ran.
 */
export async function waitForJsonFile<T>(file: string, timeoutMs = 120_000): Promise<T> {
  await expect.poll(() => readJsonFile<T>(file), { timeout: timeoutMs }).not.toBeNull()
  const value = readJsonFile<T>(file)
  if (!value) {
    throw new Error(`JSON file never became parseable: ${file}`)
  }
  return value
}

/**
 * One visible command in the app's own terminal: output is redirected to a file for deterministic
 * assertions, then printed and grepped so a recording shows what was decided.
 */
export function visibleCommand(args: {
  command: string
  outputPath: string
  grepPattern: string
  doneMarker: string
}): string {
  return [
    args.command,
    `> ${shellQuote(args.outputPath)} 2>&1`,
    '; echo CLI_EXIT:$?',
    `; cat ${shellQuote(args.outputPath)}`,
    `; grep -E ${shellQuote(args.grepPattern)} ${shellQuote(args.outputPath)}`,
    `; echo ${args.doneMarker}`
  ].join(' ')
}

export function cliCreateCommand(userDataDir: string, args: string[], receiptPath: string): string {
  return visibleCommand({
    command: [cliPrefix(userDataDir), ...args.map(shellQuote)].join(' '),
    outputPath: receiptPath,
    grepPattern: '"agentStarted"|"warning"|"createdWithAgent"',
    doneMarker: 'RECEIPT_END'
  })
}

export async function runCreateInTerminal(
  page: Page,
  ptyId: string,
  userDataDir: string,
  args: string[],
  receiptPath: string
): Promise<CliReceipt> {
  await execInTerminal(page, ptyId, cliCreateCommand(userDataDir, args, receiptPath))
  return waitForJsonFile<CliReceipt>(receiptPath)
}

/**
 * The agent's PTY is runtime truth. A silently adopted background terminal has no tab scrollback
 * to read from the renderer, so this asks the runtime directly instead of scraping the DOM.
 */
export async function agentTail(userDataDir: string, handle: string): Promise<string> {
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: handle,
    limit: 1000
  })
  return read.result.terminal.tail.join('\n')
}

export function worktreeTab(page: Page, tabId: string) {
  return page.locator(`[data-tab-id="${tabId}"]`)
}

export async function openWorkspace(page: Page, worktreeId: string): Promise<void> {
  const row = page.locator(`[role="option"][data-worktree-id="${worktreeId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
  await waitForActiveTerminalManager(page)
}
