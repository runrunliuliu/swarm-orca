import { afterEach, expect, it, vi } from 'vitest'
import { settleBeforeDeadline } from './settle-before-deadline'

afterEach(() => vi.useRealTimers())

it('preserves fallback and fail-closed behavior without cancellation', async () => {
  const run = (): Promise<null> => {
    throw new Error('read failed')
  }
  await expect(settleBeforeDeadline(run, null, Date.now() + 1000)).resolves.toBeNull()
  await expect(
    settleBeforeDeadline(run, null, Date.now() + 1000, new Error('timeout'))
  ).rejects.toThrow('read failed')
  await expect(
    settleBeforeDeadline(run, null, Date.now() + 1000, new Error('timeout'), () => false)
  ).resolves.toBeNull()
})

it('does not start an operation cancelled before its microtask runs', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const run = vi.fn(async () => null)
  const pending = settleBeforeDeadline(
    run,
    null,
    Date.now() + 1000,
    undefined,
    undefined,
    controller.signal
  )
  controller.abort()
  await expect(pending).rejects.toThrow('request_aborted')
  expect(run).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('removes cancellation listeners and timers on success and timeout', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  await expect(
    settleBeforeDeadline(
      async () => 1,
      0,
      Date.now() + 1000,
      undefined,
      undefined,
      controller.signal
    )
  ).resolves.toBe(1)
  const pending = settleBeforeDeadline(
    () => new Promise<number>(() => {}),
    0,
    Date.now() + 1000,
    undefined,
    undefined,
    controller.signal
  )
  await vi.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toBe(0)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
