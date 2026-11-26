/**
 * Issue #68 — a live run observed on a **real headless `orcad` apex**, driven over the hook endpoint.
 *
 * The bug: #57 installed the task-record live-run writer only in
 * `startup/main-process-observers.ts`, whose module tree imports `electron`. The headless
 * composition root (`main/orcad/orcad-entry.ts`) is a full runtime authority with its own Store, so
 * an agent that ran there was never observed: closing the TUI dropped the retained row and the
 * task's history had no run from that workspace at all.
 *
 * Why the assertions read `taskRecords.get` over RPC and not the profile's sqlite file: reading the
 * file would pin schema details and the write scheduler, while the Store read is exactly what the
 * task page consumes. Why the apex is a subprocess of `out/orcad/orcad.js` and not the Electron
 * `--serve` host used by `task-workbench-remote-only-record.spec.ts`: that host loads
 * `main-process-observers.ts`, i.e. the half #57 already fixed, so it is green whatever happens
 * here — a false pass.
 *
 * Red/green: `ORCA_E2E_ORCAD_APEX=<dir>` selects the apex. Green is a build of the fixed tree
 * (`out/orcad`); red is the pre-fix artifact `/opt/orca/current`. The same spec must fail on red at
 * the `live-observation` assertion, which is what proves the green pass comes from the fix. The
 * desktop case fails on red at its own first assertion (`History 1` in the Agents section) for the
 * same reason: the run does not exist, so there is nothing to list.
 *
 * Where the desktop case looks: the task page renders a **live** workspace's runs in the Agents
 * section, not in the archived `task-workbench-history` strip (`TaskWorkbenchPanel.tsx:79,111` —
 * `trace === 'none'` skips the strip; `TaskWorkbenchAgents.tsx:137-142,254-257`). An assertion on
 * the strip was asserting a surface the product never paints while the workspace is alive, not a
 * product failure: measured in `fixme-root-cause.md` (W12), where the same read answered
 * `repoKnown: true` with no `Could not read history` notice.
 *
 * The three cases here post to the hook endpoint themselves, so **none of them can speak about a
 * closed TUI** — not even the desktop one, which renders a record-backed row. That literal
 * acceptance (a real agent TUI closed in the paired client's UI, its run still listed) is
 * `task-workbench-headless-orcad-live-run-real-agent.spec.ts`, kept in its own file because it
 * spends a real model turn behind `ORCA_PI_REAL_AGENT=1` and, with its red control, does not fit
 * this file's `max-lines` budget.
 *
 * Not covered here (and not claimed): an event that arrives *before* the binding exists is still
 * dropped (`task-records-live-runs.ts:167`), and the 512-entry write filter is cleared on restart.
 * Both are stated limitations of the issue, not regressions.
 */

import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { startOrcadApex, type OrcadApexHost } from './helpers/orcad-apex-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { startRecording, type RecordingArtifact } from './helpers/sim-remote/recorder'
import {
  expandTaskWorkbenchAgentHistory,
  openTaskWorkbenchInPairedClient
} from './helpers/task-workbench-paired-page'
import {
  apexBuildEvidence,
  capturePanelScreenshot,
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
  postHookEvent,
  readTaskRecord
} from './helpers/task-workbench-live-run-fixture'

test.describe('issue #68 headless orcad live run', () => {

  // The pane identity is a *closed pane's* key string, not a TUI this profile ever launched: the
  // provider resolver answers `unknown` for it. What is proven is the record surviving without a
  // retained pane and across a restart, not that a real agent TUI was opened and closed.
  // oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
  test('records a live-observation run for a closed pane key and keeps it across a restart', async ({}, testInfo: TestInfo) => {
    test.setTimeout(420_000)
    const fixture = createFixtureRepo()
    let host: OrcadApexHost | null = null
    let testError: unknown
    try {
      host = await startOrcadApex()
      writeApexIsolationEvidence(host)
      await testInfo.attach('issue-68-apex-build.json', {
        body: apexBuildEvidence(host),
        contentType: 'application/json'
      })
      const workspace = await bindWorkspace(host, fixture)
      const before = bindingRuns(
        (await readTaskRecord(host, workspace.repoId)).record,
        workspace.worktreeId
      )
      expect(
        before.bindingPresent,
        `worktree.create{linkedIssue} did not write a task-record binding for ${workspace.worktreeId}`
      ).toBe(true)
      expect(before.boundBy).toBe('created')
      expect(before.runs, 'the binding must start with no runs').toEqual([])

      // A real agent status event: prompt submitted, then the agent stopped.
      const startedAt = Date.now()
      const statuses = [
        await postHookEvent(host, {
          paneKey: workspace.paneKey,
          worktreeId: workspace.worktreeId,
          transcriptPath: fixture.transcriptPath,
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: SESSION_ID,
            transcript_path: fixture.transcriptPath,
            prompt: 'Run issue 68 without calling a model.'
          }
        }),
        await postHookEvent(host, {
          paneKey: workspace.paneKey,
          worktreeId: workspace.worktreeId,
          transcriptPath: fixture.transcriptPath,
          payload: {
            hook_event_name: 'Stop',
            session_id: SESSION_ID,
            transcript_path: fixture.transcriptPath,
            last_assistant_message: 'Recorded on the headless host.'
          }
        })
      ]
      expect(statuses).toEqual([204, 204])

      // The scenario the issue reports: the pane is already gone when the record is read —
      // nothing here keeps a retained row alive, the run has to come from the record itself.

      const observed = await expectLiveObservationRun(host, workspace.repoId, workspace.worktreeId)
      await testInfo.attach('issue-68-task-record.json', {
        body: JSON.stringify(observed, null, 2),
        contentType: 'application/json'
      })
      expect(observed.run!.providerSession.id).toBe(SESSION_ID)
      expect(observed.run!.startedAt, 'the hook clock must date the run').toBeGreaterThanOrEqual(
        startedAt - 1_000
      )
      expect(observed.run!.endedAt).toBeGreaterThanOrEqual(observed.run!.startedAt!)
      expect(
        observed.run!.outcome,
        'a plain Stop records no verdict; inventing one here would be a fact the hook never stated'
      ).toBeUndefined()
      console.log(`[issue-68] observed run: ${JSON.stringify(observed.run)}`)

      // Acceptance #2: still there after the runtime restarts on the same profile. The profile keeps
      // its runtime id across a restart, so the restart is proven by the exit/readiness cycle in
      // `host.restart()` and by the record surviving it, not by an id change.
      await host.restart()
      expect(String(host.readiness.runtimeId ?? '')).not.toBe('')
      const afterRestart = await expectLiveObservationRun(
        host,
        workspace.repoId,
        workspace.worktreeId
      )
      expect(afterRestart.runs).toHaveLength(observed.runs.length)
      await testInfo.attach('issue-68-task-record-after-restart.json', {
        body: JSON.stringify(afterRestart, null, 2),
        contentType: 'application/json'
      })
    } catch (error) {
      testError = error
      if (host) {
        await testInfo
          .attach('issue-68-apex-output.txt', { body: host.output(), contentType: 'text/plain' })
          .catch(() => undefined)
      }
    }
    const cleanup = await Promise.allSettled([
      host?.dispose() ?? Promise.resolve(),
      Promise.resolve().then(() => rmSync(fixture.root, { recursive: true, force: true }))
    ])
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Issue 68 test and fixture cleanup failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Issue 68 fixture cleanup failed')
    }
  })

  // oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
  test('a binding with no hook event stays without a live-observation run (reverse control)', async ({}, testInfo: TestInfo) => {
    // Without this case the green assertion below would pass on a build that writes a live run for
    // every workspace it sees, i.e. it could not distinguish observing a real event from inventing one.
    test.setTimeout(240_000)
    const fixture = createFixtureRepo()
    let host: OrcadApexHost | null = null
    let testError: unknown
    try {
      host = await startOrcadApex()
      const workspace = await bindWorkspace(host, fixture)
      // Hold the runtime open for as long as the positive case takes to see its run, then ask.
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const read = await readTaskRecord(host, workspace.repoId)
      const after = bindingRuns(read.record, workspace.worktreeId)
      expect(after.bindingPresent).toBe(true)
      expect(
        after.runs.filter((run) => run.source === 'live-observation'),
        `no hook event was posted, so no live run may exist. Record says:\n${describeRuns(after.runs)}`
      ).toHaveLength(0)
      await testInfo.attach('issue-68-reverse-control.json', {
        body: JSON.stringify({ ...after, record: read.record }, null, 2),
        contentType: 'application/json'
      })
    } catch (error) {
      testError = error
      if (host) {
        await testInfo
          .attach('issue-68-reverse-control-apex-output.txt', {
            body: host.output(),
            contentType: 'text/plain'
          })
          .catch(() => undefined)
      }
    }
    const cleanup = await Promise.allSettled([
      host?.dispose() ?? Promise.resolve(),
      Promise.resolve().then(() => rmSync(fixture.root, { recursive: true, force: true }))
    ])
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Issue 68 reverse control cleanup failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Issue 68 reverse control cleanup failed')
    }
  })

  // The desktop half of acceptance #1. A live workspace's record runs are listed by the Agents
  // section (`TaskWorkbenchAgents.tsx:137-142`), which is why this case reads that section and not
  // the archived strip: asserting `task-workbench-history` here was asserting a surface the product
  // deliberately does not paint for `trace === 'none'` (W12 root cause, `fixme-root-cause.md`).
  // oxlint-disable-next-line no-empty-pattern -- Playwright callback signatures require fixture destructuring.
  test('the paired desktop task page lists the live run in the Agents history', async ({}, testInfo: TestInfo) => {
    // The run the headless host just recorded must be on screen in the panel's own reading of the
    // record: the Agents history fold is where a live workspace's record runs are listed, and its
    // count must be the one run this case posted.
    test.setTimeout(480_000)
    const fixture = createFixtureRepo()
    const evidence = process.env.ORCA_E2E_EVIDENCE_DIR
    let host: OrcadApexHost | null = null
    let client: PairedElectronClient | null = null
    let recording: Awaited<ReturnType<typeof startRecording>> | null = null
    let recordingArtifact: RecordingArtifact | null = null
    let testError: unknown
    try {
      host = await startOrcadApex()
      const workspace = await bindWorkspace(host, fixture)
      const runtimeRepoId = workspace.repoId
      expect(
        await postHookEvent(host, {
          paneKey: workspace.paneKey,
          worktreeId: workspace.worktreeId,
          transcriptPath: fixture.transcriptPath,
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: SESSION_ID,
            transcript_path: fixture.transcriptPath,
            prompt: 'Run issue 68 for the desktop task page.'
          }
        })
      ).toBe(204)
      expect(
        await postHookEvent(host, {
          paneKey: workspace.paneKey,
          worktreeId: workspace.worktreeId,
          transcriptPath: fixture.transcriptPath,
          payload: {
            hook_event_name: 'Stop',
            session_id: SESSION_ID,
            transcript_path: fixture.transcriptPath,
            last_assistant_message: 'Recorded on the headless host.'
          }
        })
      ).toBe(204)
      // One read of what the artifact wrote, for this case's own failure message. It is not the
      // assertion — that reads the page below — but on the pre-fix artifact it is what names the
      // absence ("runs: (absent)") instead of leaving a bare element-not-found.
      const recorded = bindingRuns(
        (await readTaskRecord(host, workspace.repoId)).record,
        workspace.worktreeId
      )

      client = await launchPairedElectronClient(
        { pairingUrl: host.offer.pairingUrl },
        testInfo,
        'Issue 68 headless runtime'
      )
      // Warm the paired transport with the exact call the task page will make: the panel opens on
      // its first paint, so a connection that is still settling would surface as "it did not answer"
      // rather than as the runtime's own answer.
      const pairedRead = await client.page.evaluate(
        async ({ environmentId, repoId }) => {
          const response = await window.api.runtimeEnvironments.call({
            selector: environmentId,
            method: 'taskRecords.get',
            params: { repoId, itemType: 'issue', number: 68, provider: 'github' }
          })
          return response.ok === false ? { ok: false, error: response.error } : { ok: true }
        },
        { environmentId: client.environmentId, repoId: runtimeRepoId }
      )
      await testInfo.attach('issue-68-paired-warmup.json', {
        body: JSON.stringify(pairedRead, null, 2),
        contentType: 'application/json'
      })
      expect(
        pairedRead.ok,
        `paired runtime did not answer taskRecords.get: ${JSON.stringify(pairedRead)}`
      ).toBe(true)
      const { page, panel } = await openTaskWorkbenchInPairedClient(client, {
        pageRepoId: runtimeRepoId,
        // The task page forwards the read to the paired runtime only once the client's catalog holds
        // the runtime's own repo row (issue #67 spec's contract); without this wait the panel opens
        // before the mapping exists and reports "it did not answer".
        clientRepoIdsToExclude: [runtimeRepoId],
        issueNumber: ISSUE_NUMBER,
        projectId: 'issue-68-e2e',
        title: 'Headless live run',
        tracker: {
          state: 'open',
          url: `${FIXTURE_URL.replace(/\.git$/, '')}/issues/${ISSUE_NUMBER}`
        }
      })
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        // Started after the page is up and stopped right after the screenshot: the recorder's
        // capture deadline is 25 s, so a page-lifetime span would encode as a degraded artefact.
        recording = await startRecording(client.page, {
          outDir: path.join(evidence, 'history-live-run-recording'),
          scope: 'caller-scoped',
          deadlineMs: 20_000
        })
      }
      // Deliberately no workspace-card assertion: `worktree.create{activate:false}` links no pane,
      // so the Workspaces section answers "No workspace is linked to this task yet" while the
      // record-backed run still lists below — the run comes from the record, not from a live row.
      await expect(
        panel.getByTestId('task-workbench-agents-history-count'),
        `the task record has no live run for ${workspace.worktreeId} (binding present=${recorded.bindingPresent}, boundBy=${String(recorded.boundBy)}):\n${describeRuns(recorded.runs)}`
      ).toHaveText('1', { timeout: 90_000 })
      // The fold's body is a Radix collapsible: the rows are mounted but not visible while it is
      // closed, and the layout decides the initial state (`TaskWorkbenchAgents.tsx:145`).
      await expandTaskWorkbenchAgentHistory(panel)
      // A record row, not a live projection: nothing here keeps a retained pane row alive, and the
      // renderer marks the origin — `data-run-source="record"` (`TaskWorkbenchHistory.tsx:96-97`).
      const rows = panel
        .getByTestId('task-workbench-agents-record-runs')
        .getByTestId('task-workbench-history-run')
      await expect(rows).toHaveCount(1, { timeout: 45_000 })
      const row = rows.filter({ hasText: SESSION_ID })
      await expect(row).toBeVisible()
      await expect(row).toHaveAttribute('data-run-source', 'record')
      // Not a degraded render: a read that failed prints a notice row instead of the run
      // (`task-workbench-record-source-notice.tsx:141-152`). The run on screen *and* this list
      // absent is what distinguishes a record-backed row from a local-only fallback.
      await expect(
        panel.getByTestId('task-workbench-history-record-sources'),
        'the panel printed a record-source notice, so the run is not a successful read'
      ).toHaveCount(0)
      // Closing the loop on where that row came from: the runtime's own answer to the same query
      // the page made, read only after the page has shown it.
      const observed = await expectLiveObservationRun(host, workspace.repoId, workspace.worktreeId)
      expect(observed.run!.providerSession.id).toBe(SESSION_ID)
      await capturePanelScreenshot(page, evidence, 'history-live-run.png')
      await testInfo.attach('issue-68-task-page-agents.html', {
        body: await panel.getByTestId('task-workbench-agents').evaluate((node) => node.outerHTML),
        contentType: 'text/html'
      })
    } catch (error) {
      testError = error
      if (host) {
        await testInfo
          .attach('issue-68-apex-output.txt', { body: host.output(), contentType: 'text/plain' })
          .catch(() => undefined)
      }
    } finally {
      if (recording) {
        recordingArtifact = await recording.stop().catch(() => null)
        if (recordingArtifact) {
          await testInfo.attach('issue-68-recording.json', {
            body: JSON.stringify(recordingArtifact, null, 2),
            contentType: 'application/json'
          })
        }
      }
    }
    const cleanup = await Promise.allSettled([
      client?.dispose() ?? Promise.resolve(),
      host?.dispose() ?? Promise.resolve(),
      Promise.resolve().then(() => rmSync(fixture.root, { recursive: true, force: true }))
    ])
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (!recordingArtifact?.videoPath && recordingArtifact) {
      console.log(
        `[issue-68] recording degraded: videoPath=null frames=${recordingArtifact.capturedFrameCount} encoder=${JSON.stringify(recordingArtifact.encoder)}`
      )
    }
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Issue 68 task page test failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Issue 68 task page cleanup failed')
    }
  })
})
