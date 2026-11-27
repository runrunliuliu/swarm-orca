/**
 * Fixtures and record reads shared by the two issue #68 e2e specs.
 *
 * The HTTP-injected cases (`task-workbench-headless-orcad-live-run.spec.ts`) and the real-agent
 * cases (`task-workbench-headless-orcad-live-run-real-agent.spec.ts`) run the **same** story up to
 * the point where they differ — apex, binding, hook endpoint, record read — so the assertions cannot
 * drift apart. Why they are two files at all: `.oxlintrc.json` budgets a spec at 800 computed lines
 * and `orca/AGENTS.md` forbids both a `max-lines` disable and a new `config/max-lines-baseline.txt`
 * entry, so the split has to be by meaning, not by trimming.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeWorktreeCreateResult } from '../../../src/shared/runtime-worktree-contracts'
import type { TaskRecord, TaskRecordRun } from '../../../src/shared/task-records-types'
import { waitForOrcadHookEndpoint, type OrcadApexHost } from './orcad-apex-host'

export const ISSUE_NUMBER = 68
/** A closed pane's durable identity: tab id plus leaf UUID (`shared/stable-pane-id.ts`). */
const CLOSED_TAB_ID = 'issue-68-closed-tab'
const CLOSED_LEAF_ID = '68c0fee0-0000-4000-8000-000000006868'
export const SESSION_ID = 'issue-68-headless-live-run'
const FIXTURE_OWNER = 'orca-e2e'
const FIXTURE_REPO = 'headless-live-run'
export const FIXTURE_URL = `https://github.com/${FIXTURE_OWNER}/${FIXTURE_REPO}.git`

export type FixtureRepo = { repoPath: string; root: string; transcriptPath: string }

export function createFixtureRepo(): FixtureRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-issue-68-'))
  const repoPath = path.join(root, 'source')
  mkdirSync(repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), '# headless live run task record\n')
  execFileSync('git', ['init'], { cwd: repoPath })
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['remote', 'add', 'origin', FIXTURE_URL], { cwd: repoPath })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync(
    'git',
    ['-c', 'user.name=Orca E2E', '-c', 'user.email=orca-e2e@example.com', 'commit', '-m', 'seed'],
    { cwd: repoPath }
  )
  const transcriptPath = path.join(root, 'issue-68-session.jsonl')
  writeFileSync(transcriptPath, '{"type":"session_meta"}\n')
  return { repoPath, root, transcriptPath }
}

export type BoundWorkspace = {
  repoId: string
  worktreeId: string
  worktreePath: string
  /**
   * The pane the run is attributed to. The host is driven over RPC, not by a TUI, so this is the
   * key a closed pane would have left behind (`<tabId>:<leaf UUID>`, the durable leaf id a closed
   * TUI keeps in the profile, `shared/stable-pane-id.ts` — a leaf that is not a UUID is rejected at
   * write time, which is why this is not free text). The provider resolver answers `undefined` for a
   * pane this profile never launched (claim `unknown|...`, an accepted shape —
   * `task-records-live-runs.ts:73`), so PTY is not a precondition of this case.
   */
  paneKey: string
}

/** `repo.add` → `worktree.create{linkedIssue}`: the binding the run must attach to, written by the
 *  worktree-metadata hook with `boundBy: 'created'` (the issue's "worktree already had a binding,
 *  *then* the agent ran" ordering). */
export async function bindWorkspace(host: OrcadApexHost, fixture: FixtureRepo): Promise<BoundWorkspace> {
  const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
    path: fixture.repoPath,
    kind: 'git'
  })
  const repoId = added.result.repo.id
  const created = await host.client.call<RuntimeWorktreeCreateResult>('worktree.create', {
    repo: `id:${repoId}`,
    name: 'issue-68-headless-live',
    noParent: true,
    linkedIssue: ISSUE_NUMBER,
    setupDecision: 'skip',
    activate: false
  })
  const worktreeId = created.result.worktree.id
  return {
    repoId,
    worktreeId,
    worktreePath: created.result.worktree.path,
    paneKey: `${CLOSED_TAB_ID}:${CLOSED_LEAF_ID}`
  }
}

/** One `POST /hook/<agent>` exactly as an agent's hook script sends it. */
export async function postHookEvent(
  host: OrcadApexHost,
  event: {
    paneKey: string
    worktreeId: string
    transcriptPath: string
    payload: Record<string, unknown>
  }
): Promise<number> {
  const endpoint = await waitForOrcadHookEndpoint(host.userDataDir)
  const [tabId] = event.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: event.paneKey,
      tabId,
      worktreeId: event.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload: event.payload
    })
  })
  return response.status
}

export async function readTaskRecord(
  host: OrcadApexHost,
  repoId: string
): Promise<{ record: TaskRecord | null; repoKnown: boolean }> {
  const response = await host.client.call<{ record: TaskRecord | null; repoKnown: boolean }>(
    'taskRecords.get',
    { repoId, itemType: 'issue', number: ISSUE_NUMBER, provider: 'github' }
  )
  return response.result
}

export function bindingRuns(
  record: TaskRecord | null,
  worktreeId: string
): { bindingPresent: boolean; runs: TaskRecordRun[]; boundBy: string | null } {
  const binding = record?.bindings?.find((candidate) => candidate.worktreeId === worktreeId)
  return {
    bindingPresent: binding !== undefined,
    runs: binding?.runs ?? [],
    boundBy: binding?.boundBy ?? null
  }
}

/** The runtime's own view of the run, for evidence: what the red run fails on, in its own words. */
export function describeRuns(runs: readonly TaskRecordRun[]): string {
  if (runs.length === 0) {
    return 'runs: (absent)'
  }
  return runs
    .map(
      (run) =>
        `runs: source=${run.source} claim=${run.key} session=${run.providerSession.id} ` +
        `startedAt=${String(run.startedAt)} endedAt=${String(run.endedAt)} outcome=${String(run.outcome)}`
    )
    .join('\n')
}

/**
 * Polls the Store read until a live-observation run for this workspace appears, then returns the
 * binding's state. Failing here is the red run's expected outcome, so the message carries the runs
 * the artifact actually produced (e.g. `runs: (absent)`) instead of a bare timeout.
 */
export async function expectLiveObservationRun(
  host: OrcadApexHost,
  repoId: string,
  worktreeId: string
): Promise<{ runs: TaskRecordRun[]; run?: TaskRecordRun; record: TaskRecord | null }> {
  const deadline = Date.now() + 60_000
  let last: { bindingPresent: boolean; runs: TaskRecordRun[]; boundBy: string | null } = {
    bindingPresent: false,
    runs: [],
    boundBy: null
  }
  let record: TaskRecord | null = null
  for (;;) {
    const read = await readTaskRecord(host, repoId)
    record = read.record
    last = bindingRuns(record, worktreeId)
    const live = last.runs.find((run) => run.source === 'live-observation')
    if (live) {
      return { runs: last.runs, run: live, record }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no run with source 'live-observation' for worktree ${worktreeId} after 60s ` +
          `(binding present=${last.bindingPresent}, boundBy=${String(last.boundBy)}):\n${describeRuns(last.runs)}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

