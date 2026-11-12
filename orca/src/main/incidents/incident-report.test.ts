/**
 * `orca incident report` core (§7.5): class+code mandatory, idempotent by source id, redacted, and
 * evidence pointers that are verified rather than trusted.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import {
  EvidenceFileError,
  MAX_EVIDENCE_BYTES,
  buildSelfReportRecord,
  evidencePointerForFile,
  recordSelfReportTo
} from './incident-report'
import { shadowFilePath } from './incident-shadow'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): { dir: string; userDataPath: string; store: IncidentStore; opened: OpenIncidentsDatabase } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-report-'))
  directories.push(dir)
  const userDataPath = join(dir, 'user-data')
  const opened = openIncidentsDatabase(join(userDataPath, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    dir,
    userDataPath,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    opened
  }
}

afterEach(() => {
  for (const opened of databases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('buildSelfReportRecord', () => {
  it('requires a class and a code', () => {
    expect(() => buildSelfReportRecord({ class: 'nope' as never, code: 'x' })).toThrow(
      /invalid_incident_class/
    )
    expect(() => buildSelfReportRecord({ class: 'tool_error', code: '   ' })).toThrow(
      /missing_incident_code/
    )
  })

  it('starts untriaged and says it is unverified', () => {
    const record = buildSelfReportRecord({ class: 'tool_error', code: 'tool_schema_mismatch' })
    expect(record).toMatchObject({
      sourceKind: 'self_report',
      facet: 'report',
      class: 'tool_error',
      status: 'untriaged',
      exitCause: null
    })
    expect(record.evidence.unknownBoundaries.join(' ')).toMatch(/T3/)
    expect(record.evidence.unknownBoundaries.join(' ')).toMatch(/未附证据指针/)
    expect(record.evidence.code).toBe('tool_schema_mismatch')
    expect(record.summary).toBe('tool_schema_mismatch')
  })

  it('uses the request id by default and pins it when given', () => {
    const first = buildSelfReportRecord({ class: 'crash', code: 'c' })
    const second = buildSelfReportRecord({ class: 'crash', code: 'c' })
    expect(first.sourceId).not.toBe(second.sourceId)
    const pinned = buildSelfReportRecord({ class: 'crash', code: 'c', sourceId: 'req-1' })
    expect(pinned.sourceId).toBe('req-1')
  })

  it('clusters by code, not by source id', () => {
    const a = buildSelfReportRecord({ class: 'tool_error', code: 'x', sourceId: 'a' })
    const b = buildSelfReportRecord({ class: 'tool_error', code: 'x', sourceId: 'b' })
    const c = buildSelfReportRecord({ class: 'tool_error', code: 'y', sourceId: 'c' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
  })
})

describe('evidencePointerForFile', () => {
  it('stores the digest and the size of a real file', () => {
    const { dir } = fixture()
    const path = join(dir, 'agent.log')
    writeFileSync(path, 'line one\nline two\n')
    const pointer = evidencePointerForFile(path)
    expect(pointer).toMatchObject({
      kind: 'transcript',
      path,
      bytes: 18,
      sha256: createHash('sha256').update('line one\nline two\n').digest('hex')
    })
  })

  it('refuses a missing file and a directory instead of storing a fake pointer', () => {
    const { dir } = fixture()
    expect(() => evidencePointerForFile(join(dir, 'nope.log'))).toThrow(EvidenceFileError)
    expect(() => evidencePointerForFile(dir)).toThrow(/evidence_not_a_file/)
  })

  it('refuses an oversized file with a typed error instead of skipping it (M2-C5)', () => {
    const { dir } = fixture()
    const path = join(dir, 'huge.log')
    // Sparse: 64 MiB + 1 byte without writing 64 MiB of data.
    writeFileSync(path, '')
    truncateSync(path, MAX_EVIDENCE_BYTES + 1)
    expect(() => evidencePointerForFile(path)).toThrow(/evidence_too_large/)
  })
})

describe('recordSelfReportTo', () => {
  it('writes the row, the shadow line, and dedupes on a repeated source id', () => {
    const { userDataPath, store } = fixture()
    const first = recordSelfReportTo(
      store,
      { class: 'tool_error', code: 'tool_schema_mismatch', sourceId: 'req-1' },
      { userDataPath }
    )
    expect(first).toMatchObject({ outcome: 'inserted', shadow: 'written' })
    expect(store.countIncidents()).toBe(1)

    const again = recordSelfReportTo(
      store,
      { class: 'tool_error', code: 'tool_schema_mismatch', sourceId: 'req-1' },
      { userDataPath }
    )
    expect(again.outcome).toBe('duplicate')
    expect(again.id).toBe(first.id)
    expect(store.countIncidents()).toBe(1)

    const lines = readFileSync(shadowFilePath(userDataPath), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('redacts the summary before it reaches the row or the shadow', () => {
    const { userDataPath, store } = fixture()
    recordSelfReportTo(
      store,
      {
        class: 'tool_error',
        code: 'leaky',
        summary: 'token sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
        sourceId: 'req-2'
      },
      { userDataPath }
    )
    const row = store.listIncidents().incidents[0]
    expect(row.summary).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
    const shadow = readFileSync(shadowFilePath(userDataPath), 'utf8')
    expect(shadow).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
  })

  it('keeps evidence as pointers with digests, never contents', () => {
    const { dir, userDataPath, store } = fixture()
    const path = join(dir, 'agent.log')
    writeFileSync(path, 'a transcript body that must not be copied\n')
    recordSelfReportTo(
      store,
      {
        class: 'crash',
        code: 'worker_died',
        sourceId: 'req-3',
        evidencePointers: [evidencePointerForFile(path)]
      },
      { userDataPath }
    )
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.evidence.pointers).toHaveLength(1)
    expect(view.evidence.pointers[0].bytes).toBeGreaterThan(0)
    expect(view.evidence.pointers[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toContain('a transcript body')
  })
})
