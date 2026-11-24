import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { TaskRecordTranscriptCheck } from '../../shared/task-records-types'
import { hasUnresolvedArchiveSnapshot } from '../task-records/task-records-archive-snapshot'
import { normalizeTaskRecords } from '../../shared/task-records-normalize'
import type { TranscriptCheckProbe } from '../task-records/task-records-transcript-check'
import {
  bindingOf,
  indexSession,
  meta,
  recordOf,
  runtime,
  SCHEDULING,
  ID,
  TASK_ID,
  type FixtureRuntime
} from '../task-records/task-records-archive-snapshot-test-fixtures'
import type { TaskRecordsRuntime } from '../persistence/loading-store/task-records-persistence'
import { recordTaskRecordsForWorktree } from '../persistence/loading-store/task-records-metadata-hooks'
import {
  createTaskRecordsUsageSource,
  type TaskRecordsUsageSource,
  type TaskRecordsUsageStoreSet
} from '../task-records/task-records-worktree-usage'
import {
  bindOrcadTaskRecordsUsageSource,
  type OrcadTaskRecordsUsageSourcePorts
} from './orcad-task-records-usage-source'

/**
 * Issue #31's actual fix, proven through the binding the headless root uses.
 *
 * The bug was not a wrong snapshot: `orcad` never called
 * `setTaskRecordsUsageSource`, so `applyArchiveSnapshot` took its missing-source arm
 * for the lifetime of the process and the reverse lookup never ran, even when this
 * host's session index held the workspace's session.
 *
 * These cases drive the real bind function (the one the Store seam calls) and then
 * the real metadata write path (`recordTaskRecordsForWorktree`) against the source it
 * stored. Only the two filesystem-backed archive deps are fixtures — the same seam
 * the desktop path is tested through — so what is asserted is the writer's own state,
 * not a mock's.
 */

const scheduled = vi.hoisted(() => vi.fn())
vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: scheduled }))

afterEach(() => {
  scheduled.mockClear()
  vi.restoreAllMocks()
})

const TRANSCRIPT_CHECK: TaskRecordTranscriptCheck = {
  checkedAt: 700,
  presence: 'present',
  dev: 2_049,
  ino: 7,
  mtimeMs: 300,
  size: 4_096
}

function context(rt: FixtureRuntime) {
  return { runtime: rt as unknown as TaskRecordsRuntime, scheduling: SCHEDULING }
}

function pathOf(worktreeId: string): string {
  return worktreeId.slice(worktreeId.indexOf('::') + 2)
}

/** A session inside the binding's own window: `boundAt` is the real write-path
 *  clock, so `createdAt` sits just before it and `updatedAt` on it. */
function sessionInWindow(worktreeId: string, boundAt: number): AiVaultSession {
  return indexSession({
    cwd: pathOf(worktreeId),
    createdAt: new Date(boundAt - 1_000).toISOString(),
    updatedAt: new Date(boundAt).toISOString(),
    modifiedAt: new Date(boundAt).toISOString()
  })
}

/** The production binding, onto a store double that records what it was given — the
 *  same `setTaskRecordsUsageSource` the seam calls. The hook server reports no pane
 *  attribution at all, which is exactly the archive moment the reverse lookup exists
 *  for (a workspace whose TUI was closed before its task was archived). */
function bindOrcadSource(
  rt: FixtureRuntime,
  lookup: () => Promise<readonly AiVaultSession[]>,
  check: TranscriptCheckProbe = async () => TRANSCRIPT_CHECK
) {
  const store: OrcadTaskRecordsUsageSourcePorts['store'] = {
    getWorkspaceSessionPartitions: () => [],
    setTaskRecordsUsageSource: (source) => {
      rt.taskRecordsUsageSource = source
    }
  }
  const source = bindOrcadTaskRecordsUsageSource({
    hookServer: { getProviderSessionIdentities: () => [], getStatusSnapshot: () => [] },
    store,
    archiveSnapshot: { sessionIndexLookup: lookup, transcriptCheck: check }
  })
  if (!source) {
    throw new Error('the orcad binding must not fail with these ports')
  }
  return source
}

/** Bind the workspace and hand back the stored binding: its `boundAt` is the window
 *  the index fixture has to fall inside. */
function bindWorkspace(rt: FixtureRuntime) {
  recordTaskRecordsForWorktree(context(rt), ID, meta())
  return bindingOf(recordOf(rt.state.taskRecords))
}

function archive(rt: FixtureRuntime) {
  recordTaskRecordsForWorktree(context(rt), ID, meta({ isArchived: true }))
}

function bindingNow(rt: FixtureRuntime) {
  return bindingOf(recordOf(rt.state.taskRecords))
}

/** A desktop-shaped store set: one claude rollup row for this fixture workspace, so a
 *  settlement can be a measured number instead of an absence. */
function storesWithTokens(tokens: number, enabled = true): TaskRecordsUsageStoreSet {
  const other = {
    getScanState: () => ({ enabled }),
    getSnapshot: () => ({ projectBreakdown: [] })
  }
  return {
    claude: {
      getScanState: () => ({ enabled }),
      getSnapshot: () => ({
        projectBreakdown: [
          {
            key: `worktree:${ID}`,
            inputTokens: tokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.5
          }
        ]
      })
    },
    codex: other,
    opencode: other,
    muse: other
  }
}

describe('orcad task-records usage source: the archive transition', () => {
  it('stores the session the index holds, with its run and transcript check (index hit)', async () => {
    const rt = runtime()
    const bound = bindWorkspace(rt)
    const lookup = vi.fn(async (): Promise<readonly AiVaultSession[]> => [
      sessionInWindow(ID, bound.boundAt)
    ])
    const source = bindOrcadSource(rt, lookup)
    // The binding is what the archive transition will read: not a fixture source.
    expect(rt.taskRecordsUsageSource).toBe(source)

    archive(rt)
    await vi.waitFor(() => expect(bindingNow(rt).sessions).toHaveLength(1))

    const written = bindingNow(rt)
    expect(lookup).toHaveBeenCalledTimes(1)
    // The claim comes from the index row, the check from this process's one `stat`:
    // the same observation, completed after the synchronous write.
    expect(written.sessions[0]).toMatchObject({
      provider: 'claude',
      key: 'session_id',
      id: 'abc',
      source: 'archive-snapshot',
      transcriptCheck: TRANSCRIPT_CHECK
    })
    expect(written.runs).toHaveLength(1)
    expect(written.runs?.[0]).toMatchObject({
      key: 'claude|session_id:abc',
      source: 'archive-snapshot',
      transcriptCheck: TRANSCRIPT_CHECK
    })
    // A transcript records what was said, never the provider's verdict: absent stays
    // absent instead of being read as a success.
    expect(written.runs?.[0]).not.toHaveProperty('outcome')
    // The marker gap stays as provenance ("the archive moment could not see"), but the
    // record is no longer empty, so it is no longer an unresolved archive.
    expect(written.gaps?.map((gap) => gap.kind)).toContain('session_unattributable')
    expect(hasUnresolvedArchiveSnapshot(written)).toBe(false)
    // Sessions and runs are measured here; the settlement is not (no usage store in
    // this build), so the field stays absent instead of carrying a reason.
    expect(written).not.toHaveProperty('usageSettlement')
    expect(scheduled).toHaveBeenCalledWith(SCHEDULING, ['taskRecords'])
  })

  it('writes the bounded-scan gap instead of an empty claim when the index has no hit', async () => {
    const rt = runtime()
    const lookup = vi.fn(async (): Promise<readonly AiVaultSession[]> => [])
    bindOrcadSource(rt, lookup)

    bindWorkspace(rt)
    archive(rt)
    await vi.waitFor(() =>
      expect(bindingNow(rt).gaps?.some((gap) => gap.detail?.includes('bounded scan'))).toBe(true)
    )

    const written = bindingNow(rt)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(written.sessions).toEqual([])
    expect(written.runs).toEqual([])
    // The miss is reported as "not in the part of the index this host scanned", so a
    // reader can tell it apart from an empty claim; the recoverable marker survives.
    expect(written.gaps?.map((gap) => gap.detail ?? '')).toContainEqual(
      expect.stringContaining('bounded scan')
    )
    expect(hasUnresolvedArchiveSnapshot(written)).toBe(true)
  })

  it('writes no second row and runs no second lookup when the same touch is replayed', async () => {
    const rt = runtime()
    const bound = bindWorkspace(rt)
    const lookup = vi.fn(async (): Promise<readonly AiVaultSession[]> => [
      sessionInWindow(ID, bound.boundAt)
    ])
    bindOrcadSource(rt, lookup)

    archive(rt)
    await vi.waitFor(() => expect(bindingNow(rt).sessions).toHaveLength(1))
    scheduled.mockClear()

    // An ordinary later metadata touch of the same, now archived, binding.
    recordTaskRecordsForWorktree(context(rt), ID, { ...meta({ isArchived: true }), isUnread: true })
    const replayed = bindingNow(rt)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(replayed.sessions).toHaveLength(1)
    expect(replayed.runs).toHaveLength(1)
    // Nothing to write, so nothing is saved: the record already holds this fact.
    expect(scheduled).not.toHaveBeenCalled()
  })
})

describe('orcad task-records usage source: the settlement this root can state', () => {
  it('stores no settlement at all when this build measured none', () => {
    const rt = runtime()
    bindOrcadSource(rt, async () => [])

    bindWorkspace(rt)
    archive(rt)

    const written = bindingNow(rt)
    // The field is *absent*, not `unavailable` and never `0`: this build has no usage
    // store, so any reason the enum offers would claim something that did not happen.
    expect(written).not.toHaveProperty('usageSettlement')
    // The archive still states what it looked at: runs written, and the marker gap.
    expect(written.runs).toEqual([])
    expect(written.gaps?.map((gap) => gap.kind)).toContain('session_unattributable')
  })

  it('leaves a measured settlement on the binding, and keeps it on a replay', () => {
    const rt = runtime()
    // The desktop-shaped binding: a store set is what makes a settlement a number.
    rt.taskRecordsUsageSource = createTaskRecordsUsageSource({
      stores: storesWithTokens(900),
      sessionIdentities: () => [],
      providerForPaneKey: () => undefined,
      archiveSnapshot: {
        sessionIndexLookup: async () => [],
        transcriptCheck: async () => TRANSCRIPT_CHECK
      }
    })

    bindWorkspace(rt)
    archive(rt)

    const measured = bindingNow(rt)
    expect(measured.usageSettlement).toMatchObject({
      kind: 'known',
      providers: [{ provider: 'claude', tokens: 900, costUsd: 0.5 }]
    })

    // Another metadata touch of the archived binding must not drop or relabel it.
    recordTaskRecordsForWorktree(context(rt), ID, { ...meta({ isArchived: true }), isPinned: true })
    expect(bindingNow(rt).usageSettlement).toEqual(measured.usageSettlement)

    // A load reads it back byte-for-byte: the absence widening did not change how a
    // measured settlement is persisted, so no schema version is involved.
    const reloaded = normalizeTaskRecords(rt.state.taskRecords)
    expect(reloaded.readable).toBe(true)
    expect(reloaded.state.byId[TASK_ID]?.bindings[0]?.usageSettlement).toEqual(
      measured.usageSettlement
    )
  })

  it('keeps the three states apart: absent, unavailable with a reason, and a number', () => {
    const archived = (source: TaskRecordsUsageSource) => {
      const rt = runtime()
      rt.taskRecordsUsageSource = source
      bindWorkspace(rt)
      archive(rt)
      return bindingNow(rt).usageSettlement
    }
    const archiveDeps = {
      sessionIndexLookup: async () => [],
      transcriptCheck: async () => TRANSCRIPT_CHECK
    }
    const deps = { sessionIdentities: () => [], providerForPaneKey: () => undefined }

    // No store set: absent — the archive reader renders this as "unattributed", never 0
    // (`task-workbench-history-settlement.ts`).
    const absent = archived(createTaskRecordsUsageSource({ ...deps, archiveSnapshot: archiveDeps }))
    // A store set whose scan is off: `unavailable` with the enum's own reason.
    const unavailable = archived(
      createTaskRecordsUsageSource({
        ...deps,
        stores: storesWithTokens(900, false),
        archiveSnapshot: archiveDeps
      })
    )
    // A measured rollup: a number.
    const known = archived(
      createTaskRecordsUsageSource({
        ...deps,
        stores: storesWithTokens(900),
        archiveSnapshot: archiveDeps
      })
    )

    expect(absent).toBeUndefined()
    expect(unavailable).toMatchObject({ kind: 'unavailable', reason: 'usage_not_enabled' })
    expect(known).toMatchObject({ kind: 'known' })
  })
})
