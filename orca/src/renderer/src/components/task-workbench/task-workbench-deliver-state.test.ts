import { describe, expect, it } from 'vitest'
import { TASK_WORKBENCH_FIXTURES } from './task-workbench-fixtures'
import { row, rollup, workspace } from './task-workbench-fixtures-support'
import { projectTaskWorkbenchDeliver } from './task-workbench-deliver-state'
import type { TaskWorkbenchDeliverProjection } from './task-workbench-deliver-state'
import type {
  AgentRowView,
  DeliveryEvidence,
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from './task-workbench-view'

/**
 * The state/action projection of the delivery entry (README §7.11.3 rule 4,
 * A5/A6/A7/A8).
 *
 * Why these tests look the way they do: every state must be reachable from data
 * the workbench already has, so each case below is either a committed fixture or
 * a view built from the committed fixture builders — never a copy of a
 * component's DOM. The purity cases exist because both delivery entries share
 * this function: it must be callable twice, on frozen input, with no store or
 * RPC stub in the file.
 */

const LIVE = workspace('web-app', 'feature/deliver-live')
const OTHER = workspace('api', 'feature/deliver-other')
const ARCHIVED = workspace('web-app', 'feature/deliver-archived', { archived: true })
const MAIN = workspace('web-app', 'main', { isMainWorktree: true })
const FOLDER = workspace('web-app', 'notes', { workspaceKind: 'folder' })

function makeView(overrides: Partial<TaskWorkbenchView> = {}): TaskWorkbenchView {
  return {
    identity: { kind: 'workspace', primaryWorktreeId: LIVE.worktreeId },
    title: 'Delivery entry',
    defaultWorkspace: { workspaceId: LIVE.worktreeId, source: 'explicit' },
    agents: [],
    workspaces: [LIVE],
    spend: { kind: 'unavailable', reason: 'no_matching_session' },
    ...overrides
  }
}

function agentRow(
  key: string,
  ws: TaskWorkbenchWorkspace,
  bucket: 'working' | 'attention' | 'done' | 'idle',
  extra: { conversationName?: string; archivedWorkspace?: boolean } = {}
): AgentRowView {
  const built = row(key, 'claude', bucket, 'Deliver the change', rollup(1000), {
    ws,
    archivedWorkspace: extra.archivedWorkspace
  })
  if (extra.conversationName === undefined) {
    return built
  }
  return { ...built, base: { ...built.base, conversationName: extra.conversationName } }
}

function evidence(overrides: Partial<DeliveryEvidence> = {}): DeliveryEvidence {
  return { commits: { count: 0 }, ...overrides }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      deepFreeze(inner)
    }
    Object.freeze(value)
  }
  return value
}

describe('projectTaskWorkbenchDeliver — which workspace it targets', () => {
  it('no-workspace: a task with no workspace at all has no delivery action', () => {
    // Committed fixture F2a: no workspace, tracker open.
    const projection = projectTaskWorkbenchDeliver(TASK_WORKBENCH_FIXTURES.f2a_zero_workspace_open.view)
    expect(projection.state).toBe('no-workspace')
    expect(projection.workspaceId).toBeUndefined()
    expect(projection.action).toEqual({ kind: 'none' })
    expect(projection.attention).toEqual([])
  })

  it('archived: the only workspace is archived, so the row is history and offers nothing', () => {
    // F2c and F5 are the committed archived-only views.
    for (const fixture of [
      TASK_WORKBENCH_FIXTURES.f2c_archived_only_closed,
      TASK_WORKBENCH_FIXTURES.f5_archived_only
    ]) {
      const projection = projectTaskWorkbenchDeliver(fixture.view)
      expect(projection.state).toBe('archived')
      expect(projection.action).toEqual({ kind: 'none' })
      expect(projection.workspaceId).toBe('wt-feature-retire-export')
      expect(projection.attention).toEqual([])
    }
  })

  it('archived: an explicit id that names an archived workspace is still archived', () => {
    const view = makeView({ workspaces: [LIVE, ARCHIVED] })
    const projection = projectTaskWorkbenchDeliver(view, ARCHIVED.worktreeId)
    expect(projection.state).toBe('archived')
    expect(projection.action).toEqual({ kind: 'none' })
  })

  it('an explicit workspaceId wins over the default workspace', () => {
    const view = makeView({
      agents: [agentRow('p1', LIVE, 'working')],
      workspaces: [LIVE, OTHER]
    })
    const projection = projectTaskWorkbenchDeliver(view, OTHER.worktreeId)
    // The working row belongs to LIVE, so OTHER has no writer: the entry is live.
    expect(projection.workspaceId).toBe(OTHER.worktreeId)
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })

  it('an explicit id that resolves to nothing is not a licence to deliver elsewhere', () => {
    const projection = projectTaskWorkbenchDeliver(makeView(), 'wt-not-in-this-view')
    expect(projection.state).toBe('no-workspace')
    expect(projection.action).toEqual({ kind: 'none' })
  })

  it('a default workspace that is archived is skipped in favour of a live one', () => {
    const view = makeView({
      defaultWorkspace: { workspaceId: ARCHIVED.worktreeId, source: 'recent-activity' },
      workspaces: [LIVE, ARCHIVED]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.workspaceId).toBe(LIVE.worktreeId)
    expect(projection.state).toBe('evidence-not-read')
  })

  it('a stale default id falls back to the first live workspace', () => {
    const view = makeView({
      defaultWorkspace: { workspaceId: 'wt-persisted-before-the-field-existed', source: 'none' },
      workspaces: [ARCHIVED, LIVE]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.workspaceId).toBe(LIVE.worktreeId)
  })

  it('never upgrades the default-workspace source into a primary', () => {
    const projection = projectTaskWorkbenchDeliver(
      makeView({ defaultWorkspace: { workspaceId: LIVE.worktreeId, source: 'recent-activity' } })
    )
    // README §7.5: `recent-activity` must not masquerade as a user's choice, so
    // the projection carries no primary-ish field at all.
    expect(Object.keys(projection).sort()).toEqual([
      'action',
      'attention',
      'facts',
      'state',
      'workspaceId'
    ])
  })
})

describe('projectTaskWorkbenchDeliver — the primary checkout is not a delivery target', () => {
  it('linked-main-only: the repository’s own checkout gets no entry (A9)', () => {
    // A9: the agent hosts in the delivered workspace, never in the primary
    // checkout. The sidebar already hides a main worktree from its archivable
    // targets; this is the same rule applied where the projection chooses, so
    // the task-page route cannot launch there either.
    const view = makeView({
      defaultWorkspace: { workspaceId: MAIN.worktreeId, source: 'explicit' },
      workspaces: [MAIN]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('no-workspace')
    expect(projection.workspaceId).toBeUndefined()
    expect(projection.action).toEqual({ kind: 'none' })
  })

  it('main + a dedicated worktree: the dedicated worktree is chosen', () => {
    const view = makeView({
      defaultWorkspace: { workspaceId: MAIN.worktreeId, source: 'explicit' },
      workspaces: [MAIN, LIVE]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.workspaceId).toBe(LIVE.worktreeId)
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })

  it('an explicit main-checkout id is not a licence to deliver there', () => {
    const view = makeView({ workspaces: [MAIN, LIVE] })
    const projection = projectTaskWorkbenchDeliver(view, MAIN.worktreeId)
    expect(projection.state).toBe('no-workspace')
    expect(projection.action).toEqual({ kind: 'none' })
  })

  it('a folder workspace is skipped and never selected explicitly', () => {
    // A folder workspace has no git worktree to deliver from, so it is treated
    // like the primary checkout: skipped when choosing, `none` when named.
    const folderOnly = makeView({
      defaultWorkspace: { workspaceId: FOLDER.worktreeId, source: 'explicit' },
      workspaces: [FOLDER]
    })
    expect(projectTaskWorkbenchDeliver(folderOnly).action).toEqual({ kind: 'none' })
    expect(
      projectTaskWorkbenchDeliver(
        makeView({ workspaces: [FOLDER, LIVE] }),
        FOLDER.worktreeId
      ).action
    ).toEqual({ kind: 'none' })
    expect(
      projectTaskWorkbenchDeliver(makeView({ workspaces: [FOLDER, LIVE] })).workspaceId
    ).toBe(LIVE.worktreeId)
  })
})

describe('projectTaskWorkbenchDeliver — one writer', () => {
  it('one-writer: a working agent of the target workspace disables the entry with the frozen reason', () => {
    // Committed fixture F1: WS_LOGIN has a working row and a done row.
    const projection = projectTaskWorkbenchDeliver(TASK_WORKBENCH_FIXTURES.f1_baseline.view)
    expect(projection.state).toBe('one-writer')
    expect(projection.action).toEqual({
      kind: 'deliver',
      enabled: false,
      disabledReason: {
        key: 'auto.components.TaskWorkbenchDeliver.disabledWorking',
        fallback: 'A working agent already owns this workspace; delivery waits for one writer.'
      }
    })
    // The reason is copy, never a state word or a count.
    expect(projection.attention).toEqual([])
  })

  it('one-writer: a working row of an archived workspace is history, not the writer', () => {
    const view = makeView({
      agents: [agentRow('a1', LIVE, 'working', { archivedWorkspace: true })]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })

  it('one-writer: a working row of a different workspace does not disable the target', () => {
    const view = makeView({
      agents: [agentRow('a1', OTHER, 'working')],
      workspaces: [LIVE, OTHER]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })
})

describe('projectTaskWorkbenchDeliver — an existing DELIVER session', () => {
  it('deliver-session: the marker row becomes open-terminal and outranks one-writer', () => {
    const view = makeView({
      agents: [
        agentRow('a1', LIVE, 'working'),
        agentRow('a2', LIVE, 'working', { conversationName: 'DELIVER' })
      ]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('deliver-session')
    expect(projection.action).toEqual({ kind: 'open-terminal', paneKey: 'pane-a2' })
    expect(projection.attention).toEqual([])
  })

  it('deliver-session: the marker is exact — a renamed tab is not the session', () => {
    const view = makeView({
      agents: [agentRow('a1', LIVE, 'done', { conversationName: 'DELIVER fix-431' })]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })

  it('deliver-session: a marker row of another workspace is not this workspace session', () => {
    const view = makeView({
      agents: [agentRow('a1', OTHER, 'working', { conversationName: 'DELIVER' })],
      workspaces: [LIVE, OTHER]
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('evidence-not-read')
  })
})

describe('projectTaskWorkbenchDeliver — evidence states', () => {
  it('evidence-not-read: no delivery on the view still offers the hand-off', () => {
    // Committed fixture F12: a fresh workspace, delivery never read.
    const projection = projectTaskWorkbenchDeliver(
      TASK_WORKBENCH_FIXTURES.f12_new_workspace_no_agents.view
    )
    expect(projection.state).toBe('evidence-not-read')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
    expect(projection.attention).toEqual([])
  })

  it('zero-evidence: read, and there are zero commits and no PR', () => {
    const view = makeView({
      agents: [agentRow('a1', LIVE, 'done')],
      delivery: evidence()
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('zero-evidence')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })

  it('has-evidence: commits are evidence and never become a count in the projection', () => {
    const view = makeView({ delivery: evidence({ commits: { count: 3, lastSubject: 'Wire JWT' } }) })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('has-evidence')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
    expect(JSON.stringify([projection.state, projection.action, projection.attention])).not.toContain(
      '3'
    )
  })

  it('has-evidence: a PR with zero commits is evidence too', () => {
    const view = makeView({
      delivery: evidence({
        pullRequest: {
          number: 431,
          state: 'draft',
          title: 'Deliver',
          url: 'https://github.com/acme/web-app/pull/431'
        }
      })
    })
    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('has-evidence')
    expect(projection.action).toEqual({ kind: 'deliver', enabled: true })
  })
})

describe('projectTaskWorkbenchDeliver — unknown is not zero, no invented words', () => {
  /** No copy-bearing field may carry a digit: a digit there would be a count (or
   *  a state word carrying one) the projection guessed. `paneKey` is deliberately
   *  not checked — it is an identifier, not copy. */
  function copySentences(projection: TaskWorkbenchDeliverProjection): string[] {
    return [
      ...projection.attention.map((notice) => `${notice.key} ${notice.fallback}`),
      ...(projection.action.kind === 'deliver' && !projection.action.enabled
        ? [`${projection.action.disabledReason.key} ${projection.action.disabledReason.fallback}`]
        : [])
    ]
  }

  /** The action descriptor never carries a number. Kept separate from the copy
   *  check: the intent is "no invented count", and a `paneKey` is not a count. */
  function carriesNumber(value: unknown): boolean {
    if (typeof value === 'number') {
      return true
    }
    if (Array.isArray(value)) {
      return value.some(carriesNumber)
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value).some(carriesNumber)
    }
    return false
  }

  it('emits only { key, fallback } copy, no count and no status word, for every fixture', () => {
    for (const fixture of Object.values(TASK_WORKBENCH_FIXTURES)) {
      const projection = projectTaskWorkbenchDeliver(fixture.view)
      expect(projection.attention).toEqual([])
      expect(projection.state).not.toContain('0')
      for (const sentence of copySentences(projection)) {
        expect(sentence).not.toMatch(/\d/)
      }
      expect(carriesNumber(projection.action)).toBe(false)
    }
  })
})

describe('projectTaskWorkbenchDeliver — the 注意 line never intercepts', () => {
  /** The delivery object a future evidence source would hand over: the declared
   *  shape plus the one extra fact. Typed, not cast, so the extra key is
   *  checked rather than asserted. */
  function deliveryWithNotice(
    delivery: DeliveryEvidence,
    attention: readonly { key: string; fallback: string }[]
  ): DeliveryEvidence & { attention: typeof attention } {
    return { ...delivery, attention }
  }

  it('projects the identical state and action for every fixture whatever 注意 carries', () => {
    const notice = [
      { key: 'auto.components.TaskWorkbenchDeliver.attention', fallback: 'Uncommitted work.' }
    ]
    for (const fixture of Object.values(TASK_WORKBENCH_FIXTURES)) {
      const base: TaskWorkbenchView = fixture.view
      const plain = projectTaskWorkbenchDeliver(base)
      // A future evidence source would arrive as extra data on the view; the
      // projection must not read it, so the action cannot be intercepted. The
      // extra key is typed instead of cast: an intersection is assignable to
      // the view, and TS still checks every declared field.
      const withNotice: TaskWorkbenchView & { attention: typeof notice } = {
        ...base,
        attention: notice
      }
      const withDeliveryNotice = projectTaskWorkbenchDeliver({
        ...base,
        delivery:
          base.delivery === undefined
            ? undefined
            : deliveryWithNotice(base.delivery, notice)
      })
      expect(projectTaskWorkbenchDeliver(withNotice)).toEqual(plain)
      expect(withDeliveryNotice).toEqual(plain)
    }
  })
})

describe('projectTaskWorkbenchDeliver — purity', () => {
  it('the same input projected twice gives a deep-equal output', () => {
    for (const fixture of Object.values(TASK_WORKBENCH_FIXTURES)) {
      expect(projectTaskWorkbenchDeliver(fixture.view)).toEqual(
        projectTaskWorkbenchDeliver(fixture.view)
      )
    }
  })

  it('reads a frozen view without writing to it', () => {
    const view = deepFreeze(
      makeView({
        agents: [agentRow('a1', LIVE, 'working', { conversationName: 'DELIVER' })],
        delivery: evidence({ commits: { count: 1 } })
      })
    )
    // Strict mode: an assignment to a frozen property throws, so a projection
    // that memoised onto its input would fail here.
    expect(projectTaskWorkbenchDeliver(view).state).toBe('deliver-session')
  })

})

describe('projectTaskWorkbenchDeliver — delivered (§7.12 A6/A8)', () => {
  const MERGED = workspace('web-app', 'feature/deliver-merged', {
    workspaceStatusId: 'completed',
    workspaceStatusLabel: 'Done',
    review: { number: 431, state: 'merged' }
  })

  it('completed ∧ merged reads `completed`, with the PR fact and Open session', () => {
    const view = makeView({
      workspaces: [MERGED],
      agents: [agentRow('a1', MERGED, 'done', { conversationName: 'DELIVER' })]
    })

    const projection = projectTaskWorkbenchDeliver(view)
    expect(projection.state).toBe('completed')
    expect(projection.facts.pullRequest).toEqual({ number: 431, state: 'merged' })
    expect(projection.action).toEqual({ kind: 'open-session', paneKey: 'pane-a1' })
    // No new status word and no count in the copy-bearing fields.
    expect(projection.attention).toEqual([])
  })

  it('completed alone is not delivered: the status is user data (§7.12 D3)', () => {
    expect(
      projectTaskWorkbenchDeliver(
        makeView({ workspaces: [{ ...MERGED, review: { number: 431, state: 'open' } }] })
      ).state
    ).not.toBe('completed')
  })

  it('merged alone is not delivered: the workspace was never marked completed', () => {
    expect(
      projectTaskWorkbenchDeliver(
        makeView({ workspaces: [{ ...MERGED, workspaceStatusId: undefined }] })
      ).state
    ).not.toBe('completed')
  })

  it('a delivered workspace with no marker row has no action to open', () => {
    const projection = projectTaskWorkbenchDeliver(makeView({ workspaces: [MERGED] }))
    expect(projection.state).toBe('completed')
    expect(projection.action).toEqual({ kind: 'none' })
    expect(projection.facts.pullRequest).toEqual({ number: 431, state: 'merged' })
  })

  it('an archived delivered workspace keeps its facts and offers no action (A8)', () => {
    const archived = { ...MERGED, archived: true }
    const projection = projectTaskWorkbenchDeliver(makeView({ workspaces: [archived] }))
    expect(projection.state).toBe('archived')
    expect(projection.facts.pullRequest).toEqual({ number: 431, state: 'merged' })
    expect(projection.action).toEqual({ kind: 'none' })
  })

  it('the issue fact exists only when the view carries a number (A3/A7)', () => {
    const withoutNumber = projectTaskWorkbenchDeliver(
      makeView({
        tracker: { state: 'closed', url: 'https://github.com/acme/web-app/issues/412' }
      })
    )
    expect(withoutNumber.facts.issue).toBeUndefined()

    const withNumber = projectTaskWorkbenchDeliver(
      makeView({
        tracker: { state: 'closed', url: 'https://github.com/acme/web-app/issues/412', number: 412 }
      })
    )
    expect(withNumber.facts.issue).toEqual({ number: 412, state: 'closed' })
  })

  it('an absent commit source is never read as zero evidence (A7)', () => {
    // `delivery.commits` is optional: no source is not `0 commits`.
    const projection = projectTaskWorkbenchDeliver(
      makeView({
        delivery: {
          pullRequest: {
            number: 431,
            state: 'open'
          }
        }
      })
    )
    expect(projection.state).toBe('has-evidence')
    expect(projection.facts.pullRequest).toEqual({ number: 431, state: 'open' })
  })
})
