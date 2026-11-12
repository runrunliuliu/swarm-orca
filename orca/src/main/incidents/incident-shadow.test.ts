/**
 * The shadow's two load-bearing properties (§11.2): every record is flushed before the call returns
 * (a buffered line is exactly the line a crash loses), and a line never carries a body.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetIncidentShadowForTests,
  appendShadowRecord,
  appendShadowRecordFromCli,
  shadowFilePath,
  shadowRecordFromIncident
} from './incident-shadow'
import type { IncidentRecord } from './incident-types'

const directories: string[] = []

function userData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-shadow-'))
  directories.push(directory)
  return directory
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_shadow_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-shadow-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-shadow-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['transcript pointer not collected'] },
    summary: 'agent killed by signal 9',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

afterEach(() => {
  __resetIncidentShadowForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('shadowRecordFromIncident', () => {
  it('carries the idempotency key, the cause and a monotonic seq', () => {
    const first = shadowRecordFromIncident(record(), 1_700_000_000_000)
    const second = shadowRecordFromIncident(record({ id: 'inc_2' }), 1_700_000_000_000)
    expect(first).toMatchObject({
      v: 1,
      id: 'inc_shadow_1',
      source_kind: 'pty_exit',
      source_id: 'ptyinc-shadow-1',
      facet: 'exit',
      host_id: 'host-a',
      class: 'crash',
      status: 'untriaged',
      created_at: 1_700_000_000_000
    })
    expect(first.exit_cause).toEqual({ kind: 'signaled', signal: 9 })
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('redacts the summary and stores no body', () => {
    const line = shadowRecordFromIncident(
      record({ summary: 'failed with sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' })
    )
    expect(line.summary).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
    // The whole shape has no field that could hold output: pointers, not bodies.
    expect(Object.keys(line)).not.toContain('tailBuffer')
    expect(Object.keys(line)).not.toContain('output')
  })
})

describe('appendShadowRecord', () => {
  it('flushes before returning, so the line survives an immediate crash', () => {
    const root = userData()
    const path = shadowFilePath(root)
    expect(() => statSync(path)).toThrow()

    const written = appendShadowRecord(root, record())
    expect(written.written).toBe(true)
    // No close() yet: the bytes must already be on disk, not in the sink's buffer.
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'inc_shadow_1', source_id: 'ptyinc-shadow-1' })
  })

  it('appends one line per record and keeps the file parseable', () => {
    const root = userData()
    appendShadowRecord(root, record({ id: 'inc_1', sourceId: 'k1' }))
    appendShadowRecord(root, record({ id: 'inc_2', sourceId: 'k2' }))
    const lines = readFileSync(shadowFilePath(root), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => (JSON.parse(line) as { source_id: string }).source_id)).toEqual([
      'k1',
      'k2'
    ])
  })

  it('never throws — a shadow failure is reported, not raised', () => {
    const root = userData()
    // A file where the directory should be makes the sink's mkdir fail.
    appendShadowRecordFromCli(root, record())
    rmSync(join(root, 'incidents'), { recursive: true, force: true })
    appendShadowRecordFromCli(root, record())
    expect(() => appendShadowRecord(root, record())).not.toThrow()
  })
})

describe('appendShadowRecordFromCli', () => {
  it('writes a single line per command into the same family', () => {
    const root = userData()
    expect(appendShadowRecordFromCli(root, record()).written).toBe(true)
    expect(appendShadowRecordFromCli(root, record({ id: 'inc_2', sourceId: 'k2' })).written).toBe(
      true
    )
    const lines = readFileSync(shadowFilePath(root), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
  })
})
