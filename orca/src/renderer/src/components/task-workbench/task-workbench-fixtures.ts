import {
  LEDGER_AGENTS,
  REMOTE_TOKENS,
  SUB_JWT,
  TWO_AGENTS,
  WS_ARCHIVED,
  WS_API,
  WS_FLAKY,
  WS_LEDGER,
  WS_LOGIN,
  WS_PERF,
  WS_REMOTE,
  WS_SPIKE,
  availableSpend,
  deliveryEvidence,
  providerSpend,
  row,
  rollup,
  tracked,
  vault,
  workspace,
  zeroWorkspace
} from './task-workbench-fixtures-support'
import type { TaskWorkbenchView } from './task-workbench-view'

/**
 * The twelve P1a workbench scenarios (p1a-ui-shell-plan.md §3), as data only.
 *
 * Why this file exists: P1a has no selector, so the rendered harness needs one
 * deterministic view per scenario. Nothing here reads a store, RPC or IPC, and
 * no component may import it — the harness is its only consumer. The builders
 * live in task-workbench-fixtures-support.ts to stay inside the .ts line budget.
 *
 * The scenario keys are the harness CLI argument and therefore a contract; the
 * per-fixture counts are fixed by 00-contract.md §4.2.
 */

export type TaskWorkbenchFixture = {
  view: TaskWorkbenchView
  label: string
  summary: string
}

export const TASK_WORKBENCH_FIXTURES = {
  f1_baseline: {
    label: 'F1 · baseline',
    summary: 'One workspace, a working and a finished agent, mixed priced and unpriced spend.',
    view: tracked('Add login auth', WS_LOGIN, 'open', {
      agents: TWO_AGENTS,
      spend: availableSpend(1_302_000, null, [
        providerSpend('claude', 412_000, 1.2),
        providerSpend('codex', 890_000, null)
      ]),
      delivery: deliveryEvidence(3, [431, 'draft'], [5, 6], 'pending')
    })
  },

  f2a_zero_workspace_open: {
    label: 'F2a · zero workspaces, tracker open',
    summary: 'No workspace, open tracker: create is primary, spend has no matching session.',
    view: zeroWorkspace('Rotate the deploy token', 'open')
  },

  f2b_zero_workspace_closed: {
    label: 'F2b · zero workspaces, tracker closed',
    summary: 'A closed tracker with no workspace must not render as delivered.',
    view: zeroWorkspace('Retire the legacy deploy script', 'closed')
  },

  f3_many_workspaces_agents: {
    label: 'F3 · many workspaces and agents',
    summary: 'Three workspaces and ten agents across active, needs-you and history.',
    view: tracked('Sparse task workspace rollout', WS_LOGIN, 'open', {
      agents: [
        row('f3a', 'claude', 'working', 'Wire JWT', rollup(412_000), { subagents: [SUB_JWT] }),
        row('f3-2', 'codex', 'working', 'Verify JWT', rollup(233_000), { ws: WS_API }),
        row('f3-3', 'opencode', 'working', 'Profile lookup', vault(61_000), { ws: WS_SPIKE }),
        row('f3-4', 'gemini', 'working', 'Draft migration notes', rollup(18_000)),
        row('f3-5', 'claude', 'attention', 'Approve dependency upgrade', rollup(9_000)),
        row('f3-6', 'claude', 'done', 'Add the login route', vault(890_000)),
        row('f3-7', 'codex', 'done', 'Extract token parser', rollup(120_000)),
        row('f3-8', 'opencode', 'idle', 'Spike perf counters', vault(44_000)),
        row('f3-9', 'gemini', 'done', 'Write auth tests', rollup(76_000)),
        row('f3-10', 'claude', 'idle', 'Tidy feature flags', rollup(12_000))
      ],
      workspaces: [WS_LOGIN, WS_API, WS_SPIKE],
      spend: availableSpend(1_875_000, 4.65, [
        providerSpend('claude', 1_323_000, 3.21),
        providerSpend('codex', 552_000, 1.44)
      ])
    })
  },

  f4_usage_disabled: {
    label: 'F4 · usage tracking disabled',
    summary: 'Usage tracking is off: an empty spend state with a CTA, never $0.',
    view: tracked('Add login auth', WS_LOGIN, 'open', {
      agents: TWO_AGENTS,
      spend: { kind: 'unavailable', reason: 'disabled' }
    })
  },

  f5_archived_only: {
    label: 'F5 · archived workspace only',
    summary: 'The only workspace is archived and its single agent is done.',
    view: tracked('Retire the old billing export', WS_ARCHIVED, 'open', {
      agents: [row('f5-1', 'codex', 'done', 'Remove the legacy export', vault(120_000))],
      spend: availableSpend(120_000, 0.31, [providerSpend('codex', 120_000, 0.31)])
    })
  },

  f6_no_tracker: {
    label: 'F6 · local task without a tracker',
    summary: 'A local task: no-tracker badge, display name as title, no PR evidence.',
    view: {
      identity: { kind: 'workspace', primaryWorktreeId: WS_PERF.worktreeId },
      title: WS_PERF.worktreeName,
      defaultWorkspace: { workspaceId: WS_PERF.worktreeId, source: 'explicit' },
      agents: [row('f6-1', 'claude', 'working', 'Profile the session lookup', rollup(64_000))],
      workspaces: [WS_PERF],
      spend: availableSpend(64_000, 0.19, [providerSpend('claude', 64_000, 0.19)])
    }
  },

  f7_remote_workspace: {
    label: 'F7 · remote workspace',
    summary: 'An SSH workspace whose usage is unavailable with the remote_host reason.',
    view: tracked('Backfill the audit log', WS_REMOTE, 'open', {
      agents: [row('f7-1', 'codex', 'working', 'Backfill audit log', REMOTE_TOKENS)],
      spend: { kind: 'unavailable', reason: 'remote_host' }
    })
  },

  f8_failure_outcome: {
    label: 'F8 · failed agent outcome',
    summary: 'A finished agent whose outcome is failure must never read as delivered.',
    view: tracked('Fix the flaky checkout test', WS_FLAKY, 'open', {
      agents: [
        row('f8-1', 'claude', 'done', 'Fix flaky checkout', rollup(88_000), { outcome: 'failure' })
      ],
      spend: availableSpend(88_000, 0.22, [providerSpend('claude', 88_000, 0.22)]),
      delivery: deliveryEvidence(2, [433, 'open'], [3, 6], 'changes-requested')
    })
  },

  f9_long_labels: {
    label: 'F9 · long labels and large numbers',
    summary: 'A 200+ character title, long names, large token counts and four provider rows.',
    view: tracked(
      'Investigate and repair the intermittent checkout failure that appears when a sparse task workspace rehydrates a large monorepo while the remote build cache is still warming, covering the fallback path, the retry budget, and the telemetry gap that hides the first failure from the dashboard',
      workspace(
        'web-app-monorepo-with-a-very-long-display-name',
        'feature/a-very-long-worktree-branch-name-that-keeps-going-for-a-while'
      ),
      'open',
      {
        agents: [
          row('f9-1', 'claude', 'working', 'Investigate checkout failure', rollup(1_284_000)),
          row('f9-2', 'codex', 'working', 'Replay the retry budget', vault(902_000)),
          row('f9-3', 'opencode', 'done', 'Summarize the telemetry gap', vault(61_000))
        ],
        spend: availableSpend(2_269_000, null, [
          providerSpend('claude', 1_284_000, 3.14),
          providerSpend('codex', 902_000, null),
          providerSpend('opencode', 61_000, 0.15),
          providerSpend('gemini', 22_000, 0.05)
        ])
      }
    )
  },

  f10_ambiguous_session: {
    label: 'F10 · ambiguous session',
    summary: 'Spend is unavailable because session attribution is ambiguous; no guess.',
    view: tracked('Reconcile the usage ledger', WS_LEDGER, 'open', {
      agents: LEDGER_AGENTS,
      spend: { kind: 'unavailable', reason: 'ambiguous_session' }
    })
  },

  f11_no_matching_session: {
    label: 'F11 · no matching session',
    summary: 'Spend is unavailable because no session matched the task window.',
    view: tracked('Reconcile the usage ledger', WS_LEDGER, 'open', {
      agents: LEDGER_AGENTS,
      spend: { kind: 'unavailable', reason: 'no_matching_session' }
    })
  },

  f12_new_workspace_no_agents: {
    label: 'F12 · new workspace without agents',
    summary: 'A freshly created workspace with no agents and no matching session.',
    view: tracked('Add login auth', WS_LOGIN, 'open', {
      agents: [],
      spend: { kind: 'unavailable', reason: 'no_matching_session' }
    })
  }
} satisfies Record<string, TaskWorkbenchFixture>

export type TaskWorkbenchFixtureKey = keyof typeof TASK_WORKBENCH_FIXTURES

const FIXTURES_BY_KEY = new Map(Object.entries(TASK_WORKBENCH_FIXTURES))

/** Unknown keys return `undefined` (not a throw) so the harness can report the
 *  miss itself; a Map also keeps inherited names such as `toString` out. */
export function getTaskWorkbenchFixture(key: string): TaskWorkbenchFixture | undefined {
  return FIXTURES_BY_KEY.get(key)
}
