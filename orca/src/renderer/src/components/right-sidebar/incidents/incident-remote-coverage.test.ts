// Grading the remote view (§12, M7-B; codex-ark/trae arbitration, option C).
//
// The rule under test is the one that keeps the badge honest: a remote hole is secondary, and a peer
// that was never configured is not a hole at all. Getting this wrong in either direction is a real
// failure mode — either the badge cries wolf forever, or a monitored-but-broken mirror looks fine.
import { describe, expect, it } from 'vitest'
import {
  incidentRemoteCoverageIsGap,
  incidentRemoteCoverageState
} from './incident-remote-coverage'

describe('incidentRemoteCoverageState', () => {
  it('says nothing when the host reports no mirror read', () => {
    expect(incidentRemoteCoverageState(undefined)).toBe('absent')
  })

  it('treats a never-configured peer as not_configured, not as a gap', () => {
    expect(incidentRemoteCoverageState({ capture: 'unsupported', unsynced: 0 })).toBe(
      'not_configured'
    )
    expect(
      incidentRemoteCoverageState({ capture: 'not_probed', unsynced: 3, monitored: false })
    ).toBe('not_configured')
  })

  it('counts a monitored mirror that has not been probed', () => {
    expect(
      incidentRemoteCoverageState({ capture: 'not_probed', unsynced: 0, monitored: true })
    ).toBe('gap')
  })

  it('counts a monitored mirror with unsynchronised rows, and clears at zero', () => {
    expect(
      incidentRemoteCoverageState({ capture: 'mirrored', unsynced: 2, monitored: true })
    ).toBe('gap')
    expect(
      incidentRemoteCoverageState({ capture: 'mirrored', unsynced: 0, monitored: true })
    ).toBe('complete')
  })

  it('counts a monitored host that still reports capture unsupported', () => {
    expect(
      incidentRemoteCoverageState({ capture: 'unsupported', unsynced: 0, monitored: true })
    ).toBe('gap')
  })
})

describe('incidentRemoteCoverageIsGap', () => {
  it('is the single question the badge asks, and never true for an absent reader', () => {
    expect(incidentRemoteCoverageIsGap(undefined)).toBe(false)
    expect(incidentRemoteCoverageIsGap({ capture: 'not_probed', unsynced: 9 })).toBe(false)
    expect(
      incidentRemoteCoverageIsGap({ capture: 'not_probed', unsynced: 9, monitored: true })
    ).toBe(true)
  })
})
