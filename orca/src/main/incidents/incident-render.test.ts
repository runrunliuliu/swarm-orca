/**
 * The rendered markdown is the human-facing artifact (§9): it must always carry an unknown-boundary
 * section, must not invent mechanism analysis, and must be rebuildable from the row + decisions.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import { renderIncidentMarkdown } from './incident-render'
import type { IncidentRecord } from './incident-types'

const temporaryDirectories: string[] = []
const openDatabases: OpenIncidentsDatabase[] = []

function storeWith(record: IncidentRecord) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-render-'))
  temporaryDirectories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents.db'))
  openDatabases.push(opened)
  const store = createIncidentStore({ db: opened.db, now: () => 1_700_000_000_000 })
  store.insertIncident(record)
  return store
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_render_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'unknown', reason: 'stop_unverified' },
    fingerprint: 'a'.repeat(64),
    evidence: {
      pointers: [],
      unknownBoundaries: [
        'Stop was requested but no exit was observed: the process may still be alive.',
        'transcript pointer not collected'
      ]
    },
    summary: 'Agent process stop was requested but never confirmed; in worktree wt-1',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

afterEach(() => {
  for (const opened of openDatabases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('renderIncidentMarkdown', () => {
  it('renders every required section, including the unknown boundaries', () => {
    const store = storeWith(record())
    const markdown = renderIncidentMarkdown(store.getIncident('inc_render_1')!)
    for (const heading of [
      '## 1. 摘要',
      '## 2. 背景与预期',
      '## 3. 时间线',
      '## 4. 机制分析',
      '## 5. 未知边界',
      '## 6. 证据与 pin',
      '## 7. 防复发项',
      '## 决策记录'
    ]) {
      expect(markdown).toContain(heading)
    }
    expect(markdown).toContain('the process may still be alive')
    expect(markdown).toContain('kind=unknown, reason=stop_unverified')
    expect(markdown).toContain('ptyinc-1')
  })

  it('says "未填写" instead of inventing mechanism analysis or a guardrail', () => {
    const store = storeWith(record())
    const markdown = renderIncidentMarkdown(store.getIncident('inc_render_1')!)
    expect(markdown).toMatch(/## 4\. 机制分析\n\n未填写/)
    expect(markdown).toMatch(/## 7\. 防复发项\n\n未填写/)
  })

  it('flags an empty unknown section and unarchived evidence rather than hiding them', () => {
    const store = storeWith(record({ evidence: { pointers: [], unknownBoundaries: [] } }))
    const markdown = renderIncidentMarkdown(store.getIncident('inc_render_1')!)
    expect(markdown).toContain('未记录未知边界')
    expect(markdown).toContain('durable=false')
    expect(markdown).toContain('未记录证据指针')
  })

  it('lists decisions with actor and reason, and is stable across renders', () => {
    const store = storeWith(record())
    store.appendDecision({
      incidentId: 'inc_render_1',
      toStatus: 'watch',
      actor: 'alice',
      reason: 'waiting for the second occurrence',
      createdAt: 1_700_000_100_000
    })
    const view = store.getIncident('inc_render_1')!
    const first = renderIncidentMarkdown(view)
    const second = renderIncidentMarkdown(store.getIncident('inc_render_1')!)
    expect(first).toBe(second)
    expect(first).toContain('untriaged → watch')
    expect(first).toContain('alice')
    expect(first).toContain('`watch` (effective, 1 decision)')
  })

  it('renders evidence pointers with their offsets, never bodies', () => {
    const store = storeWith(
      record({
        evidence: {
          pointers: [
            {
              kind: 'transcript',
              path: '/tmp/example/transcript.jsonl',
              sha256: 'b'.repeat(64),
              startOffset: 10,
              endOffset: 20,
              lineWindow: 50,
              bytes: 12
            }
          ],
          unknownBoundaries: ['window beyond 20 lines was not read']
        }
      })
    )
    const markdown = renderIncidentMarkdown(store.getIncident('inc_render_1')!, {
      archive: {
        summary: {
          pointers: 1,
          staged: 0,
          pending: 0,
          archived: 1,
          incomplete: 0,
          durable: true
        },
        states: [
          {
            incidentId: 'inc_render_1',
            pointerIndex: 0,
            state: 'archived',
            stagingPath: '/tmp/example/staging/0-excerpt.bin',
            archivePath: '/tmp/archive/inc_render_1/0-excerpt.bin',
            sha256: 'b'.repeat(64),
            bytes: 12,
            error: null,
            createdAt: 1_700_000_000_000
          }
        ]
      }
    })
    expect(markdown).toContain('`/tmp/example/transcript.jsonl`')
    expect(markdown).toContain('10..20')
    // Digest and size read as one checkable pair (M2 pointers carry `bytes`).
    expect(markdown).toContain('| 12 |')
    // The archived column names the state the drain recorded, not a constant.
    expect(markdown).toContain('| archived |')
    expect(markdown).not.toContain('no (pointer only)')
  })

  it('declares a column for every cell the evidence row emits (F12)', () => {
    // The header used to list five columns while each row emitted six (kind, path, bytes, sha256,
    // offsets, archived), so every reader shifted `sha256` into `offsets` and `bytes` had no name.
    // Pinned as a whole table line: a header and a row must agree cell for cell.
    const store = storeWith(
      record({
        evidence: {
          pointers: [
            {
              kind: 'transcript',
              path: '/tmp/example/transcript.jsonl',
              sha256: 'b'.repeat(64),
              startOffset: 10,
              endOffset: 20,
              lineWindow: 50,
              bytes: 12
            }
          ],
          unknownBoundaries: []
        }
      })
    )
    const markdown = renderIncidentMarkdown(store.getIncident('inc_render_1')!)
    const evidenceHeader = '| kind | path | bytes | sha256 | offsets | archived |'
    const evidenceSeparator = '| --- | --- | --- | --- | --- | --- |'
    const evidenceRow =
      '| transcript | `/tmp/example/transcript.jsonl` | 12 | ' +
      `${'b'.repeat(64)} | 10..20 | not staged |`
    expect(markdown).toContain(evidenceHeader)
    expect(markdown).toContain(evidenceSeparator)
    expect(markdown).toContain(evidenceRow)
    // No archive detail supplied: the cell must not invent a state or a verdict.
    expect(markdown).toContain('| not staged |')
    expect(markdown).toContain('`durable` 未知')
  })

  it('says durable only when every pointer is archived', () => {
    const pointer = {
      kind: 'transcript' as const,
      path: '/tmp/example/transcript.jsonl',
      sha256: 'b'.repeat(64),
      bytes: 12
    }
    const store = storeWith(
      record({ evidence: { pointers: [pointer, { ...pointer, path: '/tmp/example/2.jsonl' }], unknownBoundaries: [] } })
    )
    const view = store.getIncident('inc_render_1')!

    const oneOfTwo = renderIncidentMarkdown(view, {
      archive: {
        summary: { pointers: 2, staged: 0, pending: 1, archived: 1, incomplete: 0, durable: false },
        states: [
          {
            incidentId: 'inc_render_1',
            pointerIndex: 0,
            state: 'archived',
            stagingPath: null,
            archivePath: '/tmp/archive/0.bin',
            sha256: 'b'.repeat(64),
            bytes: 12,
            error: null,
            createdAt: 1_700_000_000_000
          },
          {
            incidentId: 'inc_render_1',
            pointerIndex: 1,
            state: 'archive_pending',
            stagingPath: '/tmp/staging/1.bin',
            archivePath: null,
            sha256: 'b'.repeat(64),
            bytes: 12,
            error: null,
            createdAt: 1_700_000_000_000
          }
        ]
      }
    })
    expect(oneOfTwo).toContain('archived=1/2')
    expect(oneOfTwo).toContain('`durable=false`')
    expect(oneOfTwo).toContain('| pending |')

    // Every pointer archived, and the per-pointer column must agree with the verdict: a summary that
    // claims durability while the rows say `not staged` is exactly the disagreement this test exists for.
    const archivedState = (incidentId: string, pointerIndex: number) => ({
      incidentId,
      pointerIndex,
      state: 'archived' as const,
      stagingPath: null,
      archivePath: `/tmp/archive/${pointerIndex}.bin`,
      sha256: 'b'.repeat(64),
      bytes: 12,
      error: null,
      createdAt: 1_700_000_000_000
    })
    const both = renderIncidentMarkdown(view, {
      archive: {
        summary: { pointers: 2, staged: 0, pending: 0, archived: 2, incomplete: 0, durable: true },
        states: [archivedState('inc_render_1', 0), archivedState('inc_render_1', 1)]
      }
    })
    expect(both).toContain('`durable=true`')
    expect(both).not.toContain('archived=1/2')
    expect(both).not.toContain('no (pointer only)')
    // One header cell plus one cell per pointer: the column cannot disagree with the verdict.
    expect(both.match(/\| archived \|/g)).toHaveLength(3)
  })

  it('separates "no evidence offered" from "not archived"', () => {
    const noPointers = renderIncidentMarkdown(
      storeWith(record()).getIncident('inc_render_1')!,
      { archive: { summary: { pointers: 0, staged: 0, pending: 0, archived: 0, incomplete: 0, durable: false }, states: [] } }
    )
    expect(noPointers).toContain('没有证据指针')
    expect(noPointers).toContain('不是“归档失败”')
    expect(noPointers).not.toContain('证据未全部归档')
  })
})
