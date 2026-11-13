// @vitest-environment happy-dom

/**
 * The graded coverage banner (§11.5, §12; M7-B under the codex-ark/trae arbitration).
 *
 * The four local holes are primary and each rendered on its own terms; the remote view is secondary
 * and only appears when it is a real (monitored) hole. `not_configured` is deliberately *absent* here —
 * it belongs to the drawer — because a host that never mirrored anything must not see a standing banner.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncidentCoverageBanner } from './IncidentCoverageBanner'
import {
  incidentCoverageIsCurrentGap,
  incidentLocalCoverageGaps,
  incidentRemoteCoverageLine
} from './incident-coverage-banner'
import { coverageFixture } from './incident-panel-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    ),
  getIntlLocale: () => 'en'
}))

const roots: Root[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

async function renderBanner(
  coverage = coverageFixture(),
  page: { shown: number; total: number } = { shown: 1, total: 1 }
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const localGaps = incidentLocalCoverageGaps({
    coverage,
    shown: page.shown,
    total: page.total
  })
  const remoteLine = incidentRemoteCoverageLine(coverage)
  await act(async () => {
    root.render(<IncidentCoverageBanner localGaps={localGaps} remoteLine={remoteLine} />)
  })
  return container
}

describe('local gaps are primary', () => {
  it('reports nothing when the local store is complete — no standing remote warning', async () => {
    const container = await renderBanner()
    expect(container.querySelectorAll('p')).toHaveLength(0)
  })

  it('reports a current write refusal first', async () => {
    const container = await renderBanner(coverageFixture({ currentlyLimited: true }))
    const text = container.textContent ?? ''
    expect(text).toContain('Local coverage')
    expect(text).toContain('refusing writes right now')
    expect(text).toContain('lower bound')
  })

  it('reports an unfinished replay and a dropped hint line', async () => {
    const short = await renderBanner(
      coverageFixture({
        shadowReplay: { ...coverageFixture().shadowReplay, incomplete: true }
      })
    )
    expect(short.textContent).toContain('Shadow replay has not reached the end')

    const dropped = await renderBanner(
      coverageFixture({
        shadowReplay: { ...coverageFixture().shadowReplay, incomplete: true, dropped: 3 }
      })
    )
    expect(dropped.textContent).toContain('dropped 3 hint line(s)')
  })

  it('reports a past capacity stop as history, separate from a current refusal', async () => {
    const latched = await renderBanner(coverageFixture({ capacityLatchSet: true }))
    expect(latched.textContent).toContain('hit its capacity limit at some point')

    const current = await renderBanner(
      coverageFixture({ capacityLatchSet: true, currentlyLimited: true })
    )
    expect(current.textContent).toContain('refusing writes right now')
    expect(current.textContent).not.toContain('hit its capacity limit at some point')
  })

  it('reports the page bound when the store total is larger than the loaded rows', async () => {
    const container = await renderBanner(coverageFixture(), { shown: 50, total: 120 })
    expect(container.textContent).toContain('Showing 50 of 120')
  })

  it('marks the local count as a lower bound only for local holes', () => {
    expect(
      incidentCoverageIsCurrentGap(
        incidentLocalCoverageGaps({ coverage: coverageFixture(), shown: 1, total: 1 })
      )
    ).toBe(false)
    expect(
      incidentCoverageIsCurrentGap(
        incidentLocalCoverageGaps({
          coverage: coverageFixture({ currentlyLimited: true }),
          shown: 1,
          total: 1
        })
      )
    ).toBe(true)
    // A remote hole is not a local one.
    expect(
      incidentCoverageIsCurrentGap(
        incidentLocalCoverageGaps({
          coverage: coverageFixture({
            remoteMirror: { capture: 'not_probed', unsynced: 5, monitored: true }
          }),
          shown: 1,
          total: 1
        })
      )
    ).toBe(false)
  })
})

describe('remote view is secondary', () => {
  it('does not render a not-configured peer in the banner', async () => {
    const container = await renderBanner(
      coverageFixture({ remoteMirror: { capture: 'not_probed', unsynced: 0, monitored: false } })
    )
    expect(container.textContent).not.toContain('Remote view')
    expect(container.textContent).not.toContain('not configured')
  })

  it('renders a monitored but unprobed mirror as a secondary, non-warning line', async () => {
    const container = await renderBanner(
      coverageFixture({ remoteMirror: { capture: 'not_probed', unsynced: 2, monitored: true } })
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Remote view')
    expect(text).toContain('has not been probed yet')
    // Secondary treatment: muted text, no filled warning background.
    const remote = [...container.querySelectorAll('p')].find((node) =>
      node.textContent?.includes('has not been probed')
    )
    expect(remote?.className).toContain('text-muted-foreground')
    expect(remote?.className).not.toContain('bg-status-warning-background')
  })

  it('says how many mirrored incidents are unsynchronised', async () => {
    const container = await renderBanner(
      coverageFixture({ remoteMirror: { capture: 'mirrored', unsynced: 4, monitored: true } })
    )
    expect(container.textContent).toContain('4 incident(s) are not synchronised yet')
  })

  it('stays silent when the monitored mirror is fully synchronised', async () => {
    const container = await renderBanner(
      coverageFixture({ remoteMirror: { capture: 'mirrored', unsynced: 0, monitored: true } })
    )
    expect(container.textContent).not.toContain('Remote view')
  })
})
