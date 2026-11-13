// @vitest-environment happy-dom

/**
 * The panel wiring (§12, M7-B): snapshot → list → drawer → decision → refresh.
 *
 * This is the one test that exercises the IPC contract from the renderer side, so it also pins the
 * honesty rules that live in the hooks: a closed failure is rendered as "not a claim that there are no
 * incidents", and a decision that the store refuses does not trigger a refresh.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IncidentPanel from './IncidentPanel'
import {
  FIXTURE_NOW,
  coverageFixture,
  detailFixture,
  listItemFixture,
  paneClocksViewFixture,
  toolErrorsViewFixture
} from './incident-panel-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    ),
  getIntlLocale: () => 'en'
}))

// Radix's portal + focus trap belong to the primitive's own tests; the drawer's content is what this
// test needs, and the real Sheet would render it outside this container.
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

const api = {
  snapshot: vi.fn(),
  detail: vi.fn(),
  decide: vi.fn(),
  counts: vi.fn(),
  onCountsChanged: vi.fn((_callback: () => void) => () => {}),
  paneClocks: vi.fn(),
  toolErrors: vi.fn()
}

type ApiResult = { ok: true; value: unknown } | { ok: false; error: string; code: string }

function ok(value: unknown): ApiResult {
  return { ok: true, value }
}

function snapshotValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    incidents: [listItemFixture()],
    total: 1,
    coverage: coverageFixture(),
    ...overrides
  }
}

const roots: Root[] = []

beforeEach(() => {
  api.snapshot.mockReset().mockResolvedValue(ok(snapshotValue()))
  api.detail.mockReset().mockResolvedValue(ok(detailFixture()))
  api.decide.mockReset().mockResolvedValue(
    ok({
      outcome: 'appended',
      incidentId: 'inc_fixture_1',
      decisionId: 'dec_2',
      fromStatus: 'untriaged',
      toStatus: 'watch',
      actor: 'unspecified'
    })
  )
  api.counts.mockReset().mockResolvedValue(ok(null))
  api.onCountsChanged.mockReset().mockReturnValue(() => {})
  api.paneClocks.mockReset().mockResolvedValue(ok(paneClocksViewFixture()))
  api.toolErrors.mockReset().mockResolvedValue(ok(toolErrorsViewFixture()))
  ;(window as unknown as { api: unknown }).api = {
    incidents: api,
    shell: { openPath: vi.fn() }
  }
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

async function renderPanel(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<IncidentPanel />)
  })
  // Let the snapshot promise settle.
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

describe('IncidentPanel', () => {
  it('loads the default untriaged view without a standing remote warning', async () => {
    const container = await renderPanel()
    expect(api.snapshot).toHaveBeenCalledWith({ limit: 200, status: 'untriaged' })
    expect(container.textContent).toContain('Agent process killed by signal 9')
    expect(container.textContent).toContain('Status: untriaged')
    // Arbitration option C: local gaps are primary. A host with no mirror hole gets no remote banner.
    expect(container.textContent).not.toContain('Remote view')
  })

  it('shows a monitored remote hole as its own secondary line', async () => {
    api.snapshot.mockResolvedValue(
      ok(
        snapshotValue({
          coverage: coverageFixture({
            remoteMirror: { capture: 'not_probed', unsynced: 2, monitored: true }
          })
        })
      )
    )
    const container = await renderPanel()
    expect(container.textContent).toContain('Remote view')
    expect(container.textContent).toContain('has not been probed yet')
  })

  it('renders a failed read as unreadable, not as an empty store', async () => {
    api.snapshot.mockResolvedValue({
      ok: false,
      code: 'incident_store_unavailable',
      error: 'no store yet'
    })
    const container = await renderPanel()
    expect(container.textContent).toContain(
      'The incident store could not be read, so this is not a claim that there are no incidents.'
    )
    expect(container.textContent).toContain('no store yet')
    expect(container.textContent).not.toContain('No untriaged incidents')
  })

  it('opens the drawer for a row and records a decision, then refreshes both reads', async () => {
    const container = await renderPanel()
    expect(api.detail).not.toHaveBeenCalled()

    const row = container.querySelector<HTMLButtonElement>('ul button')
    await act(async () => {
      row?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.detail).toHaveBeenCalledWith({ incidentId: 'inc_fixture_1' })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.textContent).toContain('Unknown · stop_unverified')

    const watch = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Watch'
    )
    await act(async () => {
      watch?.click()
    })
    const textarea = container.querySelector('textarea')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'look at it tomorrow'
      )
      textarea?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const snapshotCallsBefore = api.snapshot.mock.calls.length
    const detailCallsBefore = api.detail.mock.calls.length
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.decide).toHaveBeenCalledWith({
      incidentId: 'inc_fixture_1',
      toStatus: 'watch',
      reason: 'look at it tomorrow'
    })
    expect(api.snapshot.mock.calls.length).toBeGreaterThan(snapshotCallsBefore)
    expect(api.detail.mock.calls.length).toBeGreaterThan(detailCallsBefore)
    expect(container.textContent).toContain('Decision appended.')
  })

  it('does not refresh after a refusal, and shows the store’s reason', async () => {
    api.decide.mockResolvedValue(
      ok({ outcome: 'actor_required', detail: '`confirmed` requires an explicit actor.' })
    )
    const container = await renderPanel()
    const row = container.querySelector<HTMLButtonElement>('ul button')
    await act(async () => {
      row?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const confirmed = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Confirmed'
    )
    await act(async () => {
      confirmed?.click()
    })
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        container.querySelector('textarea'),
        'root cause'
      )
      container
        .querySelector('textarea')
        ?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const snapshotCallsBefore = api.snapshot.mock.calls.length
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.snapshot.mock.calls.length).toBe(snapshotCallsBefore)
    expect(container.textContent).toContain('An actor is required for this decision')
  })

  it('switches to the grayscale views and reads them only when selected', async () => {
    const container = await renderPanel()
    expect(api.paneClocks).not.toHaveBeenCalled()
    expect(api.toolErrors).not.toHaveBeenCalled()

    const paneClocksTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Pane clocks'
    )
    await act(async () => {
      paneClocksTab?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.paneClocks).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('These rows are facts stored by the host process')
    expect(container.querySelector('[data-incident-gray-row="observed"]')).not.toBeNull()

    const toolErrorsTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Tool errors'
    )
    await act(async () => {
      toolErrorsTab?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.toolErrors).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-incident-gray-row="recorded"]')).not.toBeNull()
  })

  it('refreshes on the coalesced counts push instead of polling', async () => {
    const container = await renderPanel()
    const listener = api.onCountsChanged.mock.calls[0]?.[0] as (() => void) | undefined
    expect(listener).toBeTypeOf('function')
    const before = api.snapshot.mock.calls.length
    await act(async () => {
      listener?.()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.snapshot.mock.calls.length).toBeGreaterThan(before)
    expect(container.textContent).toContain('Agent process killed by signal 9')
  })

  it('states a coverage gap in the empty state rather than "nothing happened"', async () => {
    api.snapshot.mockResolvedValue(
      ok(
        snapshotValue({
          incidents: [],
          total: 0,
          coverage: coverageFixture({ currentlyLimited: true })
        })
      )
    )
    const container = await renderPanel()
    expect(container.textContent).toContain('refusing writes right now')
    expect(container.textContent).toContain('This is not "nothing happened"')
  })

  it('says the loaded page is partial when the store total is larger', async () => {
    api.snapshot.mockResolvedValue(
      ok(snapshotValue({ total: 40, incidents: [listItemFixture()] }))
    )
    const container = await renderPanel()
    expect(container.textContent).toContain('Showing 1 of 40 matching incidents')
  })

  it('keeps working without the bridge (a paired web client has no incident API)', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    const container = await renderPanel()
    expect(container.textContent).toContain('The incident bridge is not available')
  })

  it('uses FIXTURE_NOW-independent relative times without crashing', async () => {
    // Guards the `formatUiRelativeTime` call path: a missing locale resolver used to throw here.
    const container = await renderPanel()
    expect(container.textContent).toContain('Agent process killed by signal 9')
    expect(FIXTURE_NOW).toBeGreaterThan(0)
  })
})
