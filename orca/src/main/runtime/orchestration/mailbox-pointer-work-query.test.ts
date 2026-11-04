import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('mailbox pointer eligible-work query', () => {
  it.each([
    {
      type: 'worker_done',
      read: 0,
      delivered: null,
      phase: 0,
      contract: 'current_delivery',
      expected: true
    },
    {
      type: 'status',
      read: 0,
      delivered: null,
      phase: 0,
      contract: 'current_delivery',
      expected: false
    },
    {
      type: 'worker_done',
      read: 1,
      delivered: null,
      phase: 0,
      contract: 'current_delivery',
      expected: false
    },
    {
      type: 'worker_done',
      read: 0,
      delivered: '2026-01-01',
      phase: 0,
      contract: 'current_delivery',
      expected: false
    },
    {
      type: 'worker_done',
      read: 0,
      delivered: null,
      phase: 0,
      contract: 'legacy_direct',
      expected: false
    },
    ...[1, 2, 3].map((phase) => ({
      type: 'status',
      read: 0,
      delivered: '2026-01-01',
      phase,
      contract: 'current_delivery',
      expected: true
    })),
    {
      type: 'status',
      read: 1,
      delivered: null,
      phase: 1,
      contract: 'current_delivery',
      expected: false
    },
    { type: 'status', read: 0, delivered: null, phase: 1, contract: 'audit_only', expected: false }
  ])('filters consumed/excluded rows but preserves reservations: %j', (row) => {
    const db = new OrchestrationDb(':memory:')
    try {
      expect(db.hasMailboxPointerWork('run:target', [])).toBe(false)
      db.db
        .prepare(`INSERT INTO messages
        (id, from_handle, to_handle, subject, type, read, delivered_at, pointer_enter_pending, delivery_contract)
        VALUES ('message', 'sender', 'run:target', 'test', ?, ?, ?, ?, ?)`)
        .run(row.type, row.read, row.delivered, row.phase, row.contract)
      expect(db.hasMailboxPointerWork('run:target', ['status', 'question'])).toBe(row.expected)
      expect(db.hasMailboxPointerWork('run:other', [])).toBe(false)
    } finally {
      db.close()
    }
  })
})
