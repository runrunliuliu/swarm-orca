// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  TaskWorkbenchDeliverConfirm,
  type TaskWorkbenchDeliverConfirmValue
} from './task-workbench-deliver-confirm'

/**
 * The delivery confirmation (README §7.11.3 rules 2, 3, 6, §7.11.5).
 *
 * What this file owns: the panel the two entries share renders from its props
 * only — no dialog, no second solid primary, three required inputs, and the
 * frozen copy in the frozen places. Whether a launch actually starts is the
 * host's (TaskWorkbenchDelivery.deliver.test.tsx) and the launcher's
 * (task-workbench-deliver-launch.test.ts) business, so nothing here mocks a
 * store.
 *
 * Every expectation is a literal: the copy below is copied from
 * SHARED-CONTEXT's frozen key list, not derived from the component.
 */

afterEach(cleanup)

const DEFAULT_BRANCH_LABEL = 'Default · needs confirmation'
const REQUIRED_COPY = 'Choose a target branch first.'
const ARCHIVE_HINT =
  'The delivery agent archives this workspace after it reports; find it again under Show archived.'

function renderConfirm(
  props: Partial<Parameters<typeof TaskWorkbenchDeliverConfirm>[0]> = {}
): {
  onSubmit: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onSubmit = vi.fn<(value: TaskWorkbenchDeliverConfirmValue) => void>()
  const onCancel = vi.fn<() => void>()
  const onClose = vi.fn<() => void>()
  render(
    <TaskWorkbenchDeliverConfirm
      heading="acme/web-app · feat/task-431"
      onSubmit={onSubmit}
      onCancel={onCancel}
      onClose={onClose}
      {...props}
    />
  )
  return { onSubmit, onCancel, onClose }
}

describe('task-workbench deliver confirm — a popover, not a modal', () => {
  it('renders the panel without a dialog role or an overlay', () => {
    renderConfirm()

    const panel = screen.getByTestId('task-workbench-deliver-confirm')
    expect(panel).toBeInTheDocument()
    // §7.11.3 rule 2: inline popover. A dialog would trap focus and give the
    // screen a second, modal primary.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
  })

  it('adds no solid primary: submit is outline and nothing is filled', () => {
    renderConfirm()

    const submit = screen.getByTestId('task-workbench-deliver-submit')
    expect(submit).toHaveAttribute('data-variant', 'outline')
    // §7.4.2: the page header keeps the screen's only filled primary.
    const variants = screen
      .getByTestId('task-workbench-deliver-confirm')
      .querySelectorAll('[data-slot="button"]')
    expect(variants.length).toBeGreaterThan(0)
    for (const button of variants) {
      expect(['outline', 'ghost']).toContain(button.getAttribute('data-variant'))
    }
  })

  it('states the policy line and the archive-after hint', () => {
    renderConfirm()

    expect(
      screen.getByText(
        'Delivery integrates through a pull request; nothing is written to the primary checkout.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText(ARCHIVE_HINT)).toBeInTheDocument()
  })
})

describe('task-workbench deliver confirm — three required inputs', () => {
  it('pre-fills the default branch and labels it as a default that needs confirmation', () => {
    renderConfirm({ defaultTargetBranch: 'main' })

    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('main')
    expect(screen.getByTestId('task-workbench-deliver-target-branch-default')).toHaveTextContent(
      DEFAULT_BRANCH_LABEL
    )
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeEnabled()
  })

  it('drops the default label once the reader types their own branch', () => {
    renderConfirm({ defaultTargetBranch: 'main' })

    fireEvent.change(screen.getByTestId('task-workbench-deliver-target-branch'), {
      target: { value: 'release/2026-11' }
    })

    expect(screen.getByTestId('task-workbench-deliver-target-branch')).toHaveValue('release/2026-11')
    expect(screen.queryByTestId('task-workbench-deliver-target-branch-default')).toBeNull()
  })

  it('blocks submit on an empty branch and says why', () => {
    const { onSubmit } = renderConfirm()

    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeDisabled()
    expect(screen.getByTestId('task-workbench-deliver-target-branch-required')).toHaveTextContent(
      REQUIRED_COPY
    )
    // Why the reason is also wired to the submit button: the disabled button is
    // not a tab stop, so the sentence has to be reachable from the one control
    // that is unavailable.
    expect(screen.getByTestId('task-workbench-deliver-submit')).toHaveAttribute(
      'aria-describedby',
      'task-workbench-deliver-target-branch-required'
    )

    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('defaults the integration mode to PR and switches on click', () => {
    renderConfirm({ defaultTargetBranch: 'main' })

    const group = screen.getByTestId('task-workbench-deliver-integration')
    expect(group).toHaveAttribute('role', 'radiogroup')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false'
    ])
    expect(radios.map((radio) => radio.textContent)).toEqual(['PR', 'Local merge', 'Squash'])

    fireEvent.click(radios[2])
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true'
    ])
  })

  it('leaves archive-after off by default and toggles it', () => {
    renderConfirm({ defaultTargetBranch: 'main' })

    const checkbox = screen.getByTestId('task-workbench-deliver-archive-after')
    expect(checkbox).toHaveAttribute('data-state', 'unchecked')

    fireEvent.click(checkbox)
    expect(screen.getByTestId('task-workbench-deliver-archive-after')).toHaveAttribute(
      'data-state',
      'checked'
    )
  })

  it('hands the three values to onSubmit, trimmed, and never launches anything itself', () => {
    const { onSubmit } = renderConfirm({ defaultTargetBranch: 'main' })

    fireEvent.change(screen.getByTestId('task-workbench-deliver-target-branch'), {
      target: { value: '  release/2026-11  ' }
    })
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.click(screen.getByTestId('task-workbench-deliver-archive-after'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({
      targetBranch: 'release/2026-11',
      integrationMode: 'local-merge',
      // §7.12 D1 defaults: merging is on, archiving is off. Closing stays off
      // here because this panel was rendered without an issue number, even
      // though `renderConfirm`'s default target branch is set.
      mergePullRequest: true,
      closeIssue: false,
      archiveAfter: true
    })
  })

  // §7.12 D1/A2/A3: the three writes are the operator's explicit consent. The
  // create-PR tick is fixed and cannot be turned off (§7.11.3 rule 7).
  it('shows the deliver scope with create-PR fixed on and merge/close ticked by default', () => {
    renderConfirm({ defaultTargetBranch: 'main', issueNumber: 412 })

    const create = screen.getByTestId('task-workbench-deliver-create-pr')
    expect(create).toHaveAttribute('data-state', 'checked')
    expect(create).toBeDisabled()
    expect(screen.getByTestId('task-workbench-deliver-merge-pr')).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByTestId('task-workbench-deliver-close-issue')).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByText('Close issue #412')).toBeInTheDocument()
  })

  it('does not authorize closing an issue the page does not name', () => {
    const { onSubmit } = renderConfirm({ defaultTargetBranch: 'main' })

    const close = screen.getByTestId('task-workbench-deliver-close-issue')
    expect(close).toHaveAttribute('data-state', 'unchecked')
    expect(close).toBeDisabled()
    expect(
      screen.getByText('This page names no issue, so delivery will not close one.')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    expect(onSubmit).toHaveBeenCalledWith({
      targetBranch: 'main',
      integrationMode: 'pr',
      mergePullRequest: true,
      closeIssue: false,
      archiveAfter: false
    })
  })

  it('drops the merge when the operator unticks it', () => {
    const { onSubmit } = renderConfirm({ defaultTargetBranch: 'main', issueNumber: 412 })

    fireEvent.click(screen.getByTestId('task-workbench-deliver-merge-pr'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-close-issue'))
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))

    expect(onSubmit).toHaveBeenCalledWith({
      targetBranch: 'main',
      integrationMode: 'pr',
      mergePullRequest: false,
      closeIssue: false,
      archiveAfter: false
    })
  })

  it('keeps submit unavailable while a launch is pending in this panel', () => {
    const { onSubmit } = renderConfirm({ defaultTargetBranch: 'main', submitting: true })

    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('task-workbench-deliver-submit'))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('task-workbench deliver confirm — the attention line states, never intercepts', () => {
  it('renders no attention row when the projection has none', () => {
    renderConfirm({ defaultTargetBranch: 'main' })

    // Today `projection.attention` is always empty (§7.11.6), so the absence is
    // the assertion: not an empty box, not a "no warnings" claim.
    expect(screen.queryByTestId('task-workbench-deliver-confirm-attention')).toBeNull()
    // And it changes nothing about the action: submit stays available.
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeEnabled()
  })

  it('states each notice when one exists, without disabling the submit', () => {
    const onCancel = vi.fn<() => void>()
    render(
      <TaskWorkbenchDeliverConfirm
        heading="acme/web-app · feat/task-431"
        defaultTargetBranch="main"
        attention={[
          {
            key: 'auto.components.TaskWorkbenchDeliver.attention',
            fallback:
              'Uncommitted or unpushed work is handed to the delivery agent; nothing is stashed or deleted.'
          }
        ]}
        onSubmit={vi.fn<() => void>()}
        onCancel={onCancel}
        onClose={onCancel}
      />
    )

    expect(screen.getByTestId('task-workbench-deliver-confirm-attention')).toHaveTextContent(
      'Uncommitted or unpushed work is handed to the delivery agent; nothing is stashed or deleted.'
    )
    expect(screen.getByTestId('task-workbench-deliver-submit')).toBeEnabled()
  })
})

describe('task-workbench deliver confirm — dismissal', () => {
  it('closes on close, cancel and Escape', () => {
    const { onClose, onCancel } = renderConfirm({ defaultTargetBranch: 'main' })

    fireEvent.click(screen.getByTestId('task-workbench-deliver-close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('task-workbench-deliver-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
