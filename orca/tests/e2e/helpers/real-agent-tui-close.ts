/**
 * Real-agent-side ownership: the paired client's tab (open + the user's close), and the teardown that
 * reclaims a case's client, its agent and its apex in ownership order.
 *
 * Why a module of its own: this is the only part of the issue #68 suite that owns three different
 * processes at once, and the ordering rule it encodes — the agent's **exit is confirmed** before the
 * directory it was configured from is removed — is worth reading in one place.
 */

import { rmSync } from 'node:fs'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'
import type { OrcadApexHost } from './orcad-apex-host'
import { stopRealAgentProcess, type AgentProcessControl } from './real-agent-process'
import { capturePanelScreenshot } from './task-workbench-live-run-evidence'

/**
 * Teardown for a real-agent case: in ownership order, and with the one rule that matters when a case
 * failed — the agent's **exit is confirmed** before the directory it was configured from is removed.
 * Every step is individually tolerated so one failure cannot skip the next; what could not be
 * reclaimed comes back as a list, and a retained fixture root is reported as a failure, not as a
 * detail.
 */
export async function cleanupRealAgentCase(input: {
  client: PairedElectronClient | null
  host: OrcadApexHost | null
  agentProcess: AgentProcessControl
  fixtureRoot: string
}): Promise<unknown[]> {
  const failures: unknown[] = []
  if (input.client) {
    try {
      await input.client.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  let agentConfirmedGone = true
  try {
    await stopRealAgentProcess(input.agentProcess)
  } catch (error) {
    agentConfirmedGone = false
    failures.push(error)
  }
  if (input.host) {
    try {
      await input.host.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  if (agentConfirmedGone) {
    try {
      rmSync(input.fixtureRoot, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  } else {
    failures.push(
      new Error(
        `the real agent pid ${String(input.agentProcess.pid)} was not confirmed gone; kept ${input.fixtureRoot} for inspection`
      )
    )
  }
  return failures
}

/**
 * The paired client mirrors a host-created terminal as a `web-terminal-<hostTabId>` tab, and that
 * mirror is what makes "close it in the UI" the same close a user performs. Returns the tab locator
 * the close and the "gone from the strip" assertions both use.
 */
export async function openRealAgentTabInClient(
  client: PairedElectronClient,
  worktreeId: string,
  clientTabId: string
): Promise<Locator> {
  await expect
    .poll(
      async () =>
        client.page.evaluate(
          ({ id, tabId }) =>
            (window.__store?.getState().tabsByWorktree[id] ?? []).some((tab) => tab.id === tabId),
          { id: worktreeId, tabId: clientTabId }
        ),
      { timeout: 90_000, message: 'the paired client never mirrored the apex terminal tab' }
    )
    .toBe(true)
  await client.page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    store.getState().setActiveView('terminal')
    store.getState().setActiveWorktree(id)
  }, worktreeId)
  const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${clientTabId}"]`)
  await expect(tab).toBeVisible({ timeout: 45_000 })
  await tab.click()
  // The pane has to be painted, not just mirrored: the screenshots are the evidence that a real TUI
  // was on screen.
  await expect(client.page.locator('textarea, .xterm')).not.toHaveCount(0, { timeout: 45_000 })
  return tab
}

/**
 * The close, as a user does it: hover the tab, click its X. A live agent makes the product ask first
 * ("Stop this agent?" — `RunningTerminalCloseDialog`), so the dialog is part of the path rather than
 * something to route around.
 */
export async function closeRealAgentTabInClient(
  page: Page,
  tab: Locator,
  evidenceDir: string | undefined
): Promise<void> {
  await tab.hover()
  const closeButton = tab.locator('[data-tab-close-button="true"]')
  await expect(closeButton).toHaveCount(1)
  await closeButton.click()
  const stopAgent = page.getByRole('button', { name: 'Stop Agent', exact: true })
  await expect(
    stopAgent,
    'closing a running agent must raise the product confirm dialog'
  ).toBeVisible({ timeout: 45_000 })
  await capturePanelScreenshot(page, evidenceDir, 'w15-agent-close-confirm.png')
  await stopAgent.click()
}

