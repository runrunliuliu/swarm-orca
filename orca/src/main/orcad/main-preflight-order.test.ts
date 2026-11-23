import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'
import { HISTORY_BACKFILL_FLAG } from '../../shared/history-backfill-command'

/**
 * The precondition is only worth anything if it runs first. A loader failure is not
 * catchable, so a preflight that lands after `main()` has already reached
 * `await import('../ipc/pty')` prevents nothing.
 */
const { order, profileProbe, historyProbe } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    profileProbe: vi.fn(async () => {}),
    historyProbe: vi.fn(() => false)
  }
})

vi.mock('./orcad-bundled-runtime', () => ({ handoffToBundledOrcad: () => false }))
vi.mock('./orcad-profile-preflight', () => ({
  preflightBundledOrcadStartup: async () => {
    order.push('profile-admission')
  },
  runOrcadProfilePreflight: profileProbe
}))

beforeEach(() => {
  vi.resetModules()
  order.length = 0
  historyProbe.mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

vi.mock('./orcad-native-preflight', () => ({
  runOrcadNativePreflight: () => {
    order.push('preflight')
    return true
  }
}))

vi.mock('./orcad-entry', () => ({
  installOrcadHostAdapters: () => {
    order.push('host-adapters')
  },
  main: async () => {
    order.push('main')
  }
}))
vi.mock('./orcad-history-backfill-preflight', () => ({
  runOrcadHistoryBackfillPreflight: historyProbe
}))

describe('orcad entry', () => {
  it.each([
    { flag: ORCAD_PROFILE_PREFLIGHT_FLAG, nativeFeatures: true },
    { flag: ORCAD_STARTUP_PREFLIGHT_FLAG, nativeFeatures: false }
  ])(
    'runs the selected disposable probe without starting a server: $flag',
    async ({ flag, nativeFeatures }) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, 'nonce'])
      await import('./main')
      expect(profileProbe).toHaveBeenCalledExactlyOnceWith('nonce', { nativeFeatures })
      expect(order).toEqual([])
    }
  )

  it('runs the history backfill preflight before any startup work', async () => {
    const argv = ['runtime', 'orcad.js', '--serve', HISTORY_BACKFILL_FLAG, '{}']
    vi.spyOn(process, 'argv', 'get').mockReturnValue(argv)
    await import('./main')

    expect(historyProbe).toHaveBeenCalledExactlyOnceWith(argv)
    expect(profileProbe).not.toHaveBeenCalled()
    expect(order).toEqual(['host-adapters'])
  })

  it('runs the native preflight before starting the runtime', async () => {
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('main'))

    expect(order).toEqual(['profile-admission', 'preflight', 'main'])
  })
})
