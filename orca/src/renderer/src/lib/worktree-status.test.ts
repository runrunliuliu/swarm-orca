import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TitleDerivedPaneForeground } from '@/components/sidebar/title-derived-pane-agent-identity'
import { getWorktreeStatus, getWorktreeStatusLabel, resolveWorktreeStatus } from './worktree-status'

const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

// Why: build a live-pty map from tab ids so each test can declare which
// tabs are alive without manually tracking parallel `tab.ptyId` values.
// `tab.ptyId` is the wake-hint sessionId preserved across sleep, not a
// liveness signal — slept-tab tests below pin the gap.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

function singleLeafLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID_1 },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID_1 },
      second: { type: 'leaf', leafId: LEAF_ID_2 }
    },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

describe('getWorktreeStatus', () => {
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { id: 'tab-1', title: 'claude [working]' },
        { id: 'tab-2', title: 'claude [permission]' }
      ],
      [{ id: 'browser-1' }],
      livePtyMap('tab-1', 'tab-2')
    )

    expect(status).toBe('permission')
    expect(getWorktreeStatusLabel(status)).toBe('Needs permission')
  })

  it('treats browser-only worktrees as active', () => {
    const status = getWorktreeStatus([], [{ id: 'browser-1' }], {})

    expect(status).toBe('active')
  })

  it('preserves a working agent status without a renderer PTY', () => {
    const status = getWorktreeStatus([], [], {}, {}, { liveAgentStatus: 'working' })

    expect(status).toBe('working')
  })

  it('preserves a permission agent status without a renderer PTY', () => {
    const status = getWorktreeStatus([], [], {}, {}, { liveAgentStatus: 'permission' })

    expect(status).toBe('permission')
  })

  it('returns inactive when neither tabs nor browser state are live', () => {
    expect(getWorktreeStatus([], [], {})).toBe('inactive')
  })

  it('reports working when any pane in a split-pane tab is working even if tab.title is idle', () => {
    // Regression: clicking between split panes rewrites tab.title to the
    // focused pane's title (see onActivePaneChange in
    // use-terminal-pane-lifecycle.ts). If the focused pane is idle while
    // another pane is still working, the sidebar spinner must stay spinning.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'codex [working]', 1: 'claude [done]' } }
    )

    expect(status).toBe('working')
  })

  it('prefers pane-level permission status over tab.title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'claude [permission]', 1: 'claude [done]' } }
    )

    expect(status).toBe('permission')
  })

  // Why: sleep clears ptyIdsByTabId[tab.id] to [] but preserves tab.ptyId
  // as a wake-hint sessionId. Reading tab.ptyId for liveness was the bug —
  // pin the new behavior so it can't regress.
  it('returns inactive for a slept tab (ptyIdsByTabId empty even if heuristic title matches working)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'claude [working]' }], [], {
      'tab-1': []
    })

    expect(status).toBe('inactive')
  })

  it('returns active when ptyIdsByTabId has entries (live precondition)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'bash' }], [], livePtyMap('tab-1'))

    expect(status).toBe('active')
  })

  // Why: an exited agent can leave a frozen braille-spinner frame in the
  // title forever (reproduced live: '⠐ Review branch for regressions' over a
  // plain shell prompt). The row builder rejects that title as a Claude row
  // (no explicit "claude" token), so the sidebar shows 0 agents — the worktree
  // dot must agree instead of spinning on the unattributable title alone.
  it('does not spin on a bare braille-spinner tab title that yields no agent row', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('active')
  })

  it('does not spin on a bare braille-spinner pane title that yields no agent row', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'bash' }], [], livePtyMap('tab-1'), {
      'tab-1': { 0: '⠐ Review branch for regressions', 1: 'bash' }
    })

    expect(status).toBe('active')
  })

  it('still spins on an agent-attributable braille-spinner title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠹ codex fix flaky test' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('working')
  })
})

describe('resolveWorktreeStatus', () => {
  it('returns inactive when no tab has a live pty and no explicit agent row exists', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [done]' }],
      browserTabs: [],
      // Slept: live-pty array empty; tab.ptyId would be the wake-hint sessionId.
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('inactive')
  })

  it('promotes to done when a retained done row is visible, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('treats pending paired web host terminal mirrors as inactive without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [],
      ptyIdsByTabId: {},
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('inactive')
  })

  it('treats ready paired web host terminal mirrors as active once they have a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [],
      ptyIdsByTabId: { 'web-terminal-host-tab-1': ['pty-1'] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('keeps browser-only paired workspaces active without terminal liveness', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [{ id: 'browser-1' }],
      ptyIdsByTabId: {},
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('promotes to permission when an explicit agent row needs input, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to permission when live and hasPermission', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to working from a fresh explicit agent row before pane titles restore', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('reports passive monitoring below active work and permission', () => {
    const base = {
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasLiveDone: false,
      hasRetainedDone: false
    }

    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveMonitoring: true
      })
    ).toBe('monitoring')
    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: false,
        hasLiveWorking: true,
        hasLiveMonitoring: true
      })
    ).toBe('working')
    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: true,
        hasLiveWorking: true,
        hasLiveMonitoring: true
      })
    ).toBe('permission')
  })

  it('lets heuristic working beat hasLiveDone (newer in-progress signal wins)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('lets a hook-covered done pane suppress its stale working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]',
          2: 'bash'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })

  it('lets a single hook-covered done pane suppress an unmapped single working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })

  it('keeps sibling pane working when hook done covers only another pane', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'bash',
          2: 'codex [working]'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  // Why: title-heuristic permission must beat hasLiveDone/hasRetainedDone —
  // the priority "permission > working > done > heuristic" applies to BOTH
  // sources of permission (the args.hasPermission overlay AND the heuristic
  // 'permission' return). Otherwise a tab title scraping "permission" would
  // be silently downgraded to 'done' whenever a separate done overlay exists.
  it('honors heuristic permission over hasLiveDone (priority: permission > done)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to done when live and hasRetainedDone (no working heuristic)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('keeps a hook-backed working agent spinning despite an unattributable stale title', () => {
    // Why: hook-managed agents drive the dot via hasLiveWorking, not the title
    // heuristic — the attribution gate must not regress them.
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('resolves a stale unattributable spinner title with no hook entry to active, not working', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('falls through to active heuristic when nothing else applies', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })
})

/**
 * A live pane Orca can name as an agent, holding a PTY, with no status claim from either
 * layer is not "Active": that reading is shared with a plain shell, which is the silence
 * this suite exists to remove. It is not `done` either — nothing here says the agent
 * finished. The negative controls matter as much: hook rows, title claims, stale reports,
 * launch records without a process read and plain shells must all keep the answer they had.
 */
describe('resolveWorktreeStatus with no status evidence', () => {
  const PANE_KEY = makePaneKey('tab-1', LEAF_ID_1)
  const agentTab = { id: 'tab-1', title: 'demo-repo', launchAgent: 'codex' as const }
  const agentPane: {
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
    paneForegroundAgentByPaneKey: Record<string, TitleDerivedPaneForeground>
  } = {
    runtimePaneTitlesByTabId: { 'tab-1': { 1: 'demo-repo' } },
    terminalLayoutsByTabId: { 'tab-1': singleLeafLayout() },
    paneForegroundAgentByPaneKey: {
      [PANE_KEY]: { agent: 'codex', agentEvidence: 'process-read', shellForeground: false }
    }
  }
  const livePty = livePtyMap('tab-1')
  const noPanes = {
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    paneForegroundAgentByPaneKey: {}
  }
  const shellPane = {
    runtimePaneTitlesByTabId: { 'tab-1': { 1: 'bash' } },
    terminalLayoutsByTabId: { 'tab-1': singleLeafLayout() },
    paneForegroundAgentByPaneKey: {}
  }

  function resolve(overrides: {
    tabs?: { id: string; title: string; launchAgent?: 'codex' }[]
    ptyIdsByTabId?: Record<string, string[]>
    pane?: Partial<typeof agentPane>
    agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
    stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
    hasPermission?: boolean
    hasLiveWorking?: boolean
    hasLiveDone?: boolean
    hasRetainedDone?: boolean
  }) {
    const pane = { ...agentPane, ...overrides.pane }
    return resolveWorktreeStatus({
      tabs: overrides.tabs ?? [agentTab],
      browserTabs: [],
      ptyIdsByTabId: overrides.ptyIdsByTabId ?? livePty,
      runtimePaneTitlesByTabId: pane.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: pane.terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey: pane.paneForegroundAgentByPaneKey,
      agentStatusPaneIdsByTabId: overrides.agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId: overrides.stalePaneIdsByTabId,
      hasPermission: overrides.hasPermission ?? false,
      hasLiveWorking: overrides.hasLiveWorking ?? false,
      hasLiveDone: overrides.hasLiveDone ?? false,
      hasRetainedDone: overrides.hasRetainedDone ?? false
    })
  }

  it('reports no evidence for an agent pane that has never reported a status', () => {
    const status = resolve({})

    expect(status).toBe('no-evidence')
    expect(getWorktreeStatusLabel(status)).toBe('No status reported')
  })

  it('reads the process read from layout roots, which is all the sidebar selects', () => {
    // Why: `selectWorktreeActivityStatuses` passes `terminalLayoutRootsByTabId` and no full
    // layout, so the single-pane leaf has to come from the root itself.
    const onlyRoots = {
      terminalLayoutRootsByTabId: { 'tab-1': { type: 'leaf' as const, leafId: LEAF_ID_1 } },
      paneForegroundAgentByPaneKey: agentPane.paneForegroundAgentByPaneKey
    }
    expect(
      getWorktreeStatus([agentTab], [], livePty, { 'tab-1': { 1: 'demo-repo' } }, onlyRoots)
    ).toBe('no-evidence')
    const status = resolveWorktreeStatus({
      tabs: [agentTab],
      browserTabs: [],
      ptyIdsByTabId: livePty,
      terminalLayoutRootsByTabId: onlyRoots.terminalLayoutRootsByTabId,
      paneForegroundAgentByPaneKey: onlyRoots.paneForegroundAgentByPaneKey,
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })
    expect(status).toBe('no-evidence')
  })

  it('names the absence at the heuristic level too, without any hook summary input', () => {
    expect(
      getWorktreeStatus(
        [agentTab],
        [],
        livePty,
        { 'tab-1': { 1: 'demo-repo' } },
        {
          terminalLayoutsByTabId: agentPane.terminalLayoutsByTabId,
          paneForegroundAgentByPaneKey: agentPane.paneForegroundAgentByPaneKey
        }
      )
    ).toBe('no-evidence')
  })

  it('keeps a fresh hook row authoritative, including done', () => {
    expect(resolve({ hasLiveDone: true })).toBe('done')
    expect(resolve({ hasLiveWorking: true })).toBe('working')
    expect(
      resolve({ agentStatusPaneIdsByTabId: { 'tab-1': new Set(['1']) }, hasLiveDone: true })
    ).toBe('done')
    // A fresh row owns the pane's title, so the dot stays with the hook's answer.
    expect(resolve({ agentStatusPaneIdsByTabId: { 'tab-1': new Set(['1']) } })).toBe('active')
  })

  it('does not claim absence for a pane whose row went stale after reporting', () => {
    expect(resolve({ stalePaneIdsByTabId: { 'tab-1': new Set(['1']) } })).toBe('active')
  })

  it('does not treat a launch record alone as identity', () => {
    // Why: the row builder refuses a plain-title row on the launch record alone, so the card
    // must not claim an agent the sidebar does not show.
    expect(resolve({ pane: { paneForegroundAgentByPaneKey: {} } })).toBe('active')
    expect(
      resolve({
        pane: {
          paneForegroundAgentByPaneKey: {
            [PANE_KEY]: {
              agent: 'codex',
              agentEvidence: 'launch-record',
              shellForeground: false
            }
          }
        }
      })
    ).toBe('active')
    expect(
      resolve({
        pane: {
          paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: null, shellForeground: true } }
        }
      })
    ).toBe('active')
  })

  it('keeps a plain shell pane active', () => {
    expect(resolve({ tabs: [{ id: 'tab-1', title: 'bash' }], pane: shellPane })).toBe('active')
    expect(resolve({ tabs: [{ id: 'tab-1', title: 'zsh' }], pane: shellPane })).toBe('active')
    // No pane titles at all: the tab title is the only reading, and it is a shell.
    expect(resolve({ tabs: [{ id: 'tab-1', title: 'bash' }], pane: noPanes })).toBe('active')
  })

  it('keeps titles that do claim a status', () => {
    expect(resolve({ tabs: [{ id: 'tab-1', title: '⠋ Codex' }], pane: noPanes })).toBe('working')
    expect(
      resolve({ tabs: [{ id: 'tab-1', title: 'Claude - action required' }], pane: noPanes })
    ).toBe('permission')
  })

  it('never reports no evidence for a sleeping pane', () => {
    expect(resolve({ ptyIdsByTabId: {} })).toBe('inactive')
  })

  it('ranks below every reporting state', () => {
    const bothPanes = [agentTab, { id: 'tab-2', title: 'demo-repo', launchAgent: 'codex' as const }]
    expect(
      resolve({
        tabs: bothPanes,
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2'),
        hasRetainedDone: true
      })
    ).toBe('done')
    expect(
      resolve({
        tabs: bothPanes,
        ptyIdsByTabId: livePtyMap('tab-1', 'tab-2'),
        hasPermission: true
      })
    ).toBe('permission')
  })
})
