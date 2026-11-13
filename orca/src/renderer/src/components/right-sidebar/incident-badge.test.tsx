// @vitest-environment happy-dom

/**
 * The activity-bar incident badge (§12, M7-A).
 *
 * Two layers, asserted separately on purpose:
 *   * the mapping (`incidentBadgeFromCounts`) decides red vs amber and when there is no badge at all;
 *   * `ActivityBarButton` renders that decision — the count is visible, and the count is *amber* once
 *     the store reports a current coverage hole, because "3 known, possibly more" is not the same
 *     urgency as "3 to triage".
 */
import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentCountsDto } from '../../../../shared/incident-api-types'
import { ActivityBarButton, type ActivityBarItem } from './activity-bar-buttons'
import { incidentBadgeFromCounts, incidentBadgeFromState } from './incident-badge'
import type { IncidentCountsState } from './use-incident-counts'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Why mocked: the real primitives need a provider tree and portal placement, neither of which this
// test is about. The trigger keeps the button's own props (aria-label, className) intact.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
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

function counts(overrides: Partial<IncidentCountsDto> = {}): IncidentCountsDto {
  return {
    untriaged: 3,
    total: 4,
    byClass: {
      crash: 3,
      no_progress: 0,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    },
    byWorktree: [{ worktreeId: 'wt-1', untriaged: 3 }],
    coverage: {
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      shadowReplayDropped: 0,
      remoteIncidentCapture: 'unsupported',
      gap: false
    },
    readAt: 1_700_000_000_000,
    ...overrides
  }
}

/**
 * The DTO the main process produces for a latched store: `gap` is true *because* the latch is set.
 * Kept as its own helper so a test can never accidentally encode the old split-brain (latch set but
 * `gap` false), which is a shape the producer no longer emits.
 */
function latchedCounts(overrides: Partial<IncidentCountsDto> = {}): IncidentCountsDto {
  return counts({
    ...overrides,
    coverage: { ...counts(overrides).coverage, capacityLatchSet: true, gap: true }
  })
}

async function renderNode(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(node)
  })
  return container
}

// `null` is the mapping's "draw nothing" answer, so the helper accepts it and drops the field —
// exactly what the activity item does in `use-right-sidebar-activity-items.ts`.
function item(badge: ActivityBarItem['badge'] | null): ActivityBarItem {
  return {
    id: 'incidents',
    icon: () => <span data-icon="incidents" />,
    title: 'Incidents',
    shortcut: '',
    ...(badge === undefined || badge === null ? {} : { badge })
  }
}

describe('incidentBadgeFromCounts', () => {
  it('draws nothing when there is nothing untriaged and nothing incomplete', () => {
    expect(incidentBadgeFromCounts(null)).toBeNull()
    expect(incidentBadgeFromCounts(undefined)).toBeNull()
    expect(incidentBadgeFromCounts(counts({ untriaged: 0 }))).toBeNull()
  })

  it('draws a digit-free indicator when the count is zero but a local hole exists', () => {
    // The trap: `0` plus an incomplete store must not be silent, and must not claim "0 incidents".
    const zeroWithLatch = incidentBadgeFromCounts(latchedCounts({ untriaged: 0 }))
    expect(zeroWithLatch).toEqual({
      kind: 'count',
      count: 0,
      tone: 'caution',
      localGap: true,
      remoteGap: false,
      showCount: false,
      label: 'a past capacity stop may have dropped incidents'
    })

    const zeroWithReplay = incidentBadgeFromCounts(
      counts({ untriaged: 0, coverage: { ...counts().coverage, gap: true } })
    )
    expect(zeroWithReplay?.showCount).toBe(false)
    expect(zeroWithReplay?.tone).toBe('caution')
    expect(zeroWithReplay?.label).toBe('count may be incomplete')
  })

  it('draws a secondary digit-free indicator when only the remote view is incomplete', () => {
    const zeroWithRemote = incidentBadgeFromCounts(
      counts({
        untriaged: 0,
        coverage: {
          ...counts().coverage,
          remoteMirror: { capture: 'not_probed', unsynced: 2, monitored: true }
        }
      })
    )
    expect(zeroWithRemote).toEqual({
      kind: 'count',
      count: 0,
      tone: 'alert',
      localGap: false,
      remoteGap: true,
      showCount: false,
      label: 'remote view incomplete'
    })
  })

  it('is red when the count is believed complete', () => {
    expect(incidentBadgeFromCounts(counts())).toEqual({
      kind: 'count',
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: false,
      showCount: true,
      label: '3 untriaged'
    })
  })

  it('keeps the count red and adds an outline note for a remote-only gap', () => {
    // Arbitration option C: a remote hole is secondary. The local number is still exactly this host's
    // fact, so the tone must stay `alert` even though the badge says more.
    const remote = counts({
      coverage: {
        ...counts().coverage,
        remoteMirror: { capture: 'not_probed', unsynced: 4, monitored: true }
      }
    })
    expect(incidentBadgeFromCounts(remote)).toEqual({
      kind: 'count',
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: true,
      showCount: true,
      label: '3 untriaged (remote view incomplete)'
    })
  })

  it('does not count a peer that was never configured', () => {
    const unconfigured = counts({
      coverage: {
        ...counts().coverage,
        remoteMirror: { capture: 'unsupported', unsynced: 0, monitored: false }
      }
    })
    expect(incidentBadgeFromCounts(unconfigured)).toEqual({
      kind: 'count',
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: false,
      showCount: true,
      label: '3 untriaged'
    })
  })

  it('lets a local gap win the tone while still naming the remote hole', () => {
    const both = counts({
      coverage: {
        ...counts().coverage,
        currentlyLimited: true,
        gap: true,
        remoteMirror: { capture: 'mirrored', unsynced: 1, monitored: true }
      }
    })
    expect(incidentBadgeFromCounts(both)).toEqual({
      kind: 'count',
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: true,
      showCount: true,
      label: '3 untriaged (count may be incomplete; remote view incomplete)'
    })
  })

  it('turns amber while coverage has a current hole, and says why', () => {
    const gap = counts({
      coverage: { ...counts().coverage, shadowReplayIncomplete: true, gap: true }
    })
    expect(incidentBadgeFromCounts(gap)).toEqual({
      kind: 'count',
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: false,
      showCount: true,
      label: '3 untriaged (count may be incomplete)'
    })
  })

  it('escalates a capacity latch to amber: a store that refused a write may already be missing rows', () => {
    // §11.5 keeps `capacity_latch_set` and `currently_limited` as two fields about one hole at two
    // times. Both make the *local* count a lower bound, so both are amber; only the wording differs —
    // a latch is a past stop, not "refusing writes right now".
    const latched = latchedCounts()
    expect(incidentBadgeFromCounts(latched)).toEqual({
      kind: 'count',
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: false,
      showCount: true,
      label: '3 untriaged (a past capacity stop may have dropped incidents)'
    })
  })

  it('takes the local verdict from the DTO: gap alone is enough, no latch field needed', () => {
    const fromDto = counts({ coverage: { ...counts().coverage, gap: true } })
    expect(incidentBadgeFromCounts(fromDto)?.tone).toBe('caution')
    expect(incidentBadgeFromCounts(fromDto)?.localGap).toBe(true)
  })

  it('caps the rendered number so a 50k-row store cannot widen the strip', () => {
    const badge = incidentBadgeFromCounts(counts({ untriaged: 1_234 }))
    expect(badge?.count).toBe(1_234)
    expect(badge?.label.startsWith('99+ untriaged')).toBe(true)
  })
})

describe('ActivityBarButton badge', () => {
  it('draws a secondary outline marker for a remote-only gap without changing the count colour', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(
          incidentBadgeFromCounts(
            counts({
              coverage: {
                ...counts().coverage,
                remoteMirror: { capture: 'not_probed', unsynced: 4, monitored: true }
              }
            })
          )
        )}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    const countBadge = rendered.querySelector('[aria-hidden="true"]:not([data-incident-remote-gap])')
    expect(countBadge?.className).toContain('bg-destructive')
    expect(countBadge?.className).not.toContain('bg-status-warning')
    // Outline, not a fill: the secondary marker cannot compete with the count.
    const marker = rendered.querySelector('[data-incident-remote-gap="true"]')
    expect(marker?.className).toContain('border-muted-foreground')
    expect(marker?.className).toContain('bg-transparent')
    expect(rendered.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — 3 untriaged (remote view incomplete)'
    )
  })

  it('renders an amber count for a coverage gap and a red count without one', async () => {
    const complete = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromCounts(counts()))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    const completeBadge = complete.querySelector('[aria-hidden="true"]')
    expect(completeBadge?.textContent).toBe('3')
    expect(completeBadge?.className).toContain('bg-destructive')
    expect(complete.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — 3 untriaged'
    )

    const gapped = await renderNode(
      <ActivityBarButton
        item={item(
          incidentBadgeFromCounts(
            counts({ coverage: { ...counts().coverage, currentlyLimited: true, gap: true } })
          )
        )}
        active={false}
        onClick={vi.fn()}
        layout="side"
      />
    )
    const gappedBadge = gapped.querySelector('[aria-hidden="true"]')
    expect(gappedBadge?.className).toContain('bg-status-warning')
    // The qualifier travels with the number, so the badge cannot be read as a complete count.
    expect(gapped.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — 3 untriaged (count may be incomplete)'
    )
  })

  it('renders an amber count for a capacity latch, not only for a live refusal', async () => {
    const latched = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromCounts(latchedCounts()))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    const badge = latched.querySelector('[aria-hidden="true"]')
    expect(badge?.className).toContain('bg-status-warning')
    expect(latched.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — 3 untriaged (a past capacity stop may have dropped incidents)'
    )
  })

  it('renders a digit-free amber ring when the count is zero but a local hole exists', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromCounts(latchedCounts({ untriaged: 0 })))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    const indicator = rendered.querySelector('[data-incident-count-incomplete="true"]')
    expect(indicator).not.toBeNull()
    expect(indicator?.className).toContain('border-status-warning')
    // No digits anywhere in the chrome: a "0" here would read as "no incidents".
    expect(rendered.textContent ?? '').not.toMatch(/\d/)
    expect(rendered.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — a past capacity stop may have dropped incidents'
    )
  })

  it('renders a muted digit-free ring when only the remote view is incomplete', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(
          incidentBadgeFromCounts(
            counts({
              untriaged: 0,
              coverage: {
                ...counts().coverage,
                remoteMirror: { capture: 'not_probed', unsynced: 2, monitored: true }
              }
            })
          )
        )}
        active={false}
        onClick={vi.fn()}
        layout="side"
      />
    )
    const indicator = rendered.querySelector('[data-incident-count-incomplete="true"]')
    expect(indicator?.className).toContain('border-muted-foreground')
    expect(indicator?.className).not.toContain('border-status-warning')
    expect(rendered.textContent ?? '').not.toMatch(/\d/)
    // The secondary marker would stack on top of the dot; it must not.
    expect(rendered.querySelector('[data-incident-remote-gap="true"]')).toBeNull()
  })

  it('renders no badge element when the count is zero', async () => {
    const empty = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromCounts(counts({ untriaged: 0 })))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    expect(empty.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(empty.querySelector('button')?.getAttribute('aria-label')).toBe('Incidents')
  })

  it('still calls onClick, so the entry is a real button before its panel exists', async () => {
    const onClick = vi.fn()
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromCounts(counts()))}
        active={false}
        onClick={onClick}
        layout="top"
      />
    )
    await act(async () => {
      rendered.querySelector('button')?.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

/** A state as the hook reports it; the clock is the hook's business, not this mapping's. */
function state(
  availability: IncidentCountsState['availability'],
  countsValue: IncidentCountsDto | null = null
): IncidentCountsState {
  return { counts: countsValue, availability }
}

describe('incidentBadgeFromState: no data is not no incidents (M7-D)', () => {
  it('draws nothing on the first paint, before any reading or failure', () => {
    // `idle` is "nothing has arrived yet". An unavailable marker here would accuse the store during
    // the first few milliseconds of every launch.
    expect(incidentBadgeFromState(state('idle'))).toBeNull()
  })

  it('marks a failed read as unavailable instead of looking like an empty store', () => {
    const badge = incidentBadgeFromState(state('unavailable'))
    expect(badge).toEqual({
      kind: 'unavailable',
      reason: 'unavailable',
      label:
        'Incident counts are unavailable: the store could not be read, so this is not a statement that nothing needs triage.'
    })
    // The whole point: no number to mistake for "0 untriaged".
    expect(badge && 'count' in badge).toBe(false)
  })

  it('marks an old reading as stale instead of letting it keep looking current', () => {
    const badge = incidentBadgeFromState(state('stale', counts({ untriaged: 3 })))
    expect(badge).toMatchObject({ kind: 'unavailable', reason: 'stale' })
    expect(badge?.label).toContain('stale')
    // A stale badge may not restate the count it no longer vouches for.
    expect(badge && 'count' in badge).toBe(false)
  })

  it('stays silent for a stale reading that was complete and empty', () => {
    // Documented exception: a quiet host that never had an incident would otherwise carry a permanent
    // marker whose content is "nothing happened", which is exactly what a healthy quiet host says.
    expect(incidentBadgeFromState(state('stale', counts({ untriaged: 0 })))).toBeNull()
  })

  it('marks a stale reading that still had a local hole (nothing to suppress)', () => {
    const badge = incidentBadgeFromState(state('stale', latchedCounts({ untriaged: 0 })))
    expect(badge).toMatchObject({ kind: 'unavailable', reason: 'stale' })
  })

  it('defers to the count mapping while the reading is fresh', () => {
    const fresh = counts({ untriaged: 2 })
    expect(incidentBadgeFromState(state('ok', fresh))).toEqual(incidentBadgeFromCounts(fresh))
  })

  it('renders the marker as a dashed muted ring with no digits, whatever the last reading said', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromState(state('stale', counts({ untriaged: 3 }))))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    const marker = rendered.querySelector('[data-incident-counts-unavailable="stale"]')
    expect(marker).not.toBeNull()
    // Muted + dashed: distinct from the solid amber/red count and from the remote outline note.
    expect(marker?.className).toContain('border-dashed')
    expect(marker?.className).toContain('border-muted-foreground')
    expect(marker?.className).toContain('bg-transparent')
    expect(marker?.className).not.toContain('bg-destructive')
    expect(marker?.className).not.toContain('bg-status-warning')
    // No digits anywhere: the old "3" must not survive as a current claim. The tooltip mock renders the
    // label text, so the check is on the rendered marker and on the absence of a count element.
    const marks = rendered.querySelectorAll('[aria-hidden="true"]')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe('')
    expect(rendered.textContent).not.toContain('3 untriaged')
    expect(rendered.querySelector('[data-incident-remote-gap="true"]')).toBeNull()
    expect(rendered.querySelector('button')?.getAttribute('aria-label')).toContain(
      'Incident counts are stale'
    )
  })

  it('renders the unavailable marker for a failed read and keeps the label in the a11y tree', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromState(state('unavailable')))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    expect(rendered.querySelector('[data-incident-counts-unavailable="unavailable"]')).not.toBeNull()
    expect(rendered.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    expect(rendered.textContent).not.toContain('untriaged')
    expect(rendered.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Incidents — Incident counts are unavailable: the store could not be read, so this is not a statement that nothing needs triage.'
    )
  })

  it('draws nothing at all on the first paint', async () => {
    const rendered = await renderNode(
      <ActivityBarButton
        item={item(incidentBadgeFromState(state('idle')))}
        active={false}
        onClick={vi.fn()}
        layout="top"
      />
    )
    expect(rendered.querySelector('[data-incident-counts-unavailable]')).toBeNull()
    expect(rendered.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(rendered.querySelector('button')?.getAttribute('aria-label')).toBe('Incidents')
  })
})
