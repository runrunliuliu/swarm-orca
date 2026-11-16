/**
 * The tool-failure cap's row accounting (A2): the cap is decided by the durable `tool_failure_rows`
 * counter, not by a `SELECT COUNT(*)` on the journal append path.
 *
 * What has to stay true, and why each case exists:
 *   * an insert increments the counter — otherwise the cap never closes;
 *   * a duplicate does not — `INSERT OR IGNORE` added no row, so counting it would drift the counter
 *     high and drop new facts early (the failure mode trae called out);
 *   * prune recounts after its DELETE — the one place the table shrinks;
 *   * a store written before this counter existed recovers from a real count on first use, and the
 *     counter survives a close/reopen (a durable fact, not process state);
 *   * the cap still refuses with the same `dropped` counter, unchanged.
 */
import { describe, expect, it } from 'vitest'
import { closeStorePairs, databasePath, openStorePair } from './incident-test-fixture'
import { openIncidentsDatabase } from './incidents-database'
import { readMeta, writeMeta } from './incident-store-meta'
import {
  MAX_TOOL_FAILURE_ROWS,
  TOOL_FAILURE_DROPPED_META,
  TOOL_FAILURE_LAST_PRUNE_META,
  TOOL_FAILURE_RETENTION_MS,
  TOOL_FAILURE_ROWS_META,
  recordToolFailure,
  type ToolFailureFact
} from './incident-tool-failures'

const NOW = 1_700_000_000_000

function fact(overrides: Partial<ToolFailureFact> = {}): ToolFailureFact {
  return {
    sessionId: 'session-1',
    itemKey: 'item-1',
    ordinal: 0,
    turn: 'thread',
    toolName: 'bash',
    errorKind: 'permission_denied',
    exitCode: null,
    observedAt: NOW,
    ...overrides
  }
}

/** Rows actually in the table, read the slow way: the assertion, never the implementation. */
function realCount(db: ReturnType<typeof openStorePair>['opened']['db']): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM incident_tool_failures').get()
  return row ? Number(row.n ?? 0) : 0
}

function rowsMeta(db: ReturnType<typeof openStorePair>['opened']['db']): number {
  return Number(readMeta(db, TOOL_FAILURE_ROWS_META) ?? -1)
}

describe('tool-failure row counter', () => {
  it('increments on insert and leaves the counter alone on a duplicate', () => {
    const { opened } = openStorePair()

    expect(recordToolFailure(opened.db, fact())).toBe('inserted')
    expect(rowsMeta(opened.db)).toBe(1)
    expect(recordToolFailure(opened.db, fact({ ordinal: 1 }))).toBe('inserted')
    expect(rowsMeta(opened.db)).toBe(2)

    // The same fact twice: `INSERT OR IGNORE` changes no row, so the counter must not move either.
    expect(recordToolFailure(opened.db, fact())).toBe('duplicate')
    expect(rowsMeta(opened.db)).toBe(2)
    expect(realCount(opened.db)).toBe(2)

    closeStorePairs()
  })

  it('does not drift high on duplicate traffic, so the cap does not drop early', () => {
    const { opened } = openStorePair()
    recordToolFailure(opened.db, fact())
    // One row below the cap: a duplicate that incremented the counter would now report `dropped`.
    writeMeta(opened.db, TOOL_FAILURE_ROWS_META, String(MAX_TOOL_FAILURE_ROWS - 1))

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(recordToolFailure(opened.db, fact())).toBe('duplicate')
    }
    expect(rowsMeta(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS - 1)

    // A genuinely new fact still fits under the cap; nothing was refused because of duplicate drift.
    expect(recordToolFailure(opened.db, fact({ ordinal: 1 }))).toBe('inserted')
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBeNull()
    expect(realCount(opened.db)).toBe(2)

    closeStorePairs()
  })

  it('refreshes from a real count after prune, and the cap still refuses with `dropped`', () => {
    const { opened } = openStorePair()
    // Mark the prune as just-run, so staging the expired row does not immediately delete it.
    writeMeta(opened.db, TOOL_FAILURE_LAST_PRUNE_META, String(NOW))
    // One expired row plus one live row: the next call's prune deletes exactly one.
    recordToolFailure(
      opened.db,
      fact({ observedAt: NOW - TOOL_FAILURE_RETENTION_MS - 1_000, itemKey: 'expired' })
    )
    recordToolFailure(opened.db, fact())
    expect(rowsMeta(opened.db)).toBe(2)

    // Force the next call through the prune path (the interval is otherwise 60 s of wall clock).
    writeMeta(opened.db, TOOL_FAILURE_LAST_PRUNE_META, '0')
    expect(recordToolFailure(opened.db, fact({ ordinal: 1 }))).toBe('inserted')
    // The DELETE took one row, the recount saw one, and this insert made two.
    expect(realCount(opened.db)).toBe(2)
    expect(rowsMeta(opened.db)).toBe(2)

    // Cap semantics are unchanged: at the cap a new fact is refused and counted, not inserted.
    writeMeta(opened.db, TOOL_FAILURE_ROWS_META, String(MAX_TOOL_FAILURE_ROWS))
    expect(recordToolFailure(opened.db, fact({ ordinal: 2 }))).toBe('dropped')
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBe('1')
    expect(realCount(opened.db)).toBe(2)

    closeStorePairs()
  })

  it('recovers from a real count when the key is absent (a store written before this counter)', () => {
    const { opened, userData } = openStorePair()
    recordToolFailure(opened.db, fact())
    recordToolFailure(opened.db, fact({ ordinal: 1 }))
    // Simulate the pre-A2 file: rows present, no counter key.
    opened.db.prepare('DELETE FROM incident_store_meta WHERE key = ?').run(TOOL_FAILURE_ROWS_META)
    expect(readMeta(opened.db, TOOL_FAILURE_ROWS_META)).toBeNull()

    expect(recordToolFailure(opened.db, fact({ ordinal: 2 }))).toBe('inserted')
    expect(rowsMeta(opened.db)).toBe(3)

    // Durable across a close/reopen: the counter is a fact in the file, not process state.
    opened.db.close()
    const reopened = openIncidentsDatabase(databasePath(userData))
    expect(rowsMeta(reopened.db)).toBe(3)
    expect(recordToolFailure(reopened.db, fact({ ordinal: 3 }))).toBe('inserted')
    expect(rowsMeta(reopened.db)).toBe(4)
    expect(realCount(reopened.db)).toBe(4)
    reopened.db.close()

    closeStorePairs()
  })
})
