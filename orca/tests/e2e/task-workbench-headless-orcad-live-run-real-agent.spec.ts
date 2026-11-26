/**
 * Issue #68, the literal acceptance: a **real agent TUI** (`pi`, the same binary a user runs) runs on
 * a real headless `orcad` apex, its own status extension posts the hook events, the user closes that
 * tab **in the paired client's UI** (tab X → "Stop this agent?"), and the task page must still list
 * the run afterwards.
 *
 * Why a separate file from `task-workbench-headless-orcad-live-run.spec.ts`: that one drives the hook
 * endpoint over HTTP, so it cannot prove the close path; these two cases launch a real agent, and the
 * pair (green + red control) would push one file past the `max-lines` budget
 * (`.oxlintrc.json:206`, 800 computed lines, and `orca/AGENTS.md` forbids both a disable comment and
 * a new `config/max-lines-baseline.txt` entry). Shared setup and reads live in
 * `helpers/task-workbench-live-run-*.ts`, the client tab and teardown in `helpers/real-agent-tui-close.ts`.
 *
 * Both cases spend one real model turn and are gated:
 * - `ORCA_PI_REAL_AGENT=1` — green: the run survives the UI close.
 * - `ORCA_PI_RED_CONTROL=1` — red control: on an **unfixed** artifact (`ORCA_E2E_ORCAD_APEX`, e.g.
 *   `/opt/orca/current`, always copied, never run in place) there is no `live-observation` run after
 *   the close. Covers the W16 finding that the earlier red run died before the close.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { startOrcadApex, type OrcadApexHost } from './helpers/orcad-apex-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  isProcessAlive,
  launchRealAgentTerminal,
  localAgentProcess,
  readAgentPid,
  seedPiAgentDir,
  waitForAgentTui
} from './helpers/real-agent-tui'
import {
  cleanupRealAgentCase,
  closeRealAgentTabInClient,
  openRealAgentTabInClient
} from './helpers/real-agent-tui-close'
import type { RecordingArtifact } from './helpers/sim-remote/recorder'
import {
  expandTaskWorkbenchAgentHistory,
  openTaskWorkbenchInPairedClient
} from './helpers/task-workbench-paired-page'
import {
  capturePanelScreenshot,
  recordSegment,
  writeApexIsolationEvidence
} from './helpers/task-workbench-live-run-evidence'
import {
  FIXTURE_URL,
  ISSUE_NUMBER,
  SESSION_ID,
  bindWorkspace,
  bindingRuns,
  createFixtureRepo,
  describeRuns,
  expectLiveObservationRun,
  readTaskRecord
} from './helpers/task-workbench-live-run-fixture'

/** Gate for the real-agent case: it launches `pi` and spends one real model turn. */
const REAL_AGENT_GATE = 'ORCA_PI_REAL_AGENT'
/**
 * Gate for the red control. Separate from the green gate because the two assert opposite outcomes: the
 * red case expects **no** run after the close and must fail on a fixed artifact.
 */
const RED_CONTROL_GATE = 'ORCA_PI_RED_CONTROL'

test.describe('issue #68 headless orcad live run — real agent', () => {

  // The literal acceptance the issue text states, and the only case that exercises the close path:
  // a **real** agent TUI runs on the apex, the user closes it in the client's own tab strip (tab X →
  // "Stop this agent?"), and the task page must still list the run afterwards. The three cases above
  // post to the hook endpoint themselves, so none of them can say anything about a closed TUI.
  // oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
  test('a real agent TUI stays listed after it is closed', async ({}, testInfo: TestInfo) => {
    test.skip(
      process.env[REAL_AGENT_GATE] !== '1',
      `set ${REAL_AGENT_GATE}=1 to run this case: it launches pi and spends one real model turn`
    )
    test.setTimeout(600_000)
    const fixture = createFixtureRepo()
    const evidence = process.env.ORCA_E2E_EVIDENCE_DIR
    let host: OrcadApexHost | null = null
    let client: PairedElectronClient | null = null
    const segments: RecordingArtifact[] = []
    let testError: unknown
    // Process ownership lives **outside** the try: a failure anywhere below still has to reclaim the
    // real agent, so the pid cannot be a try-local binding that a throw makes unreachable.
    let agentProcess = localAgentProcess(null)
    try {
      // Isolation comes first, before anything that can install a product extension: `startOrcadApex()`
      // spawns the apex with the runner's pi pane variables removed (`orcad-apex-child.ts`,
      // `AGENT_PANE_ENV_KEYS_ISOLATED_FROM_RUNNER`), so `host-env` cannot resolve a real `~/.pi/agent`
      // from the runner's `process.env` and install into it. The `envToDelete` passed to
      // `terminal.create` is the pane-level second line, and it lands only after the env is assembled.
      host = await startOrcadApex()
      writeApexIsolationEvidence(host)
      const workspace = await bindWorkspace(host, fixture)
      // Seeded after the apex is already isolated, and before the pane's own env assembly.
      const piAgent = seedPiAgentDir(fixture.root)
      const terminal = await launchRealAgentTerminal(host, workspace.worktreeId, piAgent)
      const startupScreen = await waitForAgentTui(host, terminal.handle)
      const agentPid = await readAgentPid(host, terminal.handle)
      agentProcess = localAgentProcess(agentPid)
      expect(agentPid, 'the apex never reported a foreground pid for the agent pane').not.toBeNull()
      const clientTabId = `web-terminal-${terminal.tabId}`

      client = await launchPairedElectronClient(
        { pairingUrl: host.offer.pairingUrl },
        testInfo,
        'Issue 68 real agent TUI'
      )
      const tab = await openRealAgentTabInClient(client, workspace.worktreeId, clientTabId)

      // One turn from the real agent. Nothing here posts a hook event: pi's own status extension
      // does, from the coordinates the apex put in the pane's environment.
      const observed = await recordSegment(client.page, evidence, 'running', segments, async () => {
        await host!.client.call('terminal.send', {
          terminal: terminal.handle,
          text: 'say hi in three words',
          enter: true,
          waitSubmitMs: 10_000
        })
        return expectLiveObservationRun(host!, workspace.repoId, workspace.worktreeId)
      })
      const liveRun = observed.run!
      expect(
        liveRun.providerSession.id,
        'the run must carry the session id pi itself reported, not an id this test invented'
      ).not.toBe(SESSION_ID)
      expect(liveRun.agentType, 'the run must name the agent that actually ran').toBe('pi')
      expect(liveRun.source).toBe('live-observation')
      await testInfo.attach('issue-68-real-agent-run.json', {
        body: JSON.stringify({ startupScreen, run: liveRun }, null, 2),
        contentType: 'application/json'
      })
      await capturePanelScreenshot(client.page, evidence, 'w15-agent-running.png')

      // The turn has to settle before the close, or the record would be read mid-turn: `endedAt` is
      // only written when the agent states a settled row.
      await expect
        .poll(
          async () =>
            bindingRuns(
              (await readTaskRecord(host!, workspace.repoId)).record,
              workspace.worktreeId
            ).runs.find((run) => run.source === 'live-observation')?.endedAt ?? null,
          { timeout: 120_000, message: 'the real agent turn never settled in the task record' }
        )
        .not.toBeNull()

      // THE CLOSE, as a user does it: hover the tab, click its X. A live agent makes the product ask
      // first ("Stop this agent?" — `RunningTerminalCloseDialog`), so the dialog is part of the path
      // rather than something to route around.
      const pairedPage = client.page
      await recordSegment(pairedPage, evidence, 'close', segments, async () => {
        await closeRealAgentTabInClient(pairedPage, tab, evidence)
      })

      // Closed, not switched away: the tab is gone from the client strip, the host dropped the tab
      // and its PTY, and the agent process is gone.
      await expect(tab, 'the closed tab must not remain in the client tab strip').toHaveCount(0, {
        timeout: 60_000
      })
      await expect
        .poll(
          async () => {
            const inventory = await host!.client.call<{ tabs: { id: string }[] }>(
              'session.tabs.list',
              { worktree: `id:${workspace.worktreeId}` }
            )
            return inventory.result.tabs.some((entry) => entry.id.startsWith(terminal.tabId))
          },
          { timeout: 60_000, message: 'the host kept the tab after the UI close' }
        )
        .toBe(false)
      const inspected = await host.client
        .call<Record<string, unknown>>('terminal.inspectProcess', { terminal: terminal.handle })
        .catch((error: unknown) => ({ error: String(error) }) as Record<string, unknown>)
      expect(
        JSON.stringify(inspected),
        'the pane must be gone from the host, not just hidden in the client'
      ).toContain('terminal_gone')
      expect(
        isProcessAlive(agentPid!),
        `the closed agent must not survive as an orphan (pid ${String(agentPid)})`
      ).toBe(false)
      await capturePanelScreenshot(pairedPage, evidence, 'w15-agent-closed.png')

      // And the record: the run is still there, ended, and the binding states no live session.
      const afterClose = bindingRuns(
        (await readTaskRecord(host, workspace.repoId)).record,
        workspace.worktreeId
      )
      const survivor = afterClose.runs.find((run) => run.source === 'live-observation')
      expect(
        survivor,
        `the closed TUI dropped its observed run from the task record:\n${describeRuns(afterClose.runs)}`
      ).toBeDefined()
      expect(survivor!.providerSession.id).toBe(liveRun.providerSession.id)
      expect(survivor!.endedAt).toBeGreaterThanOrEqual(survivor!.startedAt!)
      await testInfo.attach('issue-68-real-agent-after-close.json', {
        body: JSON.stringify(afterClose, null, 2),
        contentType: 'application/json'
      })

      // The product surface the user reads: the Agents history lists exactly this one run, from the
      // record, with no record-source notice underneath it.
      const runtimeRepoId = workspace.repoId
      const opened = await recordSegment(client.page, evidence, 'history', segments, async () =>
        openTaskWorkbenchInPairedClient(client!, {
        pageRepoId: runtimeRepoId,
        clientRepoIdsToExclude: [runtimeRepoId],
        issueNumber: ISSUE_NUMBER,
        projectId: 'issue-68-real-agent-e2e',
        title: 'Headless real agent run',
          tracker: {
            state: 'open',
            url: `${FIXTURE_URL.replace(/\.git$/, '')}/issues/${ISSUE_NUMBER}`
          }
        })
      )
      const { page, panel } = opened
      await expect(
        panel.getByTestId('task-workbench-agents-history-count'),
        `the closed agent left no live run for ${workspace.worktreeId}:\n${describeRuns(afterClose.runs)}`
      ).toHaveText('1', { timeout: 90_000 })
      await expandTaskWorkbenchAgentHistory(panel)
      const rows = panel
        .getByTestId('task-workbench-agents-record-runs')
        .getByTestId('task-workbench-history-run')
      await expect(rows).toHaveCount(1, { timeout: 45_000 })
      const row = rows.first()
      await expect(row).toBeVisible()
      await expect(row).toHaveAttribute('data-run-source', 'record')
      await expect(
        panel.getByTestId('task-workbench-history-record-sources'),
        'the panel printed a record-source notice, so the run is not a successful read'
      ).toHaveCount(0)
      // The closed terminal is not still an active tab anywhere on this page either.
      await expect(
        page.locator(`[data-testid="sortable-tab"][data-tab-id="${clientTabId}"]`),
        'the closed terminal is still rendered as a tab'
      ).toHaveCount(0)
      await capturePanelScreenshot(page, evidence, 'w15-task-page-history.png')
    } catch (error) {
      testError = error
      if (host) {
        await testInfo
          .attach('issue-68-real-agent-apex-output.txt', {
            body: host.output(),
            contentType: 'text/plain'
          })
          .catch(() => undefined)
      }
    } finally {
      if (segments.length > 0) {
        // Why toleranted: a failed attachment must not skip the process/fixture cleanup below — W16
        // found the previous `finally` could throw and leave the whole teardown unexecuted.
        await testInfo
          .attach('issue-68-real-agent-recordings.json', {
            body: JSON.stringify(segments, null, 2),
            contentType: 'application/json'
          })
          .catch(() => undefined)
      }
    }
    const failures = await cleanupRealAgentCase({
      client,
      host,
      agentProcess,
      fixtureRoot: fixture.root
    })
    for (const segment of segments) {
      console.log(
        `[issue-68] recording ${path.basename(segment.framesDir)}: video=${String(segment.videoPath)} frames=${segment.capturedFrameCount} duration=${segment.durationSec}s videoFrames=${String(segment.videoFrameCount)} degraded=${String(segment.timedOut)}`
      )
    }
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Issue 68 real agent test failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Issue 68 real agent cleanup failed')
    }
  })

  // The **red control** for the same acceptance, in the order the wording requires and W16 found
  // missing: a real agent TUI is started, closed **in the UI**, and only then the record is read. The
  // previous red run died before the close (its 60 s `expectLiveObservationRun` deadline, fired while
  // waiting for a run the unfixed artifact never writes), so it could not speak about the "still
  // listed after the close" claim at all.
  //
  // This case asserts the opposite outcome, so it **must fail on the fixed artifact**: after the close
  // there is no `live-observation` run for the worktree, and the Agents section lists none. It has its
  // own gate for that reason, and it spends one real model turn like the green case.
  // oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
  test('a real agent TUI closed on an unfixed artifact leaves no live run', async ({}, testInfo: TestInfo) => {
    test.skip(
      process.env[RED_CONTROL_GATE] !== '1',
      `set ${RED_CONTROL_GATE}=1 to run the red control: it closes a real pi TUI and expects the run to be absent`
    )
    test.setTimeout(600_000)
    const fixture = createFixtureRepo()
    const evidence = process.env.ORCA_E2E_EVIDENCE_DIR
    let host: OrcadApexHost | null = null
    let client: PairedElectronClient | null = null
    let agentProcess = localAgentProcess(null)
    let testError: unknown
    try {
      host = await startOrcadApex()
      writeApexIsolationEvidence(host)
      const workspace = await bindWorkspace(host, fixture)
      const piAgent = seedPiAgentDir(fixture.root)
      const terminal = await launchRealAgentTerminal(host, workspace.worktreeId, piAgent)
      // If the TUI never paints on the unfixed artifact, that *is* the finding: the case reports it as
      // "the artifact could not start the real agent" instead of pretending the close happened.
      const startupScreen = await waitForAgentTui(host, terminal.handle)
      const agentPid = await readAgentPid(host, terminal.handle)
      agentProcess = localAgentProcess(agentPid)
      const clientTabId = `web-terminal-${terminal.tabId}`
      client = await launchPairedElectronClient(
        { pairingUrl: host.offer.pairingUrl },
        testInfo,
        'Issue 68 real agent TUI (red control)'
      )
      const tab = await openRealAgentTabInClient(client, workspace.worktreeId, clientTabId)
      const pairedPage = client.page
      await testInfo.attach('issue-68-red-agent-startup.json', {
        body: JSON.stringify(
          {
            startupScreen,
            agentPid,
            // Whether the product's own status extension was even loaded in the pane: without it the
            // absence of a run would be explained by a missing hook path, not by the missing writer.
            extensionLoaded: startupScreen.includes('orca-agent-status.ts')
          },
          null,
          2
        ),
        contentType: 'application/json'
      })

      // One real turn, so the agent has the same chance to report itself as in the green case.
      await host.client.call('terminal.send', {
        terminal: terminal.handle,
        text: 'say hi in three words',
        enter: true,
        waitSubmitMs: 10_000
      })
      // Bounded settle window instead of the green case's assertion: the run may or may not appear
      // here, and this case must not fail *before* the close on that difference.
      await pairedPage.waitForTimeout(25_000)
      const beforeClose = bindingRuns(
        (await readTaskRecord(host, workspace.repoId)).record,
        workspace.worktreeId
      )

      // THE CLOSE: identical path to the green case — hover, tab X, "Stop Agent".
      await closeRealAgentTabInClient(pairedPage, tab, evidence)
      await expect(tab, 'the closed tab must not remain in the client tab strip').toHaveCount(0, {
        timeout: 60_000
      })
      await expect
        .poll(
          async () => {
            const inventory = await host!.client.call<{ tabs: { id: string }[] }>(
              'session.tabs.list',
              { worktree: `id:${workspace.worktreeId}` }
            )
            return inventory.result.tabs.some((entry) => entry.id.startsWith(terminal.tabId))
          },
          { timeout: 60_000, message: 'the host kept the tab after the UI close' }
        )
        .toBe(false)
      await capturePanelScreenshot(pairedPage, evidence, 'w17-red-agent-closed.png')

      // The assertion, **after the close**: the unfixed artifact records no live-observation run.
      const afterClose = bindingRuns(
        (await readTaskRecord(host, workspace.repoId)).record,
        workspace.worktreeId
      )
      const liveRuns = afterClose.runs.filter((run) => run.source === 'live-observation')
      await testInfo.attach('issue-68-red-after-close.json', {
        body: JSON.stringify({ beforeClose, afterClose }, null, 2),
        contentType: 'application/json'
      })
      if (evidence) {
        // The attachment is only reachable in the report; the record state this case turns on is worth
        // a file next to the screenshots.
        writeFileSync(
          path.join(evidence, 'w17-red-after-close.json'),
          JSON.stringify({ beforeClose, afterClose }, null, 2)
        )
      }
      expect(
        liveRuns,
        `the unfixed artifact kept a live-observation run after the close, so the green pass proves nothing:\n${describeRuns(afterClose.runs)}`
      ).toHaveLength(0)

      // And the product surface: no history count, no run rows, no record-source notice.
      const opened = await openTaskWorkbenchInPairedClient(client, {
        pageRepoId: workspace.repoId,
        clientRepoIdsToExclude: [workspace.repoId],
        issueNumber: ISSUE_NUMBER,
        projectId: 'issue-68-real-agent-red-e2e',
        title: 'Headless real agent run (red control)',
        tracker: {
          state: 'open',
          url: `${FIXTURE_URL.replace(/\.git$/, '')}/issues/${ISSUE_NUMBER}`
        }
      })
      const { page, panel } = opened
      const historyCount = panel.getByTestId('task-workbench-agents-history-count')
      // Either the count element is absent (nothing to list) or it reads 0. Both are "no run listed".
      if ((await historyCount.count()) > 0) {
        await expect(
          historyCount,
          `the Agents section counted a run the unfixed artifact never recorded:\n${describeRuns(afterClose.runs)}`
        ).toHaveText('0')
      }
      await expect(
        panel
          .getByTestId('task-workbench-agents-record-runs')
          .getByTestId('task-workbench-history-run'),
        'the task page listed a record run for a workspace the unfixed artifact never recorded'
      ).toHaveCount(0)
      await expect(
        panel.getByTestId('task-workbench-history-record-sources'),
        'the panel printed a record-source notice, i.e. it read runs from somewhere'
      ).toHaveCount(0)
      await capturePanelScreenshot(page, evidence, 'w17-red-task-page-history.png')
    } catch (error) {
      testError = error
      if (host) {
        await testInfo
          .attach('issue-68-red-agent-apex-output.txt', {
            body: host.output(),
            contentType: 'text/plain'
          })
          .catch(() => undefined)
      }
    }
    const failures = await cleanupRealAgentCase({
      client,
      host,
      agentProcess,
      fixtureRoot: fixture.root
    })
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Issue 68 red control failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Issue 68 red control cleanup failed')
    }
  })
})
