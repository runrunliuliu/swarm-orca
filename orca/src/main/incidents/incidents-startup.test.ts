/**
 * The startup mount point's contract (§11.2, §14): one attempt per process, deferred off the
 * startup path, and every outcome visible as a log line instead of an exception.
 *
 * It also carries the "starting Orca is not using the feature" claim (review A3): on a host that
 * never wrote an incident, neither the replay nor the archive drain tick may create
 * `<userData>/incidents/incidents.db` — and a store a real write creates later in the same process
 * must still be seen, which is why the drain asks the "if present" resolver.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import type * as IncidentArchiveModule from './incident-archive'
import { initDataPath } from '../persistence/loading-store/user-data-path'
import { appendShadowRecord } from './incident-shadow'
import { incidentsDatabaseFileFor, incidentsDirectoryFor } from './incidents-paths'
import type { PtyExitIncidentFacts } from './incident-pty-exit'
import {
  __resetIncidentWriterForTests,
  incidentRuntimeStoreIfPresent,
  recordPtyExitIncident,
  resetIncidentStoreCache
} from './incident-writer'
import {
  __resetIncidentShadowStartupForTests,
  reconcileIncidentShadowAtStartup,
  scheduleIncidentShadowReconcile,
  startEvidenceArchiveDrain
} from './incidents-startup'

/** Counts the drain turns that actually reached a store; the file work is tested elsewhere. */
const archiveDrain = vi.hoisted(() => ({ calls: 0 }))

vi.mock('./incident-archive', async (importOriginal) => {
  const original = await importOriginal<typeof IncidentArchiveModule>()
  return {
    ...original,
    drainEvidenceArchive: (
      options: Parameters<typeof IncidentArchiveModule.drainEvidenceArchive>[0]
    ) => {
      archiveDrain.calls += 1
      return original.drainEvidenceArchive(options)
    }
  }
})

const directories: string[] = []

/** Install a temp user-data directory as the process's canonical one, as a real startup does. */
function freshUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-startup-'))
  directories.push(directory)
  setAppEnvironment({
    getPath: (name) => {
      if (name !== 'userData') {
        throw new Error(`unexpected app path: ${name}`)
      }
      return directory
    },
    getAppPath: () => directory,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => undefined,
    exit: () => undefined,
    getAppMetrics: () => []
  })
  initDataPath()
  __resetIncidentWriterForTests()
  return directory
}

function ptyExitFacts(): PtyExitIncidentFacts {
  return {
    ptyId: 'wt-1__pty-1',
    incarnationId: 'ptyinc-startup-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agentSessionId: null,
    agentIdentityDigest: null,
    exitCode: 137,
    exitCause: { kind: 'signaled', signal: 9 },
    hostExitConfirmed: true,
    providerExitObserved: true,
    surface: 'local',
    hasAgentBinding: true
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  __resetIncidentShadowStartupForTests()
  resetIncidentStoreCache()
  __resetIncidentWriterForTests()
  archiveDrain.calls = 0
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('reconcileIncidentShadowAtStartup', () => {
  it('reports a missing user-data path instead of throwing or staying silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = reconcileIncidentShadowAtStartup({ userDataPath: null })
    expect(result).toEqual({ ran: false, reason: 'no_user_data_path' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('shadow replay skipped')
  })

  it('attempts once per process, so a double mount cannot replay twice', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(reconcileIncidentShadowAtStartup({ userDataPath: null }).ran).toBe(false)
    expect(reconcileIncidentShadowAtStartup({ userDataPath: null })).toEqual({
      ran: false,
      reason: 'already_reconciled'
    })
  })

  it('does not create the incidents database on a host that never had a shadow', () => {
    const userData = freshUserData()
    const database = incidentsDatabaseFileFor(userData)
    expect(existsSync(database)).toBe(false)

    // The replay reads the hint family first; with no file there is nothing to replay, so it never
    // resolves the store — which is what used to create the directory, run the schema and harden
    // files as a side effect of merely starting Orca.
    expect(reconcileIncidentShadowAtStartup({ userDataPath: userData })).toEqual({
      ran: false,
      reason: 'no_shadow_file'
    })
    expect(existsSync(database)).toBe(false)
    expect(existsSync(incidentsDirectoryFor(userData))).toBe(false)
  })

  it('still replays when a shadow file exists, so the guard is not a blanket skip', () => {
    const userData = freshUserData()
    const database = incidentsDatabaseFileFor(userData)
    appendShadowRecord(userData, {
      id: 'inc_shadow_startup_1',
      sourceKind: 'pty_exit',
      sourceId: 'ptyinc-shadow-startup-1',
      facet: 'exit',
      hostId: 'host-a',
      worktreeId: 'wt-1',
      runId: null,
      taskId: null,
      dispatchId: null,
      agentSessionId: null,
      ptyIncarnationId: 'ptyinc-shadow-startup-1',
      class: 'crash',
      status: 'untriaged',
      exitCause: { kind: 'signaled', signal: 9 },
      fingerprint: 'f'.repeat(64),
      evidence: { pointers: [], unknownBoundaries: [] },
      summary: 'agent killed by signal 9',
      createdAt: 1_700_000_000_000
    })

    const result = reconcileIncidentShadowAtStartup({ userDataPath: userData })
    expect(result.ran).toBe(true)
    expect(result.summary?.replayed).toBe(1)
    expect(result.summary?.inserted).toBe(1)
    expect(existsSync(database)).toBe(true)
  })
})

describe('scheduleIncidentShadowReconcile', () => {
  it('returns immediately and runs one deferred turn, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = Date.now()
    expect(() => scheduleIncidentShadowReconcile(null)).not.toThrow()
    // The call itself is a scheduling hop, not the work: no readable evidence it ran yet…
    expect(Date.now() - started).toBeLessThan(1000)
    // …until the event loop turns.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(warn).toHaveBeenCalled()
  })
})

describe('startEvidenceArchiveDrain on a host that never wrote an incident (A3)', () => {
  it('creates no store: the tick is a no-op while the database is absent', () => {
    const userData = freshUserData()
    const database = incidentsDatabaseFileFor(userData)
    vi.useFakeTimers()

    expect(startEvidenceArchiveDrain({ intervalMs: 1_000 })).toBe(true)
    vi.advanceTimersByTime(3_000)

    expect(archiveDrain.calls).toBe(0)
    expect(incidentRuntimeStoreIfPresent()).toBeNull()
    expect(existsSync(database)).toBe(false)
    expect(existsSync(incidentsDirectoryFor(userData))).toBe(false)
  })

  it('drains a store a real write created later in the same process', () => {
    const userData = freshUserData()
    const database = incidentsDatabaseFileFor(userData)
    vi.useFakeTimers()
    expect(startEvidenceArchiveDrain({ intervalMs: 1_000 })).toBe(true)

    vi.advanceTimersByTime(1_000)
    expect(archiveDrain.calls).toBe(0)
    expect(existsSync(database)).toBe(false)

    // A real write resolves the process-wide store, which creates the database. "If present" does
    // not cache absence, so the very next tick must see it instead of hiding it for the process's
    // whole life.
    expect(() => recordPtyExitIncident(ptyExitFacts())).not.toThrow()
    expect(existsSync(database)).toBe(true)

    vi.advanceTimersByTime(1_000)
    expect(archiveDrain.calls).toBe(1)
  })
})
