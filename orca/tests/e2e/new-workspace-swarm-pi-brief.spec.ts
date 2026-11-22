import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * Simulated "new workspace → Swarm Coordinator → pi" launch.
 *
 * What this covers that the unit tests cannot: the renderer's composer decision
 * has to survive the real IPC/worktree/spawn path before the Coordinator brief
 * reaches the agent, and #54 was exactly a delivery that looked correct on both
 * sides separately. The agent itself is `tests/e2e/fixtures/pi-prefill-stub`,
 * which records the env/argv it was exec'd with and every byte the app writes to
 * its input — so "the brief arrived as an env seed with the submit flag, on the
 * agent that actually started in the new workspace" is observed at the exec
 * boundary instead of asserted against a mock.
 *
 * What it deliberately does not cover: that pi turns `ORCA_PI_PREFILL_SUBMIT=1`
 * into a started turn. That is pi's own contract, proved with the real binary and
 * the generated `orca-prefill.ts` extension in a PTY (see the #54 commit). Nor can
 * this stub prove "the app does not *also* paste": the paste-after-ready gate
 * requires the foreground process to be recognized as `pi`, and the stub runs as
 * `node`, so a paste attempt would be blocked before it reaches the fixture. That
 * half is pinned by the unit tests (quick-startup-plan: `auto-submit` with no
 * `draftPrompt`; worktree-creation-completion: no delivery for auto-submit).
 */
const STUB_DIR = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'pi-prefill-stub')
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-pi-prefill-'))
const reportDir = path.join(fixtureRoot, 'reports')
mkdirSync(reportDir, { recursive: true })

const SKILL_PATH = 'swarm/skills/swarm-orchestration/SKILL.md'
// Why a unique note: it lets the assertion check that what the user typed is what
// the Coordinator receives, not merely that some prompt was delivered.
const NOTE = `SIMULATED_NOTE_${process.pid}_${Date.now()}`
const MAX_WORKERS = '3'

function getStubLaunchEnv(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return {
    [pathKey]: [STUB_DIR, process.env[pathKey] ?? ''].filter(Boolean).join(path.delimiter),
    ORCA_E2E_PI_STUB_REPORT_DIR: reportDir
  }
}

test.use({ launchEnv: getStubLaunchEnv() })

test.afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

type StubReport = {
  argv: string[]
  cwd: string
  prefill: string | null
  submitFlag: string | null
  paneKey: string | null
  startedAt: string
}

function listReports(): string[] {
  return readdirSync(reportDir).filter((name) => name.endsWith('.json'))
}

async function waitForNewReport(previous: string[]): Promise<string> {
  let found: string | null = null
  await expect
    .poll(
      () => {
        const created = listReports().filter((name) => !previous.includes(name))
        found = created.length > 0 ? path.join(reportDir, created[0]!) : null
        return Boolean(found)
      },
      { timeout: 180_000, message: 'the created workspace never started the pi stub' }
    )
    .toBe(true)
  if (!found) {
    throw new Error('unreachable: poll resolved true without a report path')
  }
  return found
}

function readReport(reportPath: string): StubReport {
  return JSON.parse(readFileSync(reportPath, 'utf8')) as StubReport
}

async function createSwarmWorkspace(page: Page, name: string): Promise<void> {
  await openSidebarWorkspaceComposer(page)
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: 'Advanced' }).click()
  await dialog.getByPlaceholder('Write a note').fill(NOTE)
  await expect(dialog.locator('[data-agent-combobox-root="true"]')).toContainText('Pi')
  await dialog.getByRole('button', { name: /Swarm Coordinator/ }).click()
  await dialog.getByLabel('max_workers').fill(MAX_WORKERS)
  await expect(dialog.locator('[data-new-workspace-launch-mode="swarm"]')).toBeVisible()
  await dialog.getByRole('button', { name: /^Create/ }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
}

test('Swarm Coordinator start hands the brief to pi as a submitted prefill, not a paste', async ({
  orcaPage
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  // The stub is a PATH `pi`, so selecting it is what a real user does after
  // pointing the composer at pi; keep the default agent out of the assertion.
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ defaultTuiAgent: 'pi' })
  })

  const workspaceName = `swarm-pi-${Date.now()}`
  let createdWorktreeId: string | null = null
  try {
    const previousReports = listReports()
    await createSwarmWorkspace(orcaPage, workspaceName)
    await expect(
      orcaPage.locator('[role="option"]').filter({ hasText: workspaceName })
    ).toBeVisible({ timeout: 60_000 })
    createdWorktreeId = await waitForActiveWorktree(orcaPage)

    const reportPath = await waitForNewReport(previousReports)
    const report = readReport(reportPath)

    // The stub ran inside the workspace the app just created, not the parent checkout.
    expect(path.basename(report.cwd)).toBe(workspaceName)
    // The Coordinator brief travels as the agent's own prefill env, with the flag
    // that tells the orca-prefill extension to start a turn from it.
    expect(report.prefill).toContain(SKILL_PATH)
    expect(report.prefill).toContain(`max_workers=${MAX_WORKERS}`)
    expect(report.prefill).toContain(NOTE)
    expect(report.submitFlag).toBe('1')
    // The orca-prefill extension early-returns without a pane key, so delivering the
    // seed without one would still have produced no turn in a real pi.
    expect(report.paneKey).toBeTruthy()
    // …and not on the launch command: a multi-line brief with no argv slot is
    // exactly what made the old paste-after-ready route the only delivery.
    expect(report.argv.join('\u0000')).not.toContain(SKILL_PATH)
  } finally {
    if (createdWorktreeId) {
      // Why swallowed: the global teardown drops the whole seeded repo, so a failed
      // cleanup must not replace the real assertion failure with its own stack.
      await orcaPage
        .evaluate(async (id) => {
          await window.__store?.getState().removeWorktree({ id, executionHostId: null }, true)
        }, createdWorktreeId)
        .catch((error: unknown) => {
          console.warn('worktree cleanup skipped', error)
        })
    }
  }
})
