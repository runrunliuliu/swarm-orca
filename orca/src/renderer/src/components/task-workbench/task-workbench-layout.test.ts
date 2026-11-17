import { describe, expect, it } from 'vitest'
import {
  TASK_WORKBENCH_NARROW_WIDTH,
  TASK_WORKBENCH_SHORT_HEIGHT,
  computeTaskWorkbenchLayout,
  type TaskWorkbenchLayout,
  type TaskWorkbenchLayoutInput
} from './task-workbench-layout'

/**
 * Acceptance criterion 1 of the P1a shell (p1a-ui-shell-plan.md §5.1): an
 * independent expected table. Every number below is copied from the contract
 * (counts from §4.2, sizes from §4.1) and every decision is written out by hand.
 * Nothing here calls the implementation to derive an answer, and no rule table
 * is re-encoded — if the module and this table disagree, one of them is wrong
 * and a human has to read which.
 */

type Counts = TaskWorkbenchLayoutInput['counts']

// Contract §4.2, verbatim. `agents === activeAgents + attentionAgents + historyAgents`
// in every row; the invariant test below enforces it.
const COUNTS = {
  F1: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  F2a: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  F2b: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  F3: { workspaces: 3, agents: 10, activeAgents: 4, attentionAgents: 1, historyAgents: 5 },
  F4: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  F5: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  F6: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  F7: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  F8: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  F9: { workspaces: 1, agents: 3, activeAgents: 2, attentionAgents: 0, historyAgents: 1 },
  F10: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  F11: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  F12: { workspaces: 1, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 }
} satisfies Record<string, Counts>

type Fixture = keyof typeof COUNTS

// The four fixed harness sizes, as literal pairs. Not computed from anything:
// `1100` and `480` are the calibrated boundaries the table has to pin.
const SIZES = {
  '1440x900': [1440, 900],
  '1100x800': [1100, 800],
  '1280x480': [1280, 480],
  '900x700': [900, 700]
} as const

type SizeLabel = keyof typeof SIZES

// fixture | size | columns | delivery | agentHistory | spend | workspaces
type Cell = readonly [
  Fixture,
  SizeLabel,
  TaskWorkbenchLayout['columns'],
  TaskWorkbenchLayout['delivery'],
  TaskWorkbenchLayout['agentHistory'],
  TaskWorkbenchLayout['spend'],
  TaskWorkbenchLayout['workspaces']
]

// 12 fixture groups × 4 sizes = 48 rows, one line each so the answers are
// readable without running anything. `F2` is one group because F2a and F2b carry
// identical counts (0/0/0/0/0) and no decision reads anything else, so their four
// cells coincide; the F2b test near the bottom pins that variant explicitly
// instead of repeating four identical rows (the contract's count table lists 13
// rows, the deliverable asks for 12 × 4 = 48).
//
// Rows repeat across fixtures because no fixture has 10+ history agents and no
// fixed size sits between 900 and 1100; the boundary assertions after this table
// are what stop that coincidence from hiding a bug.
const TABLE: readonly Cell[] = [
  // F1 — 1 workspace, 2 agents (1 active, 1 history)
  ['F1', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F1', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F1', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F1', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F2 — 0 workspaces (F2a tracker open, F2b tracker closed: identical counts)
  ['F2a', '1440x900', 'double', 'collapsed', 'expanded', 'summary', 'empty'],
  ['F2a', '1100x800', 'double', 'collapsed', 'expanded', 'summary', 'empty'],
  ['F2a', '1280x480', 'double', 'collapsed', 'expanded', 'summary', 'empty'],
  ['F2a', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'empty'],

  // F3 — 3 workspaces, 10 agents (5 history)
  ['F3', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F3', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F3', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F3', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F4 — usage disabled
  ['F4', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F4', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F4', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F4', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F5 — archived workspace only
  ['F5', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F5', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F5', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F5', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F6 — no tracker, local task
  ['F6', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F6', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F6', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F6', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F7 — remote / SSH workspace
  ['F7', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F7', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F7', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F7', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F8 — done + failure outcome
  ['F8', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F8', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F8', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F8', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F9 — long title, big numbers, many labels
  ['F9', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F9', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F9', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F9', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F10 — ambiguous_session
  ['F10', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F10', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F10', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F10', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F11 — no_matching_session
  ['F11', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F11', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F11', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F11', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full'],

  // F12 — 1 workspace, 0 agents
  ['F12', '1440x900', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F12', '1100x800', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F12', '1280x480', 'double', 'expanded', 'expanded', 'full', 'full'],
  ['F12', '900x700', 'single', 'collapsed', 'expanded', 'summary', 'full']
]

function layoutAt(
  width: number,
  height: number,
  counts: Partial<Counts> = {}
): TaskWorkbenchLayout {
  return computeTaskWorkbenchLayout({
    containerWidth: width,
    containerHeight: height,
    counts: {
      workspaces: 1,
      agents: 1,
      activeAgents: 1,
      attentionAgents: 0,
      historyAgents: 0,
      ...counts
    },
    mode: 'static'
  })
}

describe('computeTaskWorkbenchLayout — the fixed size table', () => {
  for (const [fixture, size, columns, delivery, agentHistory, spend, workspaces] of TABLE) {
    it(`${fixture} at ${size}`, () => {
      const [width, height] = SIZES[size]
      const actual = computeTaskWorkbenchLayout({
        containerWidth: width,
        containerHeight: height,
        counts: COUNTS[fixture],
        mode: 'static'
      })
      expect(actual).toEqual({ columns, delivery, agentHistory, spend, workspaces })
    })
  }

  it('covers every fixture group at every size exactly once', () => {
    expect(TABLE).toHaveLength(48)
    expect(new Set(TABLE.map(([fixture]) => fixture)).size).toBe(12)
    expect(new Set(TABLE.map(([fixture, size]) => `${fixture}@${size}`)).size).toBe(48)
  })

  it('gives F2b, folded into the F2 group above, the same four cells as F2a', () => {
    // The two variants differ only in tracker state, which no layout decision
    // reads, and they carry identical counts. Asserted, not assumed.
    expect(COUNTS.F2b).toEqual(COUNTS.F2a)
    for (const [size, [width, height]] of Object.entries(SIZES)) {
      const f2a = computeTaskWorkbenchLayout({
        containerWidth: width,
        containerHeight: height,
        counts: COUNTS.F2a,
        mode: 'static'
      })
      const f2b = computeTaskWorkbenchLayout({
        containerWidth: width,
        containerHeight: height,
        counts: COUNTS.F2b,
        mode: 'static'
      })
      expect(`${size}:${JSON.stringify(f2b)}`).toBe(`${size}:${JSON.stringify(f2a)}`)
    }
  })
})

describe('counts', () => {
  it('splits agents exactly into active, attention and history', () => {
    for (const [fixture, counts] of Object.entries(COUNTS)) {
      const split = counts.activeAgents + counts.attentionAgents + counts.historyAgents
      expect(`${fixture}:${split}`).toBe(`${fixture}:${counts.agents}`)
    }
  })

  it('keeps the fixture counts the contract pinned', () => {
    expect(COUNTS.F1).toEqual({
      workspaces: 1,
      agents: 2,
      activeAgents: 1,
      attentionAgents: 0,
      historyAgents: 1
    })
    expect(COUNTS.F3).toEqual({
      workspaces: 3,
      agents: 10,
      activeAgents: 4,
      attentionAgents: 1,
      historyAgents: 5
    })
    expect(COUNTS.F5).toEqual({
      workspaces: 1,
      agents: 1,
      activeAgents: 0,
      attentionAgents: 0,
      historyAgents: 1
    })
    expect(COUNTS.F9).toEqual({
      workspaces: 1,
      agents: 3,
      activeAgents: 2,
      attentionAgents: 0,
      historyAgents: 1
    })
    expect(COUNTS.F12).toEqual({
      workspaces: 1,
      agents: 0,
      activeAgents: 0,
      attentionAgents: 0,
      historyAgents: 0
    })
  })
})

describe('zero workspaces', () => {
  it('is an empty Workspaces block with summary Spend at every size', () => {
    for (const size of Object.values(SIZES)) {
      const [width, height] = size
      for (const fixture of ['F2a', 'F2b'] as const) {
        const actual = computeTaskWorkbenchLayout({
          containerWidth: width,
          containerHeight: height,
          counts: COUNTS[fixture],
          mode: 'static'
        })
        expect(actual.workspaces).toBe('empty')
        expect(actual.spend).toBe('summary')
        // Delivery is the first thing sacrificed, so it never expands without evidence.
        expect(actual.delivery).toBe('collapsed')
      }
    }
  })
})

describe('boundaries', () => {
  it('pins the two design thresholds', () => {
    expect(TASK_WORKBENCH_NARROW_WIDTH).toBe(1100)
    expect(TASK_WORKBENCH_SHORT_HEIGHT).toBe(480)
  })

  it('treats exactly 1100 as double column and 1099 as single', () => {
    expect(layoutAt(1100, 900).columns).toBe('double')
    expect(layoutAt(1099, 900)).toEqual({
      columns: 'single',
      delivery: 'collapsed',
      agentHistory: 'expanded',
      spend: 'summary',
      workspaces: 'full'
    })
  })

  it('treats exactly 480 as not short', () => {
    expect(layoutAt(1280, 480)).toEqual({
      columns: 'double',
      delivery: 'expanded',
      agentHistory: 'expanded',
      spend: 'full',
      workspaces: 'full'
    })
  })

  it('treats 479 as short: compact Workspaces, collapsed Delivery and history, summary Spend', () => {
    expect(layoutAt(1280, 479)).toEqual({
      columns: 'double',
      delivery: 'collapsed',
      agentHistory: 'collapsed',
      spend: 'summary',
      workspaces: 'compact'
    })
  })

  it('collapses history at 10 history agents and expands below it', () => {
    const history = (count: number): Partial<Counts> => ({
      agents: count,
      activeAgents: 0,
      historyAgents: count
    })
    expect(layoutAt(1440, 900, history(10)).agentHistory).toBe('collapsed')
    expect(layoutAt(1440, 900, history(9)).agentHistory).toBe('expanded')
  })

  it('is total on an empty container and on zero counts', () => {
    expect(layoutAt(0, 0, { workspaces: 0, agents: 0, activeAgents: 0, historyAgents: 0 })).toEqual(
      {
        columns: 'single',
        delivery: 'collapsed',
        agentHistory: 'collapsed',
        spend: 'summary',
        workspaces: 'empty'
      }
    )
  })
})
