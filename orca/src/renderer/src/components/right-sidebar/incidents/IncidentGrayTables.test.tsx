// @vitest-environment happy-dom

/**
 * The two grayscale read-only tables (§7.2, §7.3; M7-B).
 *
 * The visual claim is the requirement: an observed row must be distinguishable from a recorded incident
 * without reading the prose. So the assertions are on the rendered chrome (`data-incident-gray-row`,
 * the dashed container) rather than on copy alone.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IncidentPaneClocksTable, IncidentToolFailuresTable } from './IncidentGrayTables'
import { paneClocksViewFixture, toolFailuresViewFixture } from './incident-panel-fixtures'

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

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(node)
  })
  return container
}

describe('IncidentPaneClocksTable', () => {
  it('marks every row as an observed fact and claims no verdict', async () => {
    const container = await render(<IncidentPaneClocksTable view={paneClocksViewFixture()} />)
    const section = container.querySelector('section')
    expect(section?.className).toContain('border-dashed')
    expect(container.textContent).toContain('These rows are facts stored by the host process')
    const row = container.querySelector('[data-incident-gray-row]')
    expect(row?.getAttribute('data-incident-gray-row')).toBe('observed')
    expect(row?.className).toContain('border-dashed')
    expect(container.textContent).toContain('There is no threshold and no verdict here')
  })

  it('shows the age basis warning for a state_fallback row', async () => {
    const view = paneClocksViewFixture()
    view.rows[0].ageBasis = 'state_fallback'
    const container = await render(<IncidentPaneClocksTable view={view} />)
    expect(container.textContent).toContain('state_fallback')
    const hinted = [...container.querySelectorAll('[title]')].map((node) =>
      node.getAttribute('title')
    )
    expect(hinted.some((title) => title?.includes('weaker signal'))).toBe(true)
  })

  it('says when no pane has been sampled yet', async () => {
    const container = await render(<IncidentPaneClocksTable view={paneClocksViewFixture({ rows: [] })} />)
    expect(container.textContent).toContain('No pane has been sampled yet')
  })
})

describe('IncidentToolFailuresTable', () => {
  it('renders raw facts as observed rows without a write switch', async () => {
    const container = await render(<IncidentToolFailuresTable view={toolFailuresViewFixture()} />)
    const rows = [...container.querySelectorAll('[data-incident-gray-row]')]
    expect(rows.map((row) => row.getAttribute('data-incident-gray-row'))).toEqual([
      'observed',
      'observed'
    ])
    expect(rows[0].className).toContain('border-dashed')
    expect(rows[0].textContent).toContain('bash')
    expect(rows[0].textContent).toContain('exit 2')
    expect(rows[1].textContent).toContain('permission_denied')
    expect(container.textContent).not.toContain('Writing incidents')
    expect(container.textContent).not.toContain('would write')
  })

  it('states the provider coverage gap so silence is not read as absence', async () => {
    const container = await render(<IncidentToolFailuresTable view={toolFailuresViewFixture()} />)
    expect(container.textContent).toContain('Covered providers: claude, codex')
    expect(container.textContent).toContain('Coverage gap: no tool-failure data from pi, trae')
    expect(container.textContent).toContain('Silence from them is not "no tool failures"')
  })

  it('reports read truncation and dropped rows separately', async () => {
    const container = await render(
      <IncidentToolFailuresTable view={toolFailuresViewFixture({ truncated: true, total: 4, dropped: 2 })} />
    )
    expect(container.textContent).toContain('Showing 2 of 4 rows')
    expect(container.textContent).toContain('2 failed call(s) were dropped')
  })

  it('says when nothing has been recorded instead of rendering an empty table', async () => {
    const container = await render(<IncidentToolFailuresTable view={toolFailuresViewFixture({ rows: [], total: 0 })} />)
    expect(container.textContent).toContain('No failed tool call has been recorded')
  })
})
