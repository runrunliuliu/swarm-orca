// @vitest-environment happy-dom

/**
 * The detail drawer (§9, §12; M7-B).
 *
 * The Sheet primitive is mocked because Radix's portal/focus machinery is not what this test is about
 * (and its focus trap is the reason this component does not implement one). What is asserted: the
 * recorded facts, the unknown-first wording, pointer metadata with no transcript body, the
 * append-only timeline in recorded order, and the two callbacks.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncidentDetailDrawer } from './IncidentDetailDrawer'
import { FIXTURE_NOW, detailFixture } from './incident-panel-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    ),
  getIntlLocale: () => 'en'
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
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

async function renderDrawer(
  detail = detailFixture(),
  handlers: {
    onClose?: () => void
    onOpenEvidence?: (pointer: unknown) => void
    onDecide?: () => Promise<{ outcome: string }>
    coverageLocalGaps?: Parameters<typeof IncidentDetailDrawer>[0]['coverageLocalGaps']
    coverageRemoteLine?: Parameters<typeof IncidentDetailDrawer>[0]['coverageRemoteLine']
  } = {}
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <IncidentDetailDrawer
        detail={detail}
        loading={false}
        error={null}
        now={FIXTURE_NOW}
        {...(handlers.coverageLocalGaps === undefined
          ? {}
          : { coverageLocalGaps: handlers.coverageLocalGaps })}
        {...(handlers.coverageRemoteLine === undefined
          ? {}
          : { coverageRemoteLine: handlers.coverageRemoteLine })}
        onClose={handlers.onClose ?? vi.fn()}
        onDecide={handlers.onDecide ?? (async () => ({ outcome: 'appended' }))}
        onOpenEvidence={handlers.onOpenEvidence ?? vi.fn()}
      />
    )
  })
  return container
}

describe('IncidentDetailDrawer', () => {
  it('renders the exit cause as unknown, with its reason spelled out', async () => {
    const container = await renderDrawer()
    expect(container.textContent).toContain('Unknown · stop_unverified')
    expect(container.textContent).toContain('a stop was requested and no exit was ever observed')
  })

  it('lists unknown boundaries, and says the absence is a gap when there are none', async () => {
    const withBoundaries = await renderDrawer()
    expect(withBoundaries.textContent).toContain('no transcript pointer at PTY teardown')

    const withoutBoundaries = await renderDrawer(
      detailFixture({ evidence: { pointers: [], unknownBoundaries: [] } })
    )
    expect(withoutBoundaries.textContent).toContain('The absence itself is a gap')
  })

  it('shows pointer metadata only, and never the real absolute path', async () => {
    const onOpenEvidence = vi.fn()
    const container = await renderDrawer(detailFixture(), { onOpenEvidence })
    const text = container.textContent ?? ''
    // Privacy: basename + one parent, with the rest elided. The absolute path can carry a user name,
    // a project name or a host mount, and this drawer is meant to be read and screenshotted.
    expect(text).toContain('…/does-not-exist/transcript.jsonl')
    expect(text).not.toContain('/tmp/does-not-exist/transcript.jsonl')
    expect(text).not.toContain('/tmp')
    expect(text).toContain('offsets: 120..480')
    expect(text).toContain('sha256: aaaaaaaaaaaa')
    expect(text).toContain('bytes: 4096')
    // The rule itself is stated in the drawer, so a reader knows why there is no body to scroll.
    expect(text).toContain('No transcript body is loaded or rendered here')

    // Titles and aria-labels are display text too: neither may leak the real path.
    for (const node of container.querySelectorAll('[title]')) {
      expect(node.getAttribute('title')).not.toContain('/tmp')
    }

    const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Open ')
    )
    expect(open?.getAttribute('aria-label')).toBe('Open …/does-not-exist/transcript.jsonl')
    await act(async () => {
      open?.click()
    })
    // The real path still reaches the one call that needs it.
    expect(onOpenEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/does-not-exist/transcript.jsonl', startOffset: 120 })
    )
  })

  it('says a missing pointer is a gap rather than leaving the section blank', async () => {
    const container = await renderDrawer(
      detailFixture({
        evidence: { pointers: [], unknownBoundaries: ['nothing was captured'] }
      })
    )
    expect(container.textContent).toContain('No evidence pointer was recorded')
    expect(container.textContent).toContain('That is a gap, not a clean bill of health')
  })

  it('renders the decision timeline oldest first and keeps the entry status visible', async () => {
    const container = await renderDrawer(
      detailFixture({
        status: 'untriaged',
        effectiveStatus: 'watch',
        decisionCount: 2,
        decisions: [
          {
            id: 'dec_late',
            incidentId: 'inc_fixture_1',
            fromStatus: 'watch',
            toStatus: 'needs_archive',
            actor: 'bob',
            reason: 'second',
            createdAt: FIXTURE_NOW - 10_000
          },
          {
            id: 'dec_early',
            incidentId: 'inc_fixture_1',
            fromStatus: 'untriaged',
            toStatus: 'watch',
            actor: 'alice',
            reason: 'first',
            createdAt: FIXTURE_NOW - 30_000
          }
        ]
      })
    )
    const items = [...container.querySelectorAll('ol li')].map((item) => item.textContent ?? '')
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('first')
    expect(items[1]).toContain('second')
    expect(container.textContent).toContain('untriaged → watch')
    expect(container.textContent).toContain('(entry status untriaged, 2 decision(s))')
  })

  it('offers the triage actions and a close control', async () => {
    const onClose = vi.fn()
    const container = await renderDrawer(detailFixture(), { onClose })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Triage this incident"]')).not.toBeNull()
    const close = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Close incident details'
    )
    await act(async () => {
      close?.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps local and remote coverage in separate sections', async () => {
    const container = await renderDrawer(detailFixture(), {
      coverageLocalGaps: [{ kind: 'replay_incomplete', dropped: 2 }],
      coverageRemoteLine: {
        state: 'gap',
        capture: 'not_probed',
        unsynced: 3,
        gap: true
      }
    })
    const text = container.textContent ?? ''
    expect(text).toContain('Local coverage')
    expect(text).toContain('Shadow replay has not finished and dropped 2 hint line(s)')
    expect(text).toContain('Remote view')
    expect(text).toContain('has not been probed yet')
    // The grading is stated, not implied: a remote hole does not put this host's facts in doubt.
    expect(text).toContain('gap in the global view, not a fault in this host')
    // Two headings, not one merged warning.
    const headings = [...container.querySelectorAll('h3')].map((node) => node.textContent)
    expect(headings.indexOf('Local coverage')).toBeGreaterThanOrEqual(0)
    expect(headings.indexOf('Remote view')).toBeGreaterThan(headings.indexOf('Local coverage'))
  })

  it('says not configured only in the detail, in its own line', async () => {
    const container = await renderDrawer(detailFixture(), {
      coverageRemoteLine: {
        state: 'not_configured',
        capture: 'unsupported',
        unsynced: 0,
        gap: false
      }
    })
    expect(container.textContent).toContain('No remote host is mirrored or monitored from here')
    expect(container.textContent).toContain('Remote capture is unsupported by design')
  })

  it('states that a host with no mirror read still reports no remote coverage', async () => {
    const container = await renderDrawer()
    expect(container.textContent).toContain('This host reports no remote-mirror coverage')
    expect(container.textContent).toContain('this host\'s own records are not in doubt')
  })

  it('shows a load error instead of an empty drawer over an unreadable row', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <IncidentDetailDrawer
          detail={null}
          loading={false}
          error="Incident inc_x not found."
          now={FIXTURE_NOW}
          onClose={vi.fn()}
          onDecide={async () => ({ outcome: 'appended' })}
          onOpenEvidence={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('Incident inc_x not found.')
  })
})
