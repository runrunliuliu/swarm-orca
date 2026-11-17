// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDock, type TaskDockModel } from './TaskDock'

afterEach(cleanup)

function dockModel(overrides: Partial<TaskDockModel> = {}): TaskDockModel {
  return {
    instruction: '',
    expanded: false,
    targetLabel: 'github · acme/widgets',
    model: '',
    modelOptions: [],
    transcript: [],
    transcriptStatus: 'none',
    submitting: false,
    errorMessage: null,
    onInstructionChange: vi.fn(),
    onModelChange: vi.fn(),
    onExpandedChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides
  }
}

describe('TaskDock', () => {
  it('collapsed is one persistent line that opens the input', () => {
    const model = dockModel()
    render(<TaskDock model={model} />)
    fireEvent.click(screen.getByTestId('task-dock-collapsed'))
    expect(model.onExpandedChange).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('task-dock-input')).toBeNull()
  })

  it('expanded sends on ⌘↵ and does not send a blank instruction', () => {
    const model = dockModel({ expanded: true, instruction: 'Add a retry button' })
    render(<TaskDock model={model} />)
    fireEvent.keyDown(screen.getByTestId('task-dock-input'), { key: 'Enter', metaKey: true })
    expect(model.onSubmit).toHaveBeenCalledTimes(1)

    const blank = dockModel({ expanded: true, instruction: '   ' })
    cleanup()
    render(<TaskDock model={blank} />)
    fireEvent.keyDown(screen.getByTestId('task-dock-input'), { key: 'Enter', metaKey: true })
    expect(blank.onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('task-dock-send')).toHaveProperty('disabled', true)
  })

  it('closes on Esc without sending and keeps the text', () => {
    const model = dockModel({ expanded: true, instruction: 'keep me' })
    render(<TaskDock model={model} />)
    fireEvent.keyDown(screen.getByTestId('task-dock-input'), { key: 'Escape' })
    expect(model.onExpandedChange).toHaveBeenCalledWith(false)
    expect(model.onSubmit).not.toHaveBeenCalled()
    expect(model.instruction).toBe('keep me')
  })

  it('offers a model select when the agent publishes models', () => {
    const model = dockModel({
      expanded: true,
      modelOptions: [
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' }
      ]
    })
    render(<TaskDock model={model} />)
    fireEvent.change(screen.getByTestId('task-dock-model'), { target: { value: 'sonnet' } })
    expect(model.onModelChange).toHaveBeenCalledWith('sonnet')
  })

  it('falls back to a free-text model id when no catalog exists', () => {
    const model = dockModel({ expanded: true })
    render(<TaskDock model={model} />)
    fireEvent.change(screen.getByTestId('task-dock-model'), { target: { value: 'ep-123' } })
    expect(model.onModelChange).toHaveBeenCalledWith('ep-123')
  })

  it('shows the failure and keeps the text editable', () => {
    const model = dockModel({ expanded: true, instruction: 'x', errorMessage: 'Could not create' })
    render(<TaskDock model={model} />)
    expect(screen.getByTestId('task-dock-error').textContent).toContain('Could not create')
  })

  it('locks the send button while submitting', () => {
    render(<TaskDock model={dockModel({ expanded: true, instruction: 'x', submitting: true })} />)
    expect(screen.getByTestId('task-dock-send')).toHaveProperty('disabled', true)
  })

  it('shows the target chip only when a target is selected', () => {
    render(<TaskDock model={dockModel({ expanded: true })} />)
    expect(screen.getByText('github · acme/widgets')).toBeTruthy()
    cleanup()
    render(<TaskDock model={dockModel({ expanded: true, targetLabel: null })} />)
    expect(screen.queryByText('github · acme/widgets')).toBeNull()
  })

  it('renders the draft transcript above the input and keeps the tones', () => {
    const model = dockModel({
      expanded: true,
      transcriptStatus: 'live',
      transcript: [
        { text: 'Draft workspace ready.', tone: 'meta' },
        { text: '> create the ticket', tone: 'user' },
        { text: 'Created #42 via github.createIssue', tone: 'agent' }
      ]
    })
    render(<TaskDock model={model} />)
    const panel = screen.getByTestId('task-dock-transcript')
    expect(panel.getAttribute('data-transcript-status')).toBe('live')
    expect([...panel.children].map((line) => line.textContent)).toEqual([
      'Draft workspace ready.',
      '> create the ticket',
      'Created #42 via github.createIssue'
    ])
    expect([...panel.children].map((line) => line.getAttribute('data-transcript-tone'))).toEqual([
      'meta',
      'user',
      'agent'
    ])
  })

  it('shows no transcript panel before a session exists', () => {
    render(<TaskDock model={dockModel({ expanded: true })} />)
    expect(screen.queryByTestId('task-dock-transcript')).toBeNull()
  })

  it('marks a finished session below the tail', () => {
    render(
      <TaskDock
        model={dockModel({
          expanded: true,
          transcriptStatus: 'ended',
          transcript: [{ text: 'agent exited' }]
        })}
      />
    )
    expect(screen.getByTestId('task-dock-transcript-ended').textContent).toContain('Session ended')
    cleanup()
    render(
      <TaskDock
        model={dockModel({ expanded: true, transcriptStatus: 'live', transcript: [{ text: 'x' }] })}
      />
    )
    expect(screen.queryByTestId('task-dock-transcript-ended')).toBeNull()
  })
})
