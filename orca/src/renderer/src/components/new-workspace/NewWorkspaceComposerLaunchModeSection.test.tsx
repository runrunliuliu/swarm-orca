// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { NewWorkspaceComposerLaunchModeSection } from './NewWorkspaceComposerLaunchModeSection'
import type { NewWorkspaceLaunchMode } from '@/lib/swarm-launch-prompt'

type SectionProps = React.ComponentProps<typeof NewWorkspaceComposerLaunchModeSection>

function renderSection(overrides: Partial<SectionProps> = {}): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(
      <NewWorkspaceComposerLaunchModeSection
        launchMode="single"
        onLaunchModeChange={() => {}}
        maxWorkers="4"
        onMaxWorkersChange={() => {}}
        coordinatorAgentLabel="pi"
        taskSourceLabel="#123"
        {...overrides}
      />
    )
  })
  return container
}

function segmentLabels(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll('button[aria-pressed]')].map(
    (button) => button.textContent ?? ''
  )
}

function launchModeRoot(container: HTMLDivElement): HTMLElement | null {
  return container.querySelector('[data-new-workspace-launch-mode]')
}

function maxWorkersInput(container: HTMLDivElement): HTMLInputElement | null {
  return container.querySelector('input')
}

describe('NewWorkspaceComposerLaunchModeSection', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('offers both start modes and selects the single agent by default', () => {
    container = renderSection()

    expect(segmentLabels(container)).toEqual(['◇Single agent', '◈Swarm Coordinator'])
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      '◇Single agent'
    )
    expect(launchModeRoot(container)?.getAttribute('data-new-workspace-launch-mode')).toBe('single')
  })

  it('reports a mode change instead of switching on its own', () => {
    const modes: NewWorkspaceLaunchMode[] = []
    container = renderSection({ onLaunchModeChange: (next) => modes.push(next) })

    act(() => {
      ;[...container!.querySelectorAll('button')].at(1)?.click()
    })

    expect(modes).toEqual(['swarm'])
    expect(launchModeRoot(container)?.getAttribute('data-new-workspace-launch-mode')).toBe('single')
  })

  it('hides the worker cap and summary while a single agent starts', () => {
    container = renderSection()

    expect(maxWorkersInput(container)).toBeNull()
    expect(container.textContent).not.toContain('max_workers')
  })

  it('shows the worker cap, the read-only summary and the confirm-before-starting hint', () => {
    container = renderSection({ launchMode: 'swarm' })

    expect(maxWorkersInput(container)?.value).toBe('4')
    expect(container.textContent).toContain('Coordinator = pi')
    expect(container.textContent).toContain('Workers ≤ 4')
    expect(container.textContent).toContain('Task source = #123')
    expect(container.textContent).toContain('confirms budget')
  })

  it('reports the raw field text so the composer can gate submit', () => {
    const values: string[] = []
    container = renderSection({ launchMode: 'swarm', onMaxWorkersChange: (n) => values.push(n) })

    const input = maxWorkersInput(container)!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '0')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(values).toEqual(['0'])
  })

  it('flags an invalid cap in the field without touching the footer error', () => {
    container = renderSection({ launchMode: 'swarm', maxWorkers: '0' })

    expect(maxWorkersInput(container)?.getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('Enter a whole number of 1 or more.')
    expect(container.textContent).toContain('Workers ≤ —')
  })

  it('clears the field message again once the cap parses', () => {
    container = renderSection({ launchMode: 'swarm', maxWorkers: '6' })

    expect(maxWorkersInput(container)?.getAttribute('aria-invalid')).toBe('false')
    expect(container.textContent).not.toContain('Enter a whole number of 1 or more.')
    expect(container.textContent).toContain('Workers ≤ 6')
  })

  it('says nothing is linked instead of inventing a task source', () => {
    container = renderSection({
      launchMode: 'swarm',
      taskSourceLabel: null,
      coordinatorAgentLabel: null
    })

    expect(container.textContent).toContain('Task source = not linked')
    expect(container.textContent).toContain('Coordinator = no agent selected')
  })
})
