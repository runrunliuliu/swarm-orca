// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TaskWorkbenchHistory } from './TaskWorkbenchHistory'
import type {
  TaskWorkbenchHistory as HistoryFacts,
  TaskWorkbenchHistoryRun,
  TaskWorkbenchLayout,
  TaskWorkbenchView
} from './task-workbench-view'

/**
 * The run-history strip's record-sourced face (issue #53 read side).
 *
 * What this file owns: the copy and the presence of each fact a frozen record row
 * states — agent type, message count, the trace verdict, the resume offer or its
 * absence — and that one unreachable trace does not take the other rows with it.
 * Every expectation is a literal; the fixtures are synthetic (no host names, no
 * real paths, no run ids), and the record itself is exercised in
 * `task-workbench-history-merge.test.ts`, so nothing here re-derives a fold.
 */

const writeClipboardText = vi.fn()

beforeEach(() => {
  writeClipboardText.mockReset()
  writeClipboardText.mockResolvedValue(undefined)
  // Why: the resume action is wired to the renderer's clipboard helper, whose
  // only dependency is this IPC call. Nothing else about the page is faked.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LAYOUT: TaskWorkbenchLayout = {
  columns: 'double',
  delivery: 'expanded',
  agentHistory: 'expanded',
  spend: 'full',
  workspaces: 'full'
}

const RUN: TaskWorkbenchHistoryRun = {
  key: 'claude|session_id:run-1',
  title: 'Wire the history fold',
  agentType: 'claude',
  startedAt: 5_000,
  endedAt: 8_000,
  messageCount: 12,
  outcome: 'success',
  transcriptPath: '/fixtures/transcripts/run-1.jsonl',
  trace: { presence: 'present', checkedAt: 9_000 },
  resumable: true,
  resumeCommand: 'claude --resume run-1',
  checkoutPath: '/fixtures/wt',
  fromRecord: true
}

function view(history: HistoryFacts): TaskWorkbenchView {
  return {
    identity: { kind: 'workspace', primaryWorktreeId: 'wt-fixture' },
    title: 'Fix the flaky checkout',
    defaultWorkspace: { workspaceId: '', source: 'none' },
    agents: [],
    workspaces: [],
    spend: { kind: 'unavailable', reason: 'disabled' },
    history
  }
}

function history(overrides: Partial<HistoryFacts> = {}): HistoryFacts {
  return {
    agents: 1,
    wall: { kind: 'measured', startedAt: 5_000, endedAt: 8_000 },
    tokens: { kind: 'available', tokens: 420_000 },
    archivedWorkspaces: 1,
    deletedWorkspaces: 0,
    tokensSource: 'settled',
    workspaces: [
      {
        worktreeId: 'wt-fixture',
        path: '/fixtures/wt',
        state: 'archived',
        lastVerifiedAt: null,
        hasSessions: true
      }
    ],
    sessions: [],
    trace: 'archived',
    runs: [RUN],
    historySource: 'record',
    ...overrides
  }
}

function renderHistory(facts: HistoryFacts): void {
  render(<TaskWorkbenchHistory view={view(facts)} layout={LAYOUT} />)
}

describe('TaskWorkbenchHistory — facts from the record', () => {
  it('says the facts came from the record and prints type, message count and window', () => {
    renderHistory(history())

    // A1: the source is stated, not implied.
    expect(screen.getByTestId('task-workbench-history-record-source')).toHaveTextContent(
      'Facts from the record'
    )
    const row = screen.getByTestId('task-workbench-history-run')
    expect(row).toHaveAttribute('data-run-source', 'record')
    expect(row).toHaveTextContent('Wire the history fold')
    expect(row).toHaveTextContent('claude')
    expect(row).toHaveTextContent('12 messages')
    // The frozen figure is labelled as settled, never as a live reading.
    expect(screen.getByTestId('task-workbench-history-tokens-settled')).toHaveTextContent('settled')
  })

  it('offers resume on a row whose checkout is still there', () => {
    renderHistory(history())

    const row = screen.getByTestId('task-workbench-history-run')
    expect(within(row).getByTestId('task-workbench-history-run-resume')).toBeInTheDocument()
    expect(
      within(row).queryByTestId('task-workbench-history-run-no-resume')
    ).not.toBeInTheDocument()
    expect(within(row).getByTestId('task-workbench-history-run-locate')).toBeInTheDocument()
  })

  it('copies the recorded command for the archived checkout (A2)', async () => {
    renderHistory(history())

    const resume = screen.getByTestId('task-workbench-history-run-resume')
    // The checkout the command has to run in travels with the control, so the
    // offer is never a command without a directory.
    expect(resume).toHaveAttribute('data-checkout-path', '/fixtures/wt')
    expect(resume).toHaveTextContent('Copy resume command')

    fireEvent.click(resume)

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('claude --resume run-1'))
    // Copied is a state the reader can see, not just a clipboard side effect.
    await waitFor(() =>
      expect(screen.getByTestId('task-workbench-history-run-resume')).toHaveAttribute(
        'data-copy-status',
        'copied'
      )
    )
    expect(screen.getByTestId('task-workbench-history-run-resume')).toHaveTextContent('Copied')
  })

  it('disables the resume action when the record has no command', () => {
    renderHistory(
      history({ runs: [{ ...RUN, resumeCommand: undefined, checkoutPath: undefined }] })
    )

    const resume = screen.getByTestId('task-workbench-history-run-resume')
    expect(resume).toBeDisabled()
    // The reason is one sentence, not a silent dead control.
    expect(screen.getByText('No resume command was recorded for this run.')).toBeInTheDocument()
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('says no verdict was recorded on a record row with an unknown outcome (S2)', () => {
    renderHistory(history({ runs: [{ ...RUN, outcome: undefined }] }))

    const row = screen.getByTestId('task-workbench-history-run')
    expect(row).toHaveTextContent('no verdict recorded')
    expect(row).not.toHaveTextContent('done')
  })

  it("keeps the live arm's `done` for a live row with no outcome", () => {
    // The deleted form lists every row, live ones included, so this is where a
    // live row's own arm is visible.
    renderHistory(
      history({
        trace: 'deleted',
        historySource: 'mixed',
        runs: [{ key: 'pane-live', title: 'Live pane row', startedAt: 6_000, endedAt: 7_000 }]
      })
    )

    const row = screen.getByTestId('task-workbench-history-run')
    expect(row).toHaveAttribute('data-run-source', 'live')
    expect(row).toHaveTextContent('done')
  })

  it('says where a mixed list came from instead of claiming every row is a record (S7)', () => {
    renderHistory(history({ historySource: 'mixed' }))

    expect(screen.getByTestId('task-workbench-history-record-source')).toHaveTextContent(
      'Some facts from the record'
    )
  })

  it('does not repeat the live rows the Agents section already shows', () => {
    // A live row (a pane key, no `fromRecord`) beside a record row: the strip
    // lists only the recorded one, so one agent never appears twice on the page.
    renderHistory(
      history({
        runs: [{ key: 'pane-live', title: 'Live pane row', startedAt: 6_000, endedAt: 7_000 }, RUN]
      })
    )

    const rows = screen.getAllByTestId('task-workbench-history-run')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Wire the history fold')
  })
})

describe('TaskWorkbenchHistory — unreachable trace', () => {
  it('states the verdict on its own row and leaves the other rows readable', () => {
    renderHistory(
      history({
        agents: 2,
        runs: [
          { ...RUN, trace: { presence: 'missing', checkedAt: 9_000 } },
          {
            ...RUN,
            key: 'claude|session_id:run-2',
            title: 'Second recorded run',
            messageCount: 3,
            trace: { presence: 'present', checkedAt: 9_000 }
          }
        ]
      })
    )

    const rows = screen.getAllByTestId('task-workbench-history-run')
    expect(rows).toHaveLength(2)
    // A3: the reason is a sentence, and it says the file is gone rather than
    // printing a control that cannot work.
    expect(
      within(rows[0]).getByTestId('task-workbench-history-trace-unreachable')
    ).toHaveTextContent('Trace unreachable: the recorded file is gone.')
    expect(
      within(rows[0]).queryByTestId('task-workbench-history-run-locate')
    ).not.toBeInTheDocument()
    // The neighbour is untouched.
    expect(rows[1]).toHaveTextContent('Second recorded run')
    expect(rows[1]).toHaveTextContent('3 messages')
    expect(
      within(rows[1]).queryByTestId('task-workbench-history-trace-unreachable')
    ).not.toBeInTheDocument()
  })

  it('says a path this host cannot check is unverifiable, not gone', () => {
    renderHistory(
      history({ runs: [{ ...RUN, trace: { presence: 'unverifiable', checkedAt: 9_000 } }] })
    )

    expect(screen.getByTestId('task-workbench-history-trace-unreachable')).toHaveTextContent(
      'Trace unreachable: this host cannot check it.'
    )
  })
})

describe('TaskWorkbenchHistory — the deleted form', () => {
  it('keeps the recorded rows, drops the resume offer and never prints a zero', () => {
    renderHistory(
      history({
        trace: 'deleted',
        archivedWorkspaces: 0,
        deletedWorkspaces: 1,
        workspaces: [
          {
            worktreeId: 'wt-fixture',
            path: '/fixtures/wt',
            state: 'removed',
            lastVerifiedAt: null,
            hasSessions: true
          }
        ],
        tokens: { kind: 'unavailable', reason: 'unattributed' },
        tokensSource: 'live',
        sessions: [
          {
            key: 'claude|session_id:s-1',
            provider: 'claude',
            hasTranscriptPath: true,
            transcriptPath: '/fixtures/transcripts/s-1.jsonl',
            trace: { presence: 'unverifiable', checkedAt: 9_000 },
            resumable: false,
            worktreeId: 'wt-fixture'
          }
        ],
        runs: [{ ...RUN, resumable: false }]
      })
    )

    // T5: the recorded row is still listed and no longer offers resume.
    const row = screen.getByTestId('task-workbench-history-run')
    expect(row).toHaveTextContent('Wire the history fold')
    expect(within(row).getByTestId('task-workbench-history-run-no-resume')).toHaveTextContent(
      'Resume unavailable: its workspace was removed.'
    )
    expect(within(row).queryByTestId('task-workbench-history-run-resume')).not.toBeInTheDocument()
    // A2: an unknown figure is a word with a reason, not `0 tokens`.
    const facts = screen.getByTestId('task-workbench-history-facts')
    expect(facts).toHaveTextContent('tokens unknown')
    expect(facts).not.toHaveTextContent('0 tokens')
    expect(facts).not.toHaveTextContent('$0')
    // The strip-level sentence this form owns, not only the per-session verdict
    // below: the deleted form always says the recorded trace is out of reach.
    expect(screen.getByTestId('task-workbench-history-trace-lost')).toHaveTextContent(
      'Workspace deleted; the recorded trace is out of reach.'
    )
    // The session row states the path and its own verdict.
    const session = screen.getByTestId('task-workbench-history-session')
    expect(session).toHaveTextContent('transcript path recorded')
    expect(session).toHaveTextContent('Trace unreachable: this host cannot check it.')
  })

  it('prints only the deleted note when a removed binding outranks an archived one', () => {
    // `trace` is task-level and `removed` outranks `archived` in
    // task-workbench-history-merge.ts, so a task holding both kinds prints the
    // deleted sentence and no archive note. Pinned as-is, not redesigned: a
    // per-workspace note would be an owner decision.
    renderHistory(
      history({
        trace: 'deleted',
        archivedWorkspaces: 1,
        deletedWorkspaces: 1,
        workspaces: [
          {
            worktreeId: 'wt-archived',
            path: '/fixtures/archived',
            state: 'archived',
            lastVerifiedAt: null,
            hasSessions: true
          },
          {
            worktreeId: 'wt-gone',
            path: '/fixtures/gone',
            state: 'removed',
            lastVerifiedAt: null,
            hasSessions: true
          }
        ]
      })
    )

    expect(screen.getByTestId('task-workbench-history-trace-lost')).toHaveTextContent(
      'Workspace deleted; the recorded trace is out of reach.'
    )
    expect(screen.queryByTestId('task-workbench-history-archived-note')).not.toBeInTheDocument()
    // Only the strip-level sentence is task-wide: the archived checkout still has
    // its own row.
    expect(screen.getByText('/fixtures/archived')).toBeInTheDocument()
  })
})

describe('TaskWorkbenchHistory — recorded absences (T2 / B1)', () => {
  const GAP = {
    kind: 'session_unattributable' as const,
    candidateCount: 2,
    detail: 'no pane attribution',
    standalone: true
  }

  it('prints why no agent could be attributed, before the run list', () => {
    renderHistory(history({ runs: [], agents: null, gaps: [GAP] }))

    const gaps = screen.getByTestId('task-workbench-history-record-gaps')
    const gap = screen.getByTestId('task-workbench-history-record-gap')
    // T2: the page says the record could not attribute an agent — the sentence the
    // issue exists for — and the measured candidate count is quoted, not guessed.
    expect(gap).toHaveTextContent('No agent could be attributed to this workspace.')
    expect(gap).toHaveTextContent('(2 candidates)')
    expect(gap).toHaveAttribute('data-gap-kind', 'session_unattributable')
    expect(gap).toHaveAttribute('data-gap-context', 'standalone')
    // The writer's own reason is kept as the tooltip, never re-worded.
    expect(gap).toHaveAttribute('title', 'no pane attribution')

    const runs = screen.getByTestId('task-workbench-history-runs-none')
    expect(gaps.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps "no agent could be attributed" distinct from "no run recorded"', () => {
    renderHistory(history({ runs: [], agents: null, gaps: [GAP] }))
    // With a gap, the strip must not also print the flat "nothing ran" sentence.
    expect(screen.queryByTestId('task-workbench-history-runs-none')).toBeInTheDocument()
    expect(screen.getByTestId('task-workbench-history-record-gap')).toBeInTheDocument()
    cleanup()

    renderHistory(history({ runs: [], agents: null, gaps: [] }))
    // Without a gap the run list states its own absence and no attribution claim
    // is made.
    expect(screen.getByTestId('task-workbench-history-runs-none')).toHaveTextContent(
      'No run recorded.'
    )
    expect(screen.queryByTestId('task-workbench-history-record-gap')).not.toBeInTheDocument()
  })

  it('names the ambiguous kind with its own sentence', () => {
    renderHistory(
      history({
        runs: [],
        agents: null,
        gaps: [{ kind: 'ambiguous_match', candidateCount: 3, standalone: true }]
      })
    )

    expect(screen.getByTestId('task-workbench-history-record-gap')).toHaveTextContent(
      'The record could not decide which agent ran here.'
    )
  })

  it('reads one stored gap as provenance once the workspace has rows (seat B S5)', () => {
    const [enriched, quiet] = [{ ...GAP, standalone: false }, { ...GAP }]
    renderHistory(history({ gaps: [enriched] }))

    const gap = screen.getByTestId('task-workbench-history-record-gap')
    // Same testid, different reading: the rows below were attributed later, so the
    // sentence must not claim the workspace is unattributable.
    expect(gap).toHaveAttribute('data-gap-context', 'provenance')
    expect(gap).toHaveTextContent(
      'Recorded at archive time: no pane attribution; these rows were attributed later.'
    )
    expect(gap).not.toHaveTextContent('No agent could be attributed')
    cleanup()

    renderHistory(history({ runs: [], agents: null, gaps: [quiet] }))
    const standalone = screen.getByTestId('task-workbench-history-record-gap')
    expect(standalone).toHaveAttribute('data-gap-context', 'standalone')
    expect(standalone).toHaveTextContent('No agent could be attributed to this workspace.')
    expect(standalone).not.toHaveTextContent('Recorded at archive time')
  })

  it("renders the workspace row's session fact instead of leaving it computed", () => {
    renderHistory(history())

    expect(screen.getByTestId('task-workbench-history-workspace-sessions')).toHaveTextContent(
      'sessions recorded'
    )
    cleanup()

    renderHistory(
      history({
        workspaces: [
          {
            worktreeId: 'wt-fixture',
            path: '/fixtures/wt',
            state: 'archived',
            lastVerifiedAt: null,
            hasSessions: false
          }
        ]
      })
    )
    expect(screen.getByTestId('task-workbench-history-workspace-sessions')).toHaveTextContent(
      'no sessions recorded'
    )
  })
})

/**
 * G3: the task total states which of the four settlement states it is in. Each
 * one renders its own sentence, and no absence path renders `0 tokens` / `$0`
 * (README §7.5's fake zero).
 */
describe('TaskWorkbenchHistory — the four settlement states', () => {
  function factsText(): string {
    return screen.getByTestId('task-workbench-history-facts').textContent ?? ''
  }

  it('prints the measured figure when every contributing settlement is known', () => {
    renderHistory(history({ tokens: { kind: 'available', tokens: 420_000 } }))

    expect(factsText()).toContain('420.0k tokens')
    expect(screen.queryByTestId('task-workbench-history-tokens-detail')).not.toBeInTheDocument()
  })

  it('marks a subtotal partial instead of printing it as the whole total', () => {
    renderHistory(history({ tokens: { kind: 'partial', tokens: 500_000 } }))

    expect(factsText()).toContain('500.0k tokens (partial)')
    // A partial figure still carries a number, so it must not read as unknown —
    // and it is not 0 either.
    expect(factsText()).not.toContain('0 tokens')
    expect(screen.queryByTestId('task-workbench-history-tokens-detail')).not.toBeInTheDocument()
  })

  it('says this build captured no usage when the record froze no settlement', () => {
    renderHistory(history({ tokens: { kind: 'unknown' } }))

    expect(factsText()).toContain('tokens unknown')
    // Not the `no_matching_session` sentence: no scan ran, so nothing was found.
    expect(screen.getByTestId('task-workbench-history-tokens-detail')).toHaveTextContent(
      'This build did not capture usage for a closed workspace, so there is no total.'
    )
    expect(factsText()).not.toContain('0 tokens')
    expect(factsText()).not.toContain('$0')
  })

  it('states the measured reason when a workspace was measured and its figure is missing', () => {
    renderHistory(history({ tokens: { kind: 'unavailable', reason: 'scan_failed' } }))

    expect(factsText()).toContain('tokens unknown')
    expect(screen.getByTestId('task-workbench-history-tokens-detail')).toHaveTextContent(
      'The usage scan failed, so this figure could not be read.'
    )
    // The verbatim token stays one hover away (README §7.4.3).
    expect(screen.getByTitle('Scan failed')).toBeInTheDocument()
    expect(factsText()).not.toContain('0 tokens')
    expect(factsText()).not.toContain('$0')
  })
})
