import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import {
  getTerminalActivitySummariesByTabId,
  resetTerminalActivitySummaryCacheForTest,
  resolveTerminalTabActivitySummary
} from './terminal-activity-summary'

const TAB_ID = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const NOW = 10_000

function entry(
  leafId: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const paneKey = `${TAB_ID}:${leafId}`
  return {
    paneKey,
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    ...overrides
  }
}

function summaryFor(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId = TAB_ID
): string {
  return resolveTerminalTabActivitySummary({
    tabId,
    agentStatusByPaneKey,
    agentStatusEpoch: 1
  })
}

beforeEach(() => {
  resetTerminalActivitySummaryCacheForTest()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe('resolveTerminalTabActivitySummary', () => {
  it('names the tool the tab is running', () => {
    const running = entry(LEAF_A, 'working', { toolName: 'Edit', toolInput: 'a.ts' })
    expect(summaryFor({ [running.paneKey]: running })).toBe('Edit: a.ts')
  })

  it('describes the newest pane of a split tab, not the finished one', () => {
    const older = entry(LEAF_A, 'working', {
      toolName: 'Read',
      toolInput: 'a.ts',
      stateStartedAt: NOW - 5_000
    })
    const newer = entry(LEAF_B, 'working', {
      toolName: 'Bash',
      toolInput: 'pnpm test',
      stateStartedAt: NOW - 1_000
    })
    expect(summaryFor({ [older.paneKey]: older, [newer.paneKey]: newer })).toBe('Bash: pnpm test')
  })

  it('says nothing for a stale row, a hydrated row, or a done tab', () => {
    const stale = entry(LEAF_A, 'working', {
      toolName: 'Edit',
      toolInput: 'a.ts',
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
    })
    expect(summaryFor({ [stale.paneKey]: stale })).toBe('')

    const hydrated = entry(LEAF_A, 'working', {
      toolName: 'Edit',
      toolInput: 'a.ts',
      restoredUnconfirmed: true
    })
    expect(summaryFor({ [hydrated.paneKey]: hydrated })).toBe('')

    const done = entry(LEAF_A, 'done', { toolName: 'Edit', toolInput: 'a.ts' })
    expect(summaryFor({ [done.paneKey]: done })).toBe('')
  })

  it('returns an empty summary for a tab with no status row', () => {
    const running = entry(LEAF_A, 'working', { toolName: 'Edit', toolInput: 'a.ts' })
    expect(summaryFor({ [running.paneKey]: running }, 'tab-without-hooks')).toBe('')
  })

  it('exposes the whole map for callers projecting many tabs', () => {
    const running = entry(LEAF_A, 'working', { toolName: 'Edit', toolInput: 'a.ts' })
    expect(
      getTerminalActivitySummariesByTabId({ agentStatusByPaneKey: { [running.paneKey]: running } })
    ).toEqual(new Map([[TAB_ID, 'Edit: a.ts']]))
    expect(getTerminalActivitySummariesByTabId({})).toEqual(new Map())
  })
})
