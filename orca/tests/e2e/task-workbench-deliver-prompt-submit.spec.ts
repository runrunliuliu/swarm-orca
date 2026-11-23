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
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

/**
 * Deliver from the sidebar's `Deliver…` entry and observe what the app does with the instruction.
 *
 * Why this exists (issue #60): every piece of the delivery path was already unit-tested — the
 * instruction text, the marker tab, the paste-after-ready helper — and the reported failure was
 * still "the agent started with the wrong prompt and the instruction stayed in the input box".
 * That gap is only closable end to end: a real Electron app, a real PTY, a real spawn of the
 * configured command, and the bytes the app actually wrote into that process.
 *
 * The agent is `tests/e2e/fixtures/golden-stub-agent` under opt-in flags (the other golden specs
 * keep their behaviour): it enables bracketed paste like a TUI, treats newlines inside a paste as
 * composer text, records every byte the app writes, and records each submitted message. The
 * configured command is a *shell wrapper plus its argument* — the shape from the issue, where the
 * agent's arguments belong to the wrapper and not to some other executable.
 *
 * What it asserts: one agent process through that wrapper, one bracketed paste, one Enter, and one
 * submitted message whose text is the delivery instruction — plus no second agent and no second
 * submission while the spec watches.
 *
 * Why it is reachable here at all: an agent pane in this environment takes ~10-13s to produce a
 * PTY (a shell pane takes ~0.5s), which is longer than the generic 8s spawn verdict the paste
 * helper used to apply. A launch now waits on its admitted spawn for a bounded 30s
 * (`LAUNCH_PTY_SPAWN_TIMEOUT_MS`) before it declares the delivery failed, so the instruction lands
 * instead of being dropped while the PTY was still coming up. Before that budget existed this spec
 * could only observe the empty composer.
 *
 * What it deliberately does not cover: the paired-host wire (a second Settings store deciding the
 * command). In this spec the client and the host are one app, so the wrapper/argument split cannot
 * happen here; that half is pinned on the wire by
 * `runtime/web-runtime-session-terminal-host-authority.test.ts` and
 * `lib/launch-agent-in-new-tab-web-runtime.test.ts`.
 */
const STUB_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'golden-stub-agent',
  'golden-stub-agent.js'
)
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-deliver-submit-'))
const reportDir = path.join(fixtureRoot, 'reports')
const wrapperLog = path.join(fixtureRoot, 'wrapper.log')
const isWindows = process.platform === 'win32'
const wrapperPath = path.join(fixtureRoot, isWindows ? 'agent-wrapper.cmd' : 'agent-wrapper.sh')
const WRAPPER_ARG = '--fake-agent'

mkdirSync(reportDir, { recursive: true })
// Why a wrapper and not the stub path directly: issue #60 was a launch whose *arguments* were
// written for a wrapper but executed by another command. The wrapper records the argument list it
// was given and then execs the stub, so "the command ran as one piece, with its arguments attached"
// is read from disk instead of inferred from the tab.
writeFileSync(
  wrapperPath,
  isWindows
    ? `@echo off\r\necho %* >> "${wrapperLog}"\r\n"${process.execPath}" "${STUB_SCRIPT}" %*\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$*" >> "${wrapperLog}"\nexec "${process.execPath}" "${STUB_SCRIPT}" "$@"\n`,
  'utf8'
)
if (!isWindows) {
  chmodSync(wrapperPath, 0o755)
}

test.use({
  launchEnv: {
    ...getGoldenStubAgentLaunchEnv(),
    ORCA_E2E_STUB_PASTE_READY: '1',
    ORCA_E2E_STUB_REPORT_DIR: reportDir
  }
})

test.afterAll(() => {
  if (process.env.ORCA_E2E_KEEP_FIXTURES === '1') {
    console.log(`[deliver-submit] fixtures kept at ${fixtureRoot}`)
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

function reportPaths(): string[] {
  return readdirSync(reportDir).filter((name) => name.endsWith('.json'))
}

async function waitForLinkedWorktree(
  page: Page,
  mainWorktreePath: string
): Promise<{ id: string; path: string }> {
  let found: { id: string; path: string } | null = null
  await expect
    .poll(
      async () => {
        found = await page.evaluate(
          (mainPath: string) => {
            const store = window.__store
            if (!store) {
              return null
            }
            const worktrees = Object.values(store.getState().worktreesByRepo).flat() as {
              id: string
              path: string
            }[]
            const linked = worktrees.find((worktree) => worktree.path !== mainPath)
            return linked ? { id: linked.id, path: linked.path } : null
          },
          mainWorktreePath
        )
        return found !== null
      },
      { timeout: 60_000, message: 'the seeded linked worktree never appeared' }
    )
    .toBe(true)
  const resolved = found as { id: string; path: string } | null
  if (!resolved) {
    throw new Error('unreachable: poll resolved true without a worktree')
  }
  return resolved
}

async function useWrapperAgent(page: Page): Promise<void> {
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
    { wrapper: wrapperPath, arg: WRAPPER_ARG }
  )
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

test('delivery starts one agent through its wrapper and never lies about the instruction', async ({
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const linked = await waitForLinkedWorktree(orcaPage, testRepoPath)
  // Why open the workspace before delivering: the delivery tab is the second terminal of this
  // workspace, so this keeps the *workspace* out of the timing budget. It does not make the agent
  // pane fast (that cost is per agent tab), it only removes the worktree-activation cold start.
  // Why poll the switch: `setActiveWorktree` is ignored until the worktree row is ready to activate,
  // and a silent no-op here would deliver into whichever workspace happened to be active.
  await expect
    .poll(
      async () => {
        await switchToWorktree(orcaPage, linked.id)
        return await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
      },
      { timeout: 60_000, message: 'the delivered workspace never became active' }
    )
    .toBe(linked.id)
  await ensureTerminalVisible(orcaPage)
  await useWrapperAgent(orcaPage)

  await launchDeliveryFromSidebar(orcaPage, linked.id)

  // The app probes the configured command with `--version` during agent detection, so the reports
  // are narrowed to the process that actually ran inside the delivered workspace.
  const deliveryReports = (): { path: string; report: StubReport }[] =>
    reportPaths()
      .map((name) => {
        const reportPath = path.join(reportDir, name)
        return {
          path: reportPath,
          report: JSON.parse(readFileSync(reportPath, 'utf8')) as StubReport
        }
      })
      // Why argv too: the app also probes the configured command (`--version`, `--help`, sandbox
      // flags) while detecting and launching agents, and those probes run in the same workspace.
      .filter(
        (entry) =>
          entry.report.cwd === linked.path && entry.report.argv.join(' ') === WRAPPER_ARG
      )

  await expect
    .poll(() => deliveryReports().length, {
      timeout: 120_000,
      message: 'the configured agent command never started in the delivered workspace'
    })
    .toBe(1)

  await expect
    .poll(() => deliveryReports()[0]?.report.submissions.length ?? 0, {
      timeout: 120_000,
      message: 'the delivery instruction was never submitted'
    })
    .toBe(1)

  const delivery = deliveryReports()[0]!
  // The command that ran is the wrapper *with its argument*, and the stub received that argument —
  // i.e. one launch command, with its arguments attached, not a wrapper lost or an argument handed
  // to another executable (issue #60).
  // Count rather than exact list equality: the wrapper may also be probed, but exactly one
  // invocation may carry the argument (a lost wrapper or a stray argument would change this).
  expect(
    readFileSync(wrapperLog, 'utf8').trim().split(/\r?\n/).filter((line) => line === WRAPPER_ARG)
  ).toHaveLength(1)
  expect(delivery.report.argv).toEqual([WRAPPER_ARG])

  // Exactly one submission, and the bytes say why: one bracketed paste, then one Enter after it.
  expect(delivery.report.submissions).toHaveLength(1)
  const instruction = delivery.report.submissions[0]!.text
  expect(instruction).toContain('Run the worktree-delivery flow for this workspace.')
  expect(instruction).toContain(`Workspace: ${linked.id}`)
  expect(instruction).toContain('Target branch:')
  expect(instruction).toContain('Stop conditions:')
  expect(instruction).toContain('swarm/skills/worktree-delivery/SKILL.md')
  expect(instruction).not.toBe(WRAPPER_ARG)
  const rawInput = readFileSync(`${delivery.path}.stdin`, 'utf8')
  expect(rawInput.split('\x1b[200~')).toHaveLength(2)
  expect(rawInput.split('\x1b[201~')).toHaveLength(2)
  // The paste carries CRs (the app normalizes newlines the way xterm's paste does), so the submit
  // is read from what follows the paste terminator: exactly one Enter, no retry.
  expect(rawInput.slice(rawInput.indexOf('\x1b[201~') + '\x1b[201~'.length)).toBe('\r')

  // The delivery tab's own record says the seeded prompt landed: asserting on "some tab is not
  // failed" would pass when the record is absent altogether.
  const deliverPromptRecord = await orcaPage.evaluate((worktreeId: string) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const deliverTab = tabs.find((tab: { quickCommandLabel?: string | null }) =>
      (tab.quickCommandLabel ?? '').startsWith('DELIVER')
    ) as { id: string } | undefined
    if (!deliverTab) {
      return null
    }
    const entry = state.nativeChatLaunchPromptByTabId[deliverTab.id]
    return entry ? { failed: entry.failed === true, text: entry.text } : null
  }, linked.id)
  expect(deliverPromptRecord).toEqual({ failed: false, text: instruction })

  // The delivery tab carries the frozen marker, so a second click reveals instead of starting
  // another agent (§7.11.6 bound 2 / §7.12 S5).
  const markerTabs = await orcaPage.evaluate((worktreeId: string) => {
    const store = window.__store
    if (!store) {
      return 0
    }
    const tabs = store.getState().unifiedTabsByWorktree[worktreeId] ?? []
    return tabs.filter((tab: { quickCommandLabel?: string | null }) =>
      (tab.quickCommandLabel ?? '').startsWith('DELIVER')
    ).length
  }, linked.id)
  expect(markerTabs).toBe(1)

  // The second click must reveal the existing session, not start another agent: the menu item is
  // the same one, now backed by the marker tab (§7.11.6 bound 2 / §7.12 S5).
  await worktreeRowSurface(orcaPage, linked.id).click({ button: 'right', force: true })
  const deliverAgain = orcaPage.getByTestId('worktree-context-menu-deliver')
  if ((await deliverAgain.count()) > 0) {
    await deliverAgain.click()
    // Why the panel may or may not open: a marker row re-projects to "open terminal"; either way the
    // launch guard refuses a second agent, which the counts below are the real test of.
    await orcaPage.keyboard.press('Escape')
  }

  // Idempotent: nothing resubmits and no second agent starts while we watch.
  await orcaPage.waitForTimeout(3000)
  expect(deliveryReports()).toHaveLength(1)
  expect(deliveryReports()[0]!.report.submissions).toHaveLength(1)
  expect(
    readFileSync(wrapperLog, 'utf8').trim().split(/\r?\n/).filter((line) => line === WRAPPER_ARG)
  ).toHaveLength(1)
})
