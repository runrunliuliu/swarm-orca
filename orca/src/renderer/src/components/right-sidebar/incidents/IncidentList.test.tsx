// @vitest-environment happy-dom

/**
 * The incident list (§12, M7-B).
 *
 * Three things are asserted here because they cannot be checked from the pure modules: the six columns
 * exist with their values, the row is a real button carrying a complete accessible label, and the
 * keyboard actually moves focus (the pure resolver only says what *should* happen).
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncidentList } from './IncidentList'
import { FIXTURE_NOW, listItemFixture } from './incident-panel-fixtures'

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

async function renderList(
  items: ReturnType<typeof listItemFixture>[],
  options: { selectedId?: string | null; onOpen?: (item: ReturnType<typeof listItemFixture>) => void; empty?: React.ReactNode } = {}
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <IncidentList
        items={items}
        selectedId={options.selectedId ?? null}
        now={FIXTURE_NOW}
        empty={options.empty ?? 'empty'}
        onOpen={options.onOpen ?? vi.fn()}
      />
    )
  })
  return container
}

function rowButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('ul button')]
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('IncidentList', () => {
  it('renders the six columns, the effective status and a complete row label', async () => {
    const container = await renderList([
      listItemFixture({ summary: 'killed by signal 9', effectiveStatus: 'untriaged' })
    ])
    const header = container.querySelector('[aria-hidden="true"]')?.textContent ?? ''
    for (const column of ['time', 'class', 'agent', 'worktree', 'key facts', 'status']) {
      expect(header).toContain(column)
    }
    const row = rowButtons(container)[0]
    expect(row.getAttribute('aria-label')).toBe(
      'untriaged crash incident: killed by signal 9'
    )
    expect(row.textContent).toContain('killed by signal 9')
    expect(row.textContent).toContain('wt-1')
    // The agent column shows the session prefix, never an invented agent name.
    expect(row.textContent).toContain('sess-abc')
  })

  it('says so when a row has no agent session binding instead of leaving a blank', async () => {
    const container = await renderList([listItemFixture({ agentSessionId: null })])
    const row = rowButtons(container)[0]
    expect(row.textContent).toContain('—')
    expect(row.querySelector('[title]')?.getAttribute('title')).toContain(
      'No agent session binding'
    )
  })

  it('moves focus with ArrowDown/End and opens the focused row with Enter', async () => {
    const onOpen = vi.fn()
    const container = await renderList(
      [listItemFixture({ id: 'a' }), listItemFixture({ id: 'b' }), listItemFixture({ id: 'c' })],
      { onOpen }
    )
    const rows = rowButtons(container)
    // Roving tabindex: exactly one row is a tab stop.
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1)

    await act(async () => {
      rows[0].focus()
    })
    await pressKey(rows[0], 'ArrowDown')
    expect(document.activeElement).toBe(rows[1])

    await pressKey(rows[1], 'End')
    expect(document.activeElement).toBe(rows[2])

    await pressKey(rows[2], 'Enter')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
  })

  it('renders the supplied empty state and no rows', async () => {
    const container = await renderList([], { empty: 'No untriaged incidents.' })
    expect(container.textContent).toContain('No untriaged incidents.')
    expect(rowButtons(container)).toHaveLength(0)
  })
})
