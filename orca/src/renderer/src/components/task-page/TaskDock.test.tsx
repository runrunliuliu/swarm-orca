// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TaskDock, type TaskDockDraftModel, type TaskDockModel } from './TaskDock'

afterEach(cleanup)

function renderDock(overrides: Partial<TaskDockModel> = {}): TaskDockModel {
  const draft: TaskDockDraftModel = {
    state: 'idle',
    provider: 'github',
    proposal: null,
    duplicates: [],
    duplicateCheckUnavailable: false,
    providerError: null,
    createdIssueNumber: null,
    onConfirmCreate: vi.fn(),
    onCancelPreview: vi.fn(),
    onReuseCandidate: vi.fn(),
    onCreateAnyway: vi.fn(),
    onRetry: vi.fn(),
    onReopenAgent: vi.fn(),
    onChooseGhFallback: vi.fn()
  }
  const model: TaskDockModel = {
    instruction: 'add a login retry',
    expanded: false,
    targetLabel: 'GitHub · orca/repo',
    submitting: false,
    errorMessage: null,
    draft,
    onInstructionChange: vi.fn(),
    onExpandedChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides
  }
  render(<TaskDock model={model} />)
  return model
}

describe('TaskDock', () => {
  it('renders one collapsed line without chip, cancel or autofocus', () => {
    renderDock()

    expect(screen.getByTestId('task-dock')).toBeInTheDocument()
    expect(screen.getByTestId('task-dock-input')).toHaveValue('add a login retry')
    expect(screen.getByTestId('task-dock-submit')).toBeInTheDocument()
    expect(screen.queryByTestId('task-dock-chip')).toBeNull()
    expect(screen.queryByTestId('task-dock-cancel')).toBeNull()
    expect(document.activeElement).not.toBe(screen.getByTestId('task-dock-input'))
  })

  it('expands from the collapsed line and renders the target chip when expanded', async () => {
    const user = userEvent.setup()
    const model = renderDock()

    await user.click(screen.getByTestId('task-dock-input'))
    expect(model.onExpandedChange).toHaveBeenCalledWith(true)
    await user.click(screen.getByTestId('task-dock-expand'))
    expect(model.onExpandedChange).toHaveBeenCalledWith(true)

    cleanup()
    renderDock({ expanded: true })
    expect(screen.getByTestId('task-dock-chip')).toHaveTextContent('GitHub · orca/repo')
    expect(screen.getByTestId('task-dock-submit')).toHaveTextContent('Create draft')
    expect(screen.getByTestId('task-dock-cancel')).toHaveTextContent('Cancel')
  })

  it('submits once on ⌘⏎ and not on a bare Enter while expanded', () => {
    const model = renderDock({ expanded: true })
    const input = screen.getByTestId('task-dock-input')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(model.onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(model.onSubmit).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(model.onSubmit).toHaveBeenCalledTimes(2)
  })

  it('collapses on Esc without submitting and without losing the text', () => {
    const model = renderDock({ expanded: true })
    const input = screen.getByTestId('task-dock-input')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(model.onExpandedChange).toHaveBeenCalledWith(false)
    expect(model.onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveValue('add a login retry')
  })

  it('disables submit for a blank instruction or a missing target', async () => {
    const user = userEvent.setup()
    const blank = renderDock({ instruction: '   ' })
    await user.click(screen.getByTestId('task-dock-submit'))
    expect(screen.getByTestId('task-dock-submit')).toBeDisabled()
    expect(blank.onSubmit).not.toHaveBeenCalled()

    cleanup()
    const untargeted = renderDock({ targetLabel: null })
    await user.click(screen.getByTestId('task-dock-submit'))
    expect(screen.getByTestId('task-dock-submit')).toBeDisabled()
    expect(untargeted.onSubmit).not.toHaveBeenCalled()
  })

  it('locks the input and the submit button while submitting', () => {
    const model = renderDock({ expanded: true, submitting: true })
    const input = screen.getByTestId('task-dock-input')

    expect(input).toBeDisabled()
    expect(screen.getByTestId('task-dock-submit')).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(model.onSubmit).not.toHaveBeenCalled()
  })

  it('shows the failure and keeps the text editable for a retry', () => {
    renderDock({ expanded: true, errorMessage: 'boom' })
    const input = screen.getByTestId('task-dock-input')

    expect(screen.getByTestId('task-dock-error')).toHaveTextContent('boom')
    expect(input).not.toBeDisabled()
    expect(input).toHaveValue('add a login retry')
  })

  it('renders the preview through the dock and confirms only from its create action', async () => {
    const user = userEvent.setup()
    const draft: TaskDockDraftModel = {
      ...renderDock().draft,
      state: 'preview-ready',
      proposal: { title: 'Retry login', body: 'Keep the session alive.', labels: ['bug'] }
    }
    cleanup()

    const model = renderDock({ expanded: true, draft })
    expect(screen.getByTestId('task-draft-state-preview-ready')).toHaveTextContent('Retry login')

    await user.click(screen.getByRole('button', { name: 'Create issue' }))
    expect(model.draft.onConfirmCreate).toHaveBeenCalledTimes(1)
    expect(model.onSubmit).not.toHaveBeenCalled()
  })

  it('uses the state heading and keeps the hook error as its detail', () => {
    const cases: [TaskDockDraftModel['state'], string][] = [
      ['agent-launch-failed', 'The agent could not start.'],
      ['provider-rejected', 'The provider rejected the issue.'],
      ['issue-created-link-failed', 'Issue #412 was created, but the link was not saved.']
    ]

    for (const [state, heading] of cases) {
      const idleDraft = renderDock().draft
      cleanup()
      renderDock({
        expanded: true,
        errorMessage: 'specific detail',
        draft: {
          ...idleDraft,
          state,
          createdIssueNumber: state === 'issue-created-link-failed' ? 412 : null
        }
      })

      expect(screen.getByText(heading)).toBeInTheDocument()
      expect(screen.getByTestId('task-dock-error')).toHaveTextContent('specific detail')
      expect(screen.getByTestId('task-dock-error')).not.toHaveTextContent(
        'Could not create the draft.'
      )
      cleanup()
    }
  })
})
