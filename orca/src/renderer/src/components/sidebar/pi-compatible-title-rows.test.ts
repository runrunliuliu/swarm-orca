import { describe, expect, it } from 'vitest'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const LEAF_ID = '77777777-7777-4777-8777-777777777777'

describe('Pi-compatible title rows without hook or process-read evidence', () => {
  it.each(['pi', 'omp'] as const)('keeps the %s row after owner normalization', (owner) => {
    const label = owner === 'pi' ? 'Pi' : 'OMP'
    for (const title of ['π - example_repo', `${label} - example_repo`]) {
      const rows = buildWorktreeAgentRows({
        tabs: [
          {
            id: 'tab-1',
            worktreeId: 'wt-1',
            ptyId: null,
            title,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            launchAgent: owner
          }
        ],
        entries: [],
        retained: [],
        runtimePaneTitlesByTabId: { 'tab-1': { 1: title } },
        ptyIdsByTabId: { 'tab-1': ['ssh:test@@pty-pi'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null
          }
        },
        now: 2000
      })
      expect(rows.map((row) => [row.agentType, row.state, row.entry.terminalTitle])).toEqual([
        [owner, 'idle', `${label} - example_repo`]
      ])
    }
  })
})
