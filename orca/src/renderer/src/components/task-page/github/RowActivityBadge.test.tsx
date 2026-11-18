import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  getTaskPageGitHubRowActivityCopy,
  TaskPageGitHubRowActivityBadge
} from './RowActivityBadge'

/**
 * The badge's own contract, separate from the row that places it: every activity
 * kind maps to one locale-catalog label plus one sentence, and the `needs-you`
 * family is split by the F8 glyph it renders (failure / blocked / waiting /
 * interrupted) rather than collapsed into one vague sentence.
 */

function render(state: Parameters<typeof TaskPageGitHubRowActivityBadge>[0]['activity']): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TaskPageGitHubRowActivityBadge activity={state} />
    </TooltipProvider>
  )
}

const base = { workspaceCount: 1, agentCount: 1, taskKey: 'tracker:github:acme/web-app' }

describe('row activity badge copy', () => {
  it('labels each kind, and the delivered label never claims approval', () => {
    expect(getTaskPageGitHubRowActivityCopy({ ...base, kind: 'working', dotState: 'working' })).toEqual(
      { label: 'Working', detail: 'An agent is working in this task' }
    )
    expect(
      getTaskPageGitHubRowActivityCopy({ ...base, kind: 'delivered', dotState: 'done' })
    ).toEqual({ label: 'Delivered', detail: 'Delivered · agent done' })
    expect(
      getTaskPageGitHubRowActivityCopy({ ...base, kind: 'workspace', dotState: 'idle' })
    ).toEqual({
      label: 'Workspace',
      detail: 'A workspace is bound; no agent reported a turn'
    })
  })

  it('names the F8 mark the needs-you row is showing', () => {
    const detail = (dotState: 'failed' | 'blocked' | 'waiting' | 'interrupted'): string =>
      getTaskPageGitHubRowActivityCopy({ ...base, kind: 'needs-you', dotState }).detail
    expect(detail('failed')).toBe('An agent failed; the turn did not finish')
    expect(detail('blocked')).toBe('An agent is blocked')
    expect(detail('waiting')).toBe('An agent is waiting for your input')
    expect(detail('interrupted')).toBe('An agent’s turn was interrupted')
    expect(
      getTaskPageGitHubRowActivityCopy({ ...base, kind: 'needs-you', dotState: 'waiting' }).label
    ).toBe('Needs you')
  })
})

describe('row activity badge rendering', () => {
  it('renders the kind as a data attribute so the row test can find it', () => {
    expect(render({ ...base, kind: 'needs-you', dotState: 'blocked' })).toContain(
      'data-row-activity="needs-you"'
    )
    expect(render({ ...base, kind: 'delivered', dotState: 'done' })).toContain(
      'data-row-activity="delivered"'
    )
  })

  it('hides the decorative dot from assistive tech so the label is read once', () => {
    expect(render({ ...base, kind: 'working', dotState: 'working' })).toContain(
      'aria-hidden="true"'
    )
  })
})
