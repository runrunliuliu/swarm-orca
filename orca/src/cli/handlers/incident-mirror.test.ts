/**
 * `orca incident mirror` at the process boundary (issue-sedimentation.md §11.1, M7-C).
 *
 * The command is the operator-visible half of the three-state answer, and its most important case is
 * the one with no store at all: it must say "no origin host is registered" instead of printing an
 * empty, healthy-looking mirror list — and it must not create the incidents directory to find that out.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../main/incidents/incidents-database'
import { createIncidentStore } from '../../main/incidents/incident-store'
import { incidentsDatabaseFileFor } from '../../main/incidents/incidents-paths'
import {
  ensureMirrorLink,
  recordMirrorProbeFailure,
  recordMirrorProbeSuccess
} from '../../main/incidents/incident-mirror-store'
import { INCIDENT_HANDLERS } from './incident'

let userData: string
let opened: OpenIncidentsDatabase | null = null
let previousUserDataPath: string | undefined

function context(flags: Record<string, string | boolean> = {}, json = false) {
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map((arg) => String(arg)).join(' '))
  })
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    client: {} as HandlerContext['client'],
    cwd: userData,
    json
  }
  return { ctx, output }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-incident-mirror-cli-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userData
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  try {
    opened?.db.close()
  } catch {
    // Already closed.
  }
  opened = null
  rmSync(userData, { recursive: true, force: true })
})

describe('incident mirror', () => {
  it('says no origin is registered and creates nothing on disk', async () => {
    const { ctx, output } = context()
    await INCIDENT_HANDLERS['incident mirror'](ctx)
    const text = output.join('\n')
    expect(text).toContain('No origin host is registered with this store.')
    expect(text).toContain('NOT evidence')
    expect(existsSync(incidentsDatabaseFileFor(userData))).toBe(false)
    expect(existsSync(join(userData, 'incidents'))).toBe(false)
  })

  it('reports a registered-but-unreachable origin as not_probed with an unknown unsynced count', async () => {
    opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
    ensureMirrorLink(opened.db, 'host-b', 1_700_000_000_000)
    recordMirrorProbeFailure(opened.db, {
      hostId: 'host-b',
      now: 1_700_000_000_000,
      error: 'feed_error: relay closed',
      lines: 0,
      ms: 1
    })

    const { ctx, output } = context()
    await INCIDENT_HANDLERS['incident mirror'](ctx)
    const text = output.join('\n')
    expect(text).toContain('Capture: not_probed')
    expect(text).toContain('host-b  not_probed  cursor=0  unsynced=unknown')
    expect(text).toContain('last_error=feed_error: relay closed')
    expect(text).toContain('has never been read')
  })

  it('emits JSON keyed by the database it read', async () => {
    opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
    ensureMirrorLink(opened.db, 'host-b', 1_700_000_000_000)
    recordMirrorProbeSuccess(opened.db, {
      hostId: 'host-b',
      now: 1_700_000_000_000,
      cursor: 9,
      pending: 2,
      inserted: 9,
      duplicates: 0,
      rejected: 0,
      dropped: 0,
      pruned: 0,
      skippedRows: 0,
      skippedRanges: 0,
      lastSkippedReason: null,
      lastRejectedReason: null,
      lines: 9,
      ms: 1
    })

    const { ctx, output } = context({}, true)
    await INCIDENT_HANDLERS['incident mirror'](ctx)
    const parsed = JSON.parse(output.join('\n')) as {
      path: string
      readAt: number
      mirror: { capture: string; unsynced: number; hosts: { hostId: string; lastCursor: number }[] }
    }
    expect(parsed.path).toBe(incidentsDatabaseFileFor(userData))
    expect(parsed.mirror.capture).toBe('mirrored')
    expect(parsed.mirror.unsynced).toBe(2)
    expect(parsed.mirror.hosts[0]).toMatchObject({ hostId: 'host-b', lastCursor: 9 })
  })
})
