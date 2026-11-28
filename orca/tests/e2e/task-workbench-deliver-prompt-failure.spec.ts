import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'golden-stub-agent',
  'golden-stub-agent.js'
)
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-deliver-failure-'))
const reportDir = path.join(fixtureRoot, 'reports')
const isWindows = process.platform === 'win32'

mkdirSync(reportDir, { recursive: true })

test.afterAll(() => {
  if (process.env.ORCA_E2E_KEEP_FIXTURES === '1') {
    console.log(`[deliver-failure] fixtures kept at ${fixtureRoot}`)
    return
  }
  rmSync(fixtureRoot, { recursive: true, force: true })
})

type StubReport = {
  argv: string[]
  cwd: string
  submissions: { text: string; at: string }[]
  enteredAt: string
}

type DeliveryFixture = {
  wrapperPath: string
  wrapperArg: string
}

function createWrapper(name: string, execStub: boolean): DeliveryFixture {
  const wrapperPath = path.join(fixtureRoot, isWindows ? `${name}.cmd` : `${name}.sh`)
  const wrapperArg = `--${name}`
  writeFileSync(
    wrapperPath,
    isWindows
      ? `@echo off\r\n"${process.execPath}" "${STUB_SCRIPT}" %*\r\n`
      : execStub
        ? `#!/bin/sh\nexec "${process.execPath}" "${STUB_SCRIPT}" "$@"\n`
        : `#!/bin/sh\n"${process.execPath}" "${STUB_SCRIPT}" "$@" &\nchild_pid=$!\nwait "$child_pid"\nexit $?\n`,
    'utf8'
  )
  if (!isWindows) {
    chmodSync(wrapperPath, 0o755)
  }
  return { wrapperPath, wrapperArg }
}

function readDeliveryReports(
  fixture: DeliveryFixture,
  cwd: string
): {
  path: string
  report: StubReport
}[] {
  return readdirSync(reportDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const reportPath = path.join(reportDir, name)
      return {
        path: reportPath,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this spec owns the stub's report files; malformed JSON fails the parse itself.
        report: JSON.parse(readFileSync(reportPath, 'utf8')) as StubReport
      }
    })
    .filter(
      (entry) => entry.report.cwd === cwd && entry.report.argv.join(' ') === fixture.wrapperArg
    )
}

async function waitForLinkedWorktree(
  page: Page,
  mainWorktreePath: string
): Promise<{ id: string; path: string }> {
  let found: { id: string; path: string } | null = null
  await expect
    .poll(
      async () => {
        found = await page.evaluate((mainPath: string) => {
          const store = window.__store
          if (!store) {
            return null
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window.__store is untyped inside page.evaluate; the row shape is read only for id/path.
          const worktrees = Object.values(store.getState().worktreesByRepo).flat() as {
            id: string
            path: string
          }[]
          const linked = worktrees.find((worktree) => worktree.path !== mainPath)
          return linked ? { id: linked.id, path: linked.path } : null
        }, mainWorktreePath)
        return found !== null
      },
      { timeout: 60_000, message: 'the seeded linked worktree never appeared' }
    )
    .toBe(true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the poll above only resolves true after page.evaluate returned this exact shape.
  const resolved = found as { id: string; path: string } | null
  if (!resolved) {
    throw new Error('unreachable: poll resolved true without a worktree')
  }
  return resolved
}

async function prepareDeliveryWorkspace(
  page: Page,
  mainWorktreePath: string,
  fixture: DeliveryFixture
): Promise<{ id: string; path: string }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  const linked = await waitForLinkedWorktree(page, mainWorktreePath)
  await expect
    .poll(
      async () => {
        await switchToWorktree(page, linked.id)
        return await page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
      },
      { timeout: 60_000, message: 'the delivered workspace never became active' }
    )
    .toBe(linked.id)
  await ensureTerminalVisible(page)
  await page.evaluate(
    async ({ wrapper, arg }: { wrapper: string; arg: string }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({
        defaultTuiAgent: 'claude',
        agentCmdOverrides: { claude: wrapper },
        agentDefaultArgs: { claude: arg }
      })
    },
    { wrapper: fixture.wrapperPath, arg: fixture.wrapperArg }
  )
  return linked
}

async function launchDeliveryFromSidebar(page: Page, worktreeId: string): Promise<void> {
  await worktreeRowSurface(page, worktreeId).click({ button: 'right', force: true })
  const deliver = page.getByTestId('worktree-context-menu-deliver')
  await expect(deliver).toBeVisible({ timeout: 15_000 })
  await deliver.click()
  await expect(page.getByTestId('task-workbench-deliver-confirm')).toBeVisible({ timeout: 15_000 })
  const targetBranch = page.getByTestId('task-workbench-deliver-target-branch')
  if ((await targetBranch.inputValue()).trim() === '') {
    await targetBranch.fill('master')
  }
  await page.getByTestId('task-workbench-deliver-submit').click()
}

function deliveryFailureToast(page: Page): Locator {
  return page.locator('[data-sonner-toast]').filter({
    has: page.getByRole('button', { name: 'Copy prompt' })
  })
}

async function expectManualRecoveryWorks(page: Page, toast: Locator): Promise<void> {
  await expect(toast).toContainText(/paste.*(?:press|hit).*Enter/i)
  const copyPrompt = toast.getByRole('button', { name: 'Copy prompt' })
  await expect(copyPrompt).toBeVisible()
  await copyPrompt.click()
  const clipboardText = await page.evaluate(() => window.api.ui.readClipboardText())
  expect(clipboardText).toContain('Run the worktree-delivery flow for this workspace.')
  expect(clipboardText).toContain('Target branch:')
}

async function delayDeliveryPtySpawn(
  electronApp: ElectronApplication,
  wrapperPath: string
): Promise<void> {
  await electronApp.evaluate(
    async ({ ipcMain }, args: { wrapperPath: string }) => {
      type SpawnArgs = { command?: string; launchAgent?: string }
      type InvokeHandler = (event: unknown, args: SpawnArgs) => unknown
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron's invocation registry is test instrumentation already used by neighboring E2E probes.
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
        ._invokeHandlers
      const original = handlers?.get('pty:spawn')
      if (!handlers || !original) {
        throw new Error('pty:spawn IPC handler is unavailable')
      }
      handlers.set('pty:spawn', async (event, spawnArgs) => {
        const matched =
          spawnArgs.launchAgent === 'claude' && spawnArgs.command?.includes(args.wrapperPath) === true
        if (matched) {
          await new Promise((resolve) => setTimeout(resolve, 31_500))
        }
        return original(event, spawnArgs)
      })
    },
    { wrapperPath }
  )
}

test.describe('delivery prompt failure reasons', () => {
  test.use({
    launchEnv: {
      ...getGoldenStubAgentLaunchEnv(),
      ORCA_E2E_STUB_PASTE_READY: '1',
      ORCA_E2E_STUB_REPORT_DIR: reportDir
    }
  })

  test('names a PTY spawn timeout and keeps a usable manual recovery', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    test.setTimeout(180_000)
    const fixture = createWrapper('no-pty', true)
    const linked = await prepareDeliveryWorkspace(orcaPage, testRepoPath, fixture)
    await delayDeliveryPtySpawn(electronApp, fixture.wrapperPath)

    await launchDeliveryFromSidebar(orcaPage, linked.id)

    const toast = deliveryFailureToast(orcaPage)
    await expect(toast).toBeVisible({ timeout: 45_000 })
    await expect(toast).toContainText(/No terminal became available/i)
    await expectManualRecoveryWorks(orcaPage, toast)

    await expect
      .poll(() => readDeliveryReports(fixture, linked.path).length, {
        timeout: 30_000,
        message: 'the delayed agent process never started after the delivery settled'
      })
      .toBe(1)
    const reports = readDeliveryReports(fixture, linked.path)
    expect(reports[0]!.report.submissions).toHaveLength(0)
    expect(readFileSync(`${reports[0]!.path}.stdin`, 'utf8')).toBe('')
    await orcaPage.waitForTimeout(1500)
    expect(readDeliveryReports(fixture, linked.path)).toHaveLength(1)
  })

  test.describe('without the bracketed-paste readiness handshake', () => {
    test.use({
      launchEnv: {
        ...getGoldenStubAgentLaunchEnv(),
        ORCA_E2E_STUB_PROCESS_TITLE: 'sh',
        ORCA_E2E_STUB_WINDOW_TITLE: '\u280b Claude is thinking',
        ORCA_E2E_STUB_REPORT_DIR: reportDir
      }
    })

    test('names readiness timeout plus process mismatch without writing a byte', async ({
      orcaPage,
      testRepoPath
    }) => {
      test.setTimeout(120_000)
      const fixture = createWrapper('process-mismatch', false)
      const linked = await prepareDeliveryWorkspace(orcaPage, testRepoPath, fixture)

      await launchDeliveryFromSidebar(orcaPage, linked.id)

      const toast = deliveryFailureToast(orcaPage)
      await expect(toast).toBeVisible({ timeout: 45_000 })
      await expect(toast).toContainText(/did not become ready: expected .* but found/i)
      await expectManualRecoveryWorks(orcaPage, toast)

      await expect
        .poll(() => readDeliveryReports(fixture, linked.path).length, {
          timeout: 30_000,
          message: 'the mismatched wrapper never started in the delivered workspace'
        })
        .toBe(1)
      const reports = readDeliveryReports(fixture, linked.path)
      expect(reports[0]!.report.submissions).toHaveLength(0)
      expect(readFileSync(`${reports[0]!.path}.stdin`, 'utf8')).toBe('')
      await orcaPage.waitForTimeout(1500)
      expect(readDeliveryReports(fixture, linked.path)).toHaveLength(1)
    })
  })

  test.describe('with a matching fallback process', () => {
    test.use({
      launchEnv: {
        ...getGoldenStubAgentLaunchEnv(),
        ORCA_E2E_STUB_PROCESS_TITLE: 'claude',
        ORCA_E2E_STUB_WINDOW_TITLE: '\u280b Claude is thinking',
        ORCA_E2E_STUB_REPORT_DIR: reportDir
      }
    })

    test('keeps blind-write delivery unconfirmed and separate from failure reasons', async ({
      orcaPage,
      testRepoPath
    }) => {
      test.setTimeout(120_000)
      const fixture = createWrapper('process-match', true)
      const linked = await prepareDeliveryWorkspace(orcaPage, testRepoPath, fixture)

      await launchDeliveryFromSidebar(orcaPage, linked.id)

      const toast = deliveryFailureToast(orcaPage)
      await expect(toast).toBeVisible({ timeout: 45_000 })
      await expect(toast).toContainText(/wrote the context.*did not observe a new turn/i)
      await expect(toast).not.toContainText(
        /No terminal became available|did not become ready: expected|did not report whether/i
      )

      await expect
        .poll(() => readDeliveryReports(fixture, linked.path)[0]?.report.submissions.length ?? 0, {
          timeout: 30_000,
          message: 'the fallback-matched process never received the blind-write submission'
        })
        .toBe(1)
      const reports = readDeliveryReports(fixture, linked.path)
      expect(reports).toHaveLength(1)
      expect(reports[0]!.report.submissions).toHaveLength(1)
      const rawInput = readFileSync(`${reports[0]!.path}.stdin`, 'utf8')
      expect(rawInput.split('\x1b[200~')).toHaveLength(2)
      expect(rawInput.split('\x1b[201~')).toHaveLength(2)
      expect(rawInput.slice(rawInput.indexOf('\x1b[201~') + '\x1b[201~'.length)).toBe('\r')
    })
  })
})
