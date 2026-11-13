// @vitest-environment happy-dom

/**
 * Triage actions (§5, §12; M7-B).
 *
 * The assertions are about what the renderer refuses to do on its own: it never prefills the actor,
 * never decides a transition is invalid locally, and always shows the store's answer. The store is
 * mocked here only to produce those answers — no policy is re-implemented in the test either.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentDecideRequest } from '../../../../../shared/incident-api-types'
import { IncidentTriageActions } from './IncidentTriageActions'

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

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderActions(
  onDecide: (request: IncidentDecideRequest) => Promise<{ outcome: string; detail?: string | null }>
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<IncidentTriageActions incidentId="inc_1" onDecide={onDecide} />)
  })
  return container
}

async function chooseTarget(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  await act(async () => {
    button?.click()
  })
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
  })
}

describe('IncidentTriageActions', () => {
  it('offers all five actions and records nothing until one is submitted', async () => {
    const onDecide = vi.fn()
    const container = await renderActions(onDecide)
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toEqual(['Watch', 'Duplicate', 'Invalid', 'Needs archive', 'Confirmed'])
    expect(container.querySelector('form')).toBeNull()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('appends a watch decision with the reason and no actor field when it is blank', async () => {
    const onDecide = vi.fn(async () => ({ outcome: 'appended' }))
    const container = await renderActions(onDecide)
    await chooseTarget(container, 'Watch')
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      setValue(textarea as HTMLTextAreaElement, 'wait for a repeat')
    })
    await submit(container)

    expect(onDecide).toHaveBeenCalledWith({
      incidentId: 'inc_1',
      toStatus: 'watch',
      reason: 'wait for a repeat'
    })
    expect(container.textContent).toContain('Decision appended.')
    // The reason is cleared after a successful append; the actor is not invented.
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
  })

  it('never prefills the actor, even for confirmed', async () => {
    const onDecide = vi.fn(async () => ({ outcome: 'actor_required', detail: 'needs one' }))
    const container = await renderActions(onDecide)
    await chooseTarget(container, 'Confirmed')
    const actor = container.querySelector('input')
    expect(actor?.value).toBe('')
    await act(async () => {
      setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'root cause found')
    })
    await submit(container)

    // No actor key at all: the store decides whether that is acceptable.
    expect(onDecide).toHaveBeenCalledWith({
      incidentId: 'inc_1',
      toStatus: 'confirmed',
      reason: 'root cause found'
    })
    expect(container.textContent).toContain('An actor is required for this decision')
  })

  it('shows an invalid transition as the store’s refusal, not as a hidden button', async () => {
    const onDecide = vi.fn(async () => ({ outcome: 'invalid_transition', detail: 'nope' }))
    const container = await renderActions(onDecide)
    await chooseTarget(container, 'Confirmed')
    await act(async () => {
      setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'r')
    })
    await submit(container)
    expect(container.textContent).toContain('The store refuses that move from the current status.')
    // The action buttons stay available: the panel does not disable by status.
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(5)
  })

  it('marks the reason required for every action and the actor only for confirmed', async () => {
    const container = await renderActions(vi.fn())
    await chooseTarget(container, 'Watch')
    const reason = container.querySelector('textarea')
    const actor = container.querySelector('input')
    expect(reason?.required).toBe(true)
    expect(reason?.getAttribute('aria-required')).toBe('true')
    // Not required for a non-confirmed action, and never prefilled.
    expect(actor?.required).toBe(false)
    expect(actor?.getAttribute('aria-required')).toBe('false')
    expect(actor?.value).toBe('')

    await chooseTarget(container, 'Confirmed')
    expect(container.querySelector('input')?.required).toBe(true)
    expect(container.querySelector('input')?.getAttribute('aria-required')).toBe('true')
  })

  it('passes a typed actor through verbatim (self-reported, unverified)', async () => {
    const onDecide = vi.fn(async () => ({ outcome: 'appended' }))
    const container = await renderActions(onDecide)
    await chooseTarget(container, 'Needs archive')
    await act(async () => {
      setValue(container.querySelector('input') as HTMLInputElement, 'alice')
      setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'archive it')
    })
    await submit(container)
    expect(onDecide).toHaveBeenCalledWith({
      incidentId: 'inc_1',
      toStatus: 'needs_archive',
      actor: 'alice',
      reason: 'archive it'
    })
  })
})
