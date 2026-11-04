import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('Run turn-end peek', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('distinguishes queued mail from an unfinished Delivery without consuming either', async () => {
    const { db, ctx, activeRunId } = h.setup()
    if (!activeRunId) {
      throw new Error('bound Run required')
    }
    const run = db.getRun(activeRunId)
    if (!run) {
      throw new Error('Run required')
    }
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      runId: run.id,
      subject: 'done'
    })
    const peek = () =>
      h.call(
        'orchestration.check',
        {
          terminal: 'term_coord',
          run: run.id,
          peek: true
        },
        ctx
      )
    expect(await peek()).toMatchObject({ count: 1, hasOutstandingDelivery: false })
    expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const batch = db.getOrCreateRunDelivery(params)
    if (!batch) {
      throw new Error('Delivery required')
    }
    for (let i = 0; i < 2; i++) {
      expect(await peek()).toMatchObject({ count: 1, hasOutstandingDelivery: true })
    }
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getDeliveryRaw(batch.delivery.id)?.acknowledged_at).toBeNull()
    db.acknowledgeRunDelivery({ ...params, deliveryId: batch.delivery.id })
    expect(await peek()).toMatchObject({ count: 0, hasOutstandingDelivery: false })
  })

  it('does not report a claimed but fully consumed batch as unfinished', async () => {
    const { db, ctx, activeRunId } = h.setup()
    if (!activeRunId) {
      throw new Error('bound Run required')
    }
    const run = db.getRun(activeRunId)
    if (!run) {
      throw new Error('Run required')
    }
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      runId: run.id,
      subject: 'old'
    })
    db.getOrCreateRunDelivery({ runId: run.id, consumerGeneration: run.consumer_generation })
    db.markAsReadAndDelivered([message.id])
    expect(
      await h.call(
        'orchestration.check',
        {
          terminal: 'term_coord',
          run: run.id,
          peek: true
        },
        ctx
      )
    ).toMatchObject({ count: 0, hasOutstandingDelivery: false })
  })
})
