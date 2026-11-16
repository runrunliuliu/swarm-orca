/**
 * The tool-failure cap and its `dropped` counter, stated as the invariants the code has to keep.
 *
 * The cap reads one authoritative `SELECT COUNT(*)`, so every case below is staged with real rows and
 * asserted against the rows the table actually holds:
 *   * below the cap an insert lands, and the same fact again is a `duplicate` that adds no row and
 *     moves no counter — a duplicate consumed no capacity, so it is not evidence lost;
 *   * at the cap a repeat of a recorded fact is still a `duplicate` and leaves `tool_failure_dropped`
 *     exactly where it was (`4023fc96`'s fix: capacity did not refuse it, it was already recorded);
 *   * at the cap a genuinely new fact is `dropped` and bumps `tool_failure_dropped` exactly once;
 *   * prune deletes expired rows and the cap still refuses after it — the count follows the table, so
 *     there is no stored number left to repair.
 *
 * The cap boundary is staged by inserting MAX_TOOL_FAILURE_ROWS rows in one statement (a recursive CTE
 * `INSERT … SELECT`), never by writing a meta key: the count is read from the table, so only rows can
 * put the table at its cap.
 */
import { describe, expect, it } from 'vitest'
import { closeStorePairs, openStorePair } from './incident-test-fixture'
import { readMeta, writeMeta } from './incident-store-meta'
import {
  MAX_TOOL_FAILURE_ROWS,
  TOOL_FAILURE_DROPPED_META,
  TOOL_FAILURE_LAST_PRUNE_META,
  TOOL_FAILURE_RETENTION_MS,
  recordToolFailure,
  type ToolFailureFact
} from './incident-tool-failures'

const NOW = 1_700_000_000_000

type TestDb = ReturnType<typeof openStorePair>['opened']['db']

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
function realCount(db: TestDb): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM incident_tool_failures').get()
  return row ? Number(row.n ?? 0) : 0
}

/**
 * Add `count` live rows in ONE statement, so the cap's real boundary is staged by the rows the cap
 * counts. A recursive CTE builds the numbers and `INSERT … SELECT` is a single statement (one implicit
 * transaction): one write, not `count` calls to `recordToolFailure`.
 *
 * The staged facts are `session_id = 'bulk'`, `item_key = 'item-<n>'`, `ordinal = 0`, so a case can name
 * one of them as "already recorded" instead of guessing at the live rows it also inserted.
 */
function fillTo(db: TestDb, count: number): void {
  db.prepare(
    `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     INSERT INTO incident_tool_failures
       (session_id, item_key, ordinal, turn, tool_name, error_kind, exit_code, observed_at)
     SELECT 'bulk', 'item-' || n, 0, 'thread', 'bash', NULL, NULL, ?
       FROM seq`
  ).run(count, NOW)
}

describe('tool-failure cap', () => {
  it('inserts below the cap, and a repeat adds no row and is not counted as lost', () => {
    const { opened } = openStorePair()

    expect(recordToolFailure(opened.db, fact())).toBe('inserted')
    expect(recordToolFailure(opened.db, fact({ ordinal: 1 }))).toBe('inserted')
    expect(realCount(opened.db)).toBe(2)

    // The same fact twice: `INSERT OR IGNORE` changes no row, so the table still holds two and no
    // capacity was consumed — `dropped` must stay absent, because nothing was refused.
    expect(recordToolFailure(opened.db, fact())).toBe('duplicate')
    expect(realCount(opened.db)).toBe(2)
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBeNull()

    closeStorePairs()
  })

  it('at the cap, repeats a recorded fact as `duplicate` and only a new fact as `dropped`', () => {
    const { opened } = openStorePair()
    // The real boundary: the table really holds MAX_TOOL_FAILURE_ROWS rows, which is what the cap reads.
    fillTo(opened.db, MAX_TOOL_FAILURE_ROWS)
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)
    // A `dropped` counter that already has a value, so "unchanged" is an exact number and not just null.
    writeMeta(opened.db, TOOL_FAILURE_DROPPED_META, '7')

    // `bulk/item-1/0` is one of the staged rows: capacity did not refuse it, it was already recorded.
    const recorded = fact({ sessionId: 'bulk', itemKey: 'item-1' })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(recordToolFailure(opened.db, recorded)).toBe('duplicate')
    }
    // Nothing was lost to capacity, and no duplicate row appeared. Before `4023fc96` this path
    // returned `dropped` and inflated the operator-facing counter.
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBe('7')
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)

    // A genuinely new fact is the only thing the cap may refuse, and it is counted exactly once.
    expect(recordToolFailure(opened.db, fact({ itemKey: 'not-staged' }))).toBe('dropped')
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBe('8')
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)

    // The refusal changed nothing either: the same new fact is refused again, never inserted.
    expect(recordToolFailure(opened.db, fact({ itemKey: 'not-staged' }))).toBe('dropped')
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)

    closeStorePairs()
  })

  it('prunes expired rows, and the cap still refuses after the prune', () => {
    const { opened } = openStorePair()
    // Mark the prune as just-run, so staging the expired row does not immediately delete it.
    writeMeta(opened.db, TOOL_FAILURE_LAST_PRUNE_META, String(NOW))
    // One expired row plus one live row: the next call's prune deletes exactly one.
    recordToolFailure(
      opened.db,
      fact({ observedAt: NOW - TOOL_FAILURE_RETENTION_MS - 1_000, itemKey: 'expired' })
    )
    recordToolFailure(opened.db, fact())
    expect(realCount(opened.db)).toBe(2)

    // Force the next call through the prune path (the interval is otherwise 60 s of wall clock).
    writeMeta(opened.db, TOOL_FAILURE_LAST_PRUNE_META, '0')
    expect(recordToolFailure(opened.db, fact({ ordinal: 1 }))).toBe('inserted')
    // The DELETE took the expired row and the insert added one: two rows left, and those two rows are
    // the count the cap reads — no stored number to repair, none to fall out of step.
    expect(realCount(opened.db)).toBe(2)
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBeNull()

    // Fill to the cap with rows, then confirm refusal still works against the post-prune table.
    fillTo(opened.db, MAX_TOOL_FAILURE_ROWS - realCount(opened.db))
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)
    expect(recordToolFailure(opened.db, fact({ ordinal: 2 }))).toBe('dropped')
    expect(readMeta(opened.db, TOOL_FAILURE_DROPPED_META)).toBe('1')
    expect(realCount(opened.db)).toBe(MAX_TOOL_FAILURE_ROWS)

    closeStorePairs()
  })
})
