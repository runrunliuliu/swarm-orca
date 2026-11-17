// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { TaskDraftState } from '@/lib/task-draft-issue-create'

import type { TaskDockDraftModel } from './TaskDock'
import { TaskDraftPreviewCard } from './task-draft-preview-card'

afterEach(cleanup)

const states: readonly TaskDraftState[] = [
  'idle',
  'no-context',
  'creating-draft',
  'draft-failed',
  'agent-launch-failed',
  'drafting',
  'preview-ready',
  'creating-issue',
  'issue-created-link-failed',
  'outcome-unknown',
  'provider-rejected',
  'duplicate-suspected',
  'remote-unsupported',
  'cancelled',
  'agent-crashed',
  'archived'
]

const stateText: Record<Exclude<TaskDraftState, 'idle'>, string> = {
  'no-context': 'Pick a source and a repository.',
  'creating-draft': 'Creating the draft…',
  'draft-failed': 'Could not create the draft.',
  'agent-launch-failed': 'The agent could not start.',
  drafting: 'Drafting the task…',
  'preview-ready': 'Preview title',
  'creating-issue': 'Creating the issue…',
  'issue-created-link-failed': 'Issue #412 was created, but the link was not saved.',
  'outcome-unknown': 'Outcome unknown.',
  'provider-rejected': 'The provider rejected the issue.',
  'duplicate-suspected': 'A similar issue already exists.',
  'remote-unsupported': 'Creating issues needs a local repository.',
  cancelled: 'The draft was not created.',
  'agent-crashed': 'The agent exited before producing a preview.',
  archived: 'This draft is archived.'
}

function makeDraft(overrides: Partial<TaskDockDraftModel> = {}): TaskDockDraftModel {
  return {
    state: 'idle',
    provider: 'github',
    proposal: { title: 'Preview title', body: 'First line\nSecond line', labels: ['bug'] },
    duplicates: [{ number: 412, title: 'Existing issue', url: 'https://example.test/412' }],
    duplicateCheckUnavailable: false,
    providerError: 'provider detail',
    createdIssueNumber: 412,
    onConfirmCreate: vi.fn(),
    onCancelPreview: vi.fn(),
    onReuseCandidate: vi.fn(),
    onCreateAnyway: vi.fn(),
    onRetry: vi.fn(),
    onReopenAgent: vi.fn(),
    onChooseGhFallback: vi.fn(),
    ...overrides
  }
}

function renderCard(draft: TaskDockDraftModel): void {
  render(<TaskDraftPreviewCard draft={draft} provider={draft.provider} />)
}

describe('TaskDraftPreviewCard', () => {
  it('presents every state and only confirms from preview-ready', () => {
    for (const state of states) {
      const draft = makeDraft({ state })
      renderCard(draft)

      if (state === 'idle') {
        expect(screen.queryByTestId('task-draft-state-idle')).toBeNull()
      } else {
        expect(screen.getByTestId(`task-draft-state-${state}`)).toBeInTheDocument()
        expect(screen.getByText(stateText[state])).toBeInTheDocument()

        for (const button of screen.queryAllByRole('button')) {
          if (button.textContent !== 'Create issue') {
            fireEvent.click(button)
          }
        }
        expect(draft.onConfirmCreate).not.toHaveBeenCalled()

        const confirm = screen.queryByRole('button', { name: 'Create issue' })
        if (state === 'preview-ready') {
          expect(confirm).toBeInTheDocument()
          fireEvent.click(confirm!)
          expect(draft.onConfirmCreate).toHaveBeenCalledTimes(1)
        } else {
          expect(confirm).toBeNull()
        }
      }
      cleanup()
    }
  })

  it('renders preview line breaks and labels as badges', () => {
    renderCard(makeDraft({ state: 'preview-ready' }))

    expect(screen.getByTestId('task-draft-preview-body')).toHaveClass('whitespace-pre-wrap')
    expect(screen.getByTestId('task-draft-preview-body')).toHaveTextContent(
      'First line Second line'
    )
    expect(screen.getByText('bug')).toHaveAttribute('data-slot', 'badge')
  })

  it('lists duplicate candidates, reuses the selected one, and keeps create available', () => {
    const candidates = [
      { number: 412, title: 'First match', url: 'https://example.test/412' },
      { number: 413, title: 'Second match', url: 'https://example.test/413' }
    ]
    const draft = makeDraft({
      state: 'duplicate-suspected',
      duplicates: candidates,
      duplicateCheckUnavailable: true
    })
    renderCard(draft)

    expect(screen.getByText('#412 First match')).toBeInTheDocument()
    expect(screen.getByText('#413 Second match')).toBeInTheDocument()
    expect(screen.getByText('Could not check for duplicates.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Still create' })).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Reuse' })[1]!)
    expect(draft.onReuseCandidate).toHaveBeenCalledWith(candidates[1])
  })

  it('offers gh only as an explicit GitHub preview action', () => {
    const github = makeDraft({ state: 'preview-ready', provider: 'github' })
    renderCard(github)

    fireEvent.click(screen.getByRole('button', { name: 'Use gh instead' }))
    expect(github.onChooseGhFallback).toHaveBeenCalledTimes(1)
    expect(github.onConfirmCreate).not.toHaveBeenCalled()

    cleanup()
    renderCard(makeDraft({ state: 'preview-ready', provider: 'linear' }))
    expect(screen.queryByRole('button', { name: 'Use gh instead' })).toBeNull()
  })
})
