import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPERATOR, strictCoordinatorHarness } from './strict-coordinator-test-fixture'
import { resultOf } from './orchestration-session-caller-test-fixture'

describe.each([false, true])('read-only pending inbox (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => h.close())

  it('filters before limiting and retains delivered, unACKed messages outside the history window', async () => {
    const run = await h.create()
    const terminal = `run:${run}`
    const insert = (subject: string) =>
      h.db.insertMessage({ from: OPERATOR, to: terminal, runId: run, subject })
    const old = insert('old pending')
    h.db.markAsDelivered([old.id])
    const history = Array.from({ length: 150 }, (_, i) => insert(`acked-${i}`))
    h.db.markAsRead(history.map((m) => m.id))
    h.db.insertMessage({
      from: OPERATOR,
      to: terminal,
      runId: run,
      subject: 'not actionable',
      deliveryContract: 'audit_only'
    })
    const before = h.db.getInbox(1000)
    h.nudge.mockClear()
    const query = () => h.call('orchestration.inbox', { terminal, pending: true, limit: 1 })
    const pending = resultOf(await query())
    expect(pending).toMatchObject({
      count: 1,
      filter: { mode: 'pending', terminal, deliveryContract: 'current_delivery' },
      messages: [{ id: old.id, read: 0, delivered_at: expect.any(String) }]
    })
    expect(resultOf(await query())).toEqual(pending)
    expect(h.db.getInbox(1000)).toEqual(before)
    expect(h.db.hasOutstandingMailboxDelivery(terminal)).toBe(false)
    expect(h.nudge).not.toHaveBeenCalled()
    const owner = h.db.getRun(run)
    if (!owner) {
      throw new Error('expected Run')
    }
    const delivery = h.db.getOrCreateMailboxDelivery({
      runId: run,
      mailboxHandle: terminal,
      consumerGeneration: owner.consumer_generation
    })
    if (!delivery) {
      throw new Error('expected outstanding delivery')
    }
    expect(resultOf(await query())).toEqual(pending)
    h.db.acknowledgeMailboxDelivery({
      runId: run,
      mailboxHandle: terminal,
      consumerGeneration: owner.consumer_generation,
      deliveryId: delivery.delivery.id
    })
    expect(resultOf(await query())).toMatchObject({ count: 0, messages: [] })
    const defaultHistory = resultOf(await h.call('orchestration.inbox', { terminal, limit: 100 }))
    expect(defaultHistory.count).toBe(100)
    expect(defaultHistory.filter).toBeUndefined()
  })

  it('keeps full pending windows valid, FIFO, scoped and bounded', async () => {
    const run = await h.create()
    const terminal = `run:${run}`
    const rows = Array.from({ length: 5 }, (_, i) =>
      h.db.insertMessage({ from: OPERATOR, to: terminal, runId: run, subject: `${i}` })
    )
    h.db.insertMessage({ from: OPERATOR, to: OPERATOR, runId: run, subject: 'other mailbox' })
    expect(
      resultOf(await h.call('orchestration.inbox', { terminal, pending: true, limit: 2 }))
    ).toMatchObject({ count: 2, messages: [{ id: rows[0]?.id }, { id: rows[1]?.id }] })
    expect(h.db.getUnreadMessages(terminal, ['status'], 1)).toHaveLength(1)
    expect(h.db.getUnreadMessages(terminal)).toHaveLength(5)
  })

  it('requires explicit scope and a positive integral limit', async () => {
    const run = await h.create()
    for (const params of [
      { pending: true },
      ...[0, -1, 1.5].map((limit) => ({ pending: true, terminal: `run:${run}`, limit }))
    ]) {
      expect(await h.call('orchestration.inbox', params)).toMatchObject({ ok: false })
    }
  })
})
