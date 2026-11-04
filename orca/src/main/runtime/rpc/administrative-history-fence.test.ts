import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strictCoordinatorHarness, WORKER, OPERATOR } from './strict-coordinator-test-fixture'
import { assertNoStrictRawInput } from './strict-coordinator-authority'

describe.each([false, true])('administrative quarantine (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
    h.db.db.exec("INSERT INTO administrative_history_receipts VALUES ('cleanup', '{}')")
    const insert = h.db.db.prepare('INSERT INTO administrative_history_fences VALUES (?, ?, ?)')
    for (const address of [WORKER, 'run:old', 'old', 'dispatch:old-worker']) {
      insert.run('address', address, 'cleanup')
    }
    insert.run('pane', h.authorities.get(WORKER)!.paneKey!, 'cleanup')
    h.db.hasAdministrativeHistoryFences = true
  })
  afterEach(() => h.close())
  const refusal = { ok: false, error: { code: 'administrative_history_quarantined' } }
  it('blocks old sender mutations and consuming checks without any strict Run rows', async () => {
    expect(h.db.hasStrictCoordinatorRunsCache).toBe(false)
    for (const [method, params] of [
      ['orchestration.runCreate', { from: WORKER, objective: 'reuse' }],
      ['orchestration.send', { from: WORKER, to: OPERATOR, body: 'old' }],
      ['orchestration.check', { terminal: WORKER }]
    ] as const) {
      expect(await h.call(method, params, WORKER)).toMatchObject(refusal)
    }
    expect(h.nudge).not.toHaveBeenCalled()
  })
  it('blocks stale recipients and old Run ids, leaving fresh callers usable', async () => {
    for (const to of [WORKER, 'run:old', 'dispatch:old-worker']) {
      expect(
        await h.call('orchestration.send', { from: OPERATOR, to, body: 'reuse' }, OPERATOR)
      ).toMatchObject(refusal)
    }
    expect(
      await h.call('orchestration.runUse', { from: OPERATOR, id: 'old' }, OPERATOR)
    ).toMatchObject(refusal)
    expect(
      await h.call('orchestration.runCreate', { from: OPERATOR, objective: 'fresh' }, OPERATOR)
    ).toMatchObject({ ok: true })
  })
  it('blocks raw terminal input and the binary-stream authority guard', async () => {
    expect(
      await h.call('terminal.send', { terminal: WORKER, text: 'go', enter: true })
    ).toMatchObject(refusal)
    expect(() => assertNoStrictRawInput(h.runtime, WORKER)).toThrow('archived history')
    expect(h.rawSend).not.toHaveBeenCalled()
  })
  it('refuses an entire mixed group before enqueue or wake', async () => {
    const before = h.db.getInbox(1000)
    expect(
      await h.call('orchestration.send', { from: OPERATOR, to: '@worktree:folder' }, OPERATOR)
    ).toMatchObject(refusal)
    expect(h.db.getInbox(1000)).toEqual(before)
    expect(h.nudge).not.toHaveBeenCalled()
  })
  it('refuses replay into a quarantined group recipient', async () => {
    h.close()
    h = strictCoordinatorHarness(streaming)
    const params = { from: OPERATOR, to: '@worktree:folder' }
    expect(await h.call('orchestration.send', params, OPERATOR, 'old-group')).toMatchObject({
      ok: true
    })
    h.db.db.exec("INSERT INTO administrative_history_receipts VALUES ('cleanup', '{}')")
    h.db.db
      .prepare('INSERT INTO administrative_history_fences VALUES (?, ?, ?)')
      .run('address', WORKER, 'cleanup')
    h.db.hasAdministrativeHistoryFences = true
    h.nudge.mockClear()
    expect(await h.call('orchestration.send', params, OPERATOR, 'old-group')).toMatchObject(refusal)
    expect(h.nudge).not.toHaveBeenCalled()
  })
  it('keeps fences and audit receipts immutable under ordinary reset', async () => {
    h.db.resetAll()
    expect(
      await h.call('orchestration.send', { from: OPERATOR, to: WORKER, body: 'old' }, OPERATOR)
    ).toMatchObject(refusal)
    for (const table of ['administrative_history_fences', 'administrative_history_receipts']) {
      expect(() => h.db.db.exec(`DELETE FROM ${table}`)).toThrow('administrative_history_immutable')
    }
  })
})
