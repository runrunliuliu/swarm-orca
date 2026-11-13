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
      label: '3 untriaged'
    })
  })

  it('turns amber while coverage has a current hole, and says why', () => {
    const gap = counts({
      coverage: { ...counts().coverage, shadowReplayIncomplete: true, gap: true }
    })
    expect(incidentBadgeFromCounts(gap)).toEqual({
      count: 3,
      tone: 'caution',
      label: '3 untriaged (count may be incomplete)'
    })
  })

  it('reports a past capacity stop without escalating to amber', () => {
    // History, not a current fault: the tone stays red, but the label still admits the lower bound.
    const latched = counts({ coverage: { ...counts().coverage, capacityLatchSet: true } })
    expect(incidentBadgeFromCounts(latched)?.tone).toBe('alert')
    expect(incidentBadgeFromCounts(latched)?.label).toBe(
      '3 untriaged (a past capacity stop may have dropped incidents)'
    )
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
