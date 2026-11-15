/**
 * Evidence externalisation (M8-4): the two properties the tmpdir suite and the real-filesystem drill
 * left unpinned.
 *
 *  1. **Directory privacy (G3).** `mkdirSync(..., { recursive: true })` without a `mode` inherits the
 *     process umask, so evidence directories landed 0755 under the common 022 while the excerpt was
 *     0600: the run / host / incident ids in the path were world-traversable (drill finding F1). The
 *     drain now asks for 0700, verifies the whole owned chain, and refuses to archive into a
 *     directory it cannot make private. The root itself is deployment input and stays untouched.
 *  2. **Durability (G4).** `archived` used to follow a same-process `readFileSync` of a file this
 *     process had just written: no fsync, so it proved a round-trip through this client's cache. The
 *     drain now writes a 0600 temp file, fsyncs it, renames it into place (shared helper, which also
 *     fsyncs the containing directory) and only then does the hash read-back.
 *
 * The umask test is the one that would have caught G3: it fails on the old code, where the mode came
 * from the environment rather than from the writer.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import {
  drainEvidenceArchive,
  readEvidenceArchiveState,
  stageIncidentEvidence
} from './incident-archive'

const NOW = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

/** The mode bits of a path, ignoring the file-type bits. */
function mode(path: string): number {
  return statSync(path).mode & 0o777
}

/**
 * Every directory strictly between the archive root and the archived file, deepest first.
 * A tmpdir cannot reproduce a shared NAS, but it can prove which modes the writer *sets*.
 */
function ownedDirectories(root: string, target: string): string[] {
  const owned: string[] = []
  let current = dirname(target)
  while (current.startsWith(root) && current !== root) {
    owned.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return owned
}

function pair(): { opened: OpenIncidentsDatabase; userData: string } {
  const userData = mkdtempSync(join(tmpdir(), 'orca-incident-archive-durable-'))
  directories.push(userData)
  const database = openIncidentsDatabase(join(userData, 'incidents', 'incidents.db'))
  opened.push(database)
  return { opened: database, userData }
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_1',
    sourceKind: 'self_report',
    sourceId: 'src-1',
    facet: 'report',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: 'run-1',
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'tool_error',
    status: 'untriaged',
    exitCause: null,
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'reported',
    createdAt: NOW,
    ...overrides
  }
}

function staged(): { db: OpenIncidentsDatabase; root: string } {
  const { opened: database, userData } = pair()
  createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(
    record()
  )
  const path = join(userData, 'transcript.jsonl')
  writeFileSync(path, 'evidence body\n')
  stageIncidentEvidence({
    db: database.db,
    incidentId: 'inc_1',
    pointers: [{ kind: 'transcript', path }],
    userDataPath: userData,
    now: NOW
  })
  return { db: database, root: join(userData, 'archive') }
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    try {
      database.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('archive directory privacy (G3)', () => {
  it('creates the owned evidence chain 0700 and the excerpt 0600 under a permissive umask', () => {
    const { db, root } = staged()
    const previous = process.umask(0o022)
    try {
      expect(drainEvidenceArchive({ db: db.db, root, now: NOW })).toMatchObject({
        configured: true,
        archived: 1
      })
    } finally {
      process.umask(previous)
    }
    const [state] = readEvidenceArchiveState(db.db, 'inc_1')
    const target = state.archivePath as string
    expect(mode(target)).toBe(0o600)
    const owned = ownedDirectories(root, target)
    expect(owned.length).toBeGreaterThanOrEqual(3) // run-1 / incidents / inc_1
    for (const path of owned) {
      expect(mode(path)).toBe(0o700)
    }
    // The publication left no temp file behind, only the excerpt.
    expect(readdirSync(dirname(target))).toEqual(['0-excerpt.bin'])
  })

  it('tightens a directory an earlier build left wide instead of archiving into it', () => {
    const { db, root } = staged()
    const incidentDirectory = join(root, 'run-1', 'incidents', 'inc_1')
    // Exactly the pre-fix shape: 0755 components named after run and incident ids. `chmod` (not
    // `mkdir` mode) because this suite may run under a narrow umask, and the point is the resulting
    // bits, not who set them.
    for (const path of [join(root, 'run-1'), join(root, 'run-1', 'incidents'), incidentDirectory]) {
      mkdirSync(path, { recursive: true, mode: 0o755 })
      chmodSync(path, 0o755)
    }
    expect(mode(incidentDirectory)).toBe(0o755)

    expect(drainEvidenceArchive({ db: db.db, root, now: NOW })).toMatchObject({ archived: 1 })
    expect(mode(incidentDirectory)).toBe(0o700)
    expect(mode(join(root, 'run-1', 'incidents'))).toBe(0o700)
    expect(mode(join(root, 'run-1'))).toBe(0o700)
  })

  it('never rewrites the mode of the archive root, which is deployment input', () => {
    const { db, root } = staged()
    mkdirSync(root, { recursive: true, mode: 0o755 })
    chmodSync(root, 0o755)
    expect(mode(root)).toBe(0o755)

    expect(drainEvidenceArchive({ db: db.db, root, now: NOW })).toMatchObject({ archived: 1 })
    expect(mode(root)).toBe(0o755)
    const [state] = readEvidenceArchiveState(db.db, 'inc_1')
    for (const path of ownedDirectories(root, state.archivePath as string)) {
      expect(mode(path)).toBe(0o700)
    }
  })
})

describe('durable publication (G4)', () => {
  it('writes a temp file beside the target, never the target itself, before the read-back', () => {
    const { db, root } = staged()
    const seen: { targetExistedDuringWrite: boolean | null; sameDirectory: boolean | null } = {
      targetExistedDuringWrite: null,
      sameDirectory: null
    }
    const result = drainEvidenceArchive({
      db: db.db,
      root,
      now: NOW,
      write: (path, bytes) => {
        const target = join(root, 'run-1', 'incidents', 'inc_1', '0-excerpt.bin')
        seen.targetExistedDuringWrite = existsSync(target)
        seen.sameDirectory = dirname(path) === dirname(target)
        writeFileSync(path, bytes)
      }
    })
    expect(result).toMatchObject({ archived: 1, incomplete: 0, failed: 0 })
    // Publishing by rename means the destination is absent while the bytes are still being written.
    expect(seen.targetExistedDuringWrite).toBe(false)
    expect(seen.sameDirectory).toBe(true)
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archived')
  })

  it('keeps the pointer pending when the fsync barrier fails, and publishes nothing', () => {
    const { db, root } = staged()
    const result = drainEvidenceArchive({
      db: db.db,
      root,
      now: NOW,
      sync: () => {
        throw new Error('EIO')
      }
    })
    expect(result).toMatchObject({ archived: 0, failed: 1, remaining: 1 })
    const [state] = readEvidenceArchiveState(db.db, 'inc_1')
    expect(state.state).toBe('archive_pending')
    // No target and no orphaned temp: a failed barrier cannot leave a publishable excerpt behind.
    expect(readdirSync(join(root, 'run-1', 'incidents', 'inc_1'))).toEqual([])

    // The retry half: the next tick with a working barrier archives it.
    expect(drainEvidenceArchive({ db: db.db, root, now: NOW + 1_000 })).toMatchObject({
      archived: 1,
      remaining: 0
    })
  })
})
