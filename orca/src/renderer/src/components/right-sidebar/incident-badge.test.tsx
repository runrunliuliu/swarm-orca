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
import { incidentBadgeFromCounts } from './incident-badge'

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

describe('incidentBadgeFromCounts', () => {
  it('draws nothing when there is nothing untriaged or no reading yet', () => {
    expect(incidentBadgeFromCounts(null)).toBeNull()
    expect(incidentBadgeFromCounts(undefined)).toBeNull()
    expect(incidentBadgeFromCounts(counts({ untriaged: 0 }))).toBeNull()
  })

  it('is red when the count is believed complete', () => {
    expect(incidentBadgeFromCounts(counts())).toEqual({
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: false,
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
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: true,
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
      count: 3,
      tone: 'alert',
      localGap: false,
      remoteGap: false,
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
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: true,
      label: '3 untriaged (count may be incomplete; remote view incomplete)'
    })
  })

  it('turns amber while coverage has a current hole, and says why', () => {
    const gap = counts({
      coverage: { ...counts().coverage, shadowReplayIncomplete: true, gap: true }
    })
    expect(incidentBadgeFromCounts(gap)).toEqual({
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: false,
      label: '3 untriaged (count may be incomplete)'
    })
  })

  it('escalates a capacity latch to amber: a store that refused a write may already be missing rows', () => {
    // §11.5 keeps `capacity_latch_set` and `currently_limited` as two fields about one hole at two
    // times. Both make the *local* count a lower bound, so both are amber; only the wording differs —
    // a latch is a past stop, not "refusing writes right now".
    const latched = counts({ coverage: { ...counts().coverage, capacityLatchSet: true } })
    expect(incidentBadgeFromCounts(latched)).toEqual({
      count: 3,
      tone: 'caution',
      localGap: true,
      remoteGap: false,
      label: '3 untriaged (a past capacity stop may have dropped incidents)'
    })
  })

  it('caps the rendered number so a 50k-row store cannot widen the strip', () => {
    const badge = incidentBadgeFromCounts(counts({ untriaged: 1_234 }))
    expect(badge?.count).toBe(1_234)
    expect(badge?.label.startsWith('99+ untriaged')).toBe(true)
  })
})

describe('ActivityBarButton badge', () => {
  // `null` is the mapping's "draw nothing" answer, so the helper accepts it and drops the field —
  // exactly what the activity item does in `use-right-sidebar-activity-items.ts`.
  const item = (badge: ActivityBarItem['badge'] | null): ActivityBarItem => ({
    id: 'incidents',
    icon: () => <span data-icon="incidents" />,
    title: 'Incidents',
    shortcut: '',
    ...(badge === undefined || badge === null ? {} : { badge })
  })

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
        item={item(
          incidentBadgeFromCounts(
            counts({ coverage: { ...counts().coverage, capacityLatchSet: true } })
          )
        )}
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
