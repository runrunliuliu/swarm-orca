import type { AgentTokenView, SpendView } from '@/components/task-workbench/task-workbench-view'
import { worktreeUsageKey } from './task-workbench-selector-types'
import type {
  UsageBreakdownRow,
  UsageSelectorInput,
  UsageSelectorResult,
  WorkspaceUsage
} from './task-workbench-selector-types'

/**
 * The `usage` selector (README §3.3, §7.5, §7.6; development-plan §3 M1).
 *
 * It consumes the already-aggregated `*UsageProjectBreakdown` rows the caller
 * normalized into `UsageBreakdownRow` and matches them by the exact
 * `worktree:<worktreeId>` key. It never substring-matches, never sums a
 * worktree with its `repo:` sibling, never falls back to a `label`, and never
 * turns an unknown figure into `0`.
 *
 * Pure: no React, store, RPC or clock. Provider-specific row shapes are the
 * caller's problem; this module only sees `UsageBreakdownRow`.
 */

/** One provider's matched slice; derived from the frozen workspace shape. */
type SpendSlice = WorkspaceUsage['byProvider'][number]

/** Sums one key's rows. A single unpriced row makes the whole cost unknown. */
function sumRows(rows: readonly UsageBreakdownRow[]): { tokens: number; costUsd: number | null } {
  let tokens = 0
  let costUsd: number | null = 0
  for (const row of rows) {
    tokens += row.tokens
    costUsd = costUsd === null || row.costUsd === null ? null : costUsd + row.costUsd
  }
  return { tokens, costUsd }
}

/** Exact-key match only: `row.key === key`, in input provider order. */
function matchProviders(input: UsageSelectorInput, key: string): SpendSlice[] {
  const slices: SpendSlice[] = []
  for (const provider of input.providers) {
    const rows = provider.rows.filter((row) => row.key === key)
    if (rows.length > 0) {
      slices.push({ provider: provider.provider, ...sumRows(rows) })
    }
  }
  return slices
}

function selectSpend(input: UsageSelectorInput): SpendView {
  // First match wins: tracking off beats stale rows, a remote host has no local
  // scan, and an ambiguous window is never guessed.
  if (!input.enabled) {
    return { kind: 'unavailable', reason: 'disabled' }
  }
  if (input.remote) {
    return { kind: 'unavailable', reason: 'remote_host' }
  }
  if (input.attribution?.kind === 'ambiguous') {
    return { kind: 'unavailable', reason: 'ambiguous_session' }
  }

  const keys = new Set(input.worktreeIds.map((worktreeId) => worktreeUsageKey(worktreeId)))
  const byProvider: SpendSlice[] = []
  let tokens = 0
  let costUsd: number | null = 0
  for (const provider of input.providers) {
    const rows = provider.rows.filter((row) => keys.has(row.key))
    if (rows.length === 0) {
      continue
    }
    const slice = sumRows(rows)
    tokens += slice.tokens
    costUsd = costUsd === null || slice.costUsd === null ? null : costUsd + slice.costUsd
    byProvider.push({ provider: provider.provider, ...slice })
  }
  if (byProvider.length === 0) {
    return { kind: 'unavailable', reason: 'no_matching_session' }
  }
  return {
    kind: 'available',
    tokens,
    costUsd,
    byProvider,
    // A session count, not a token figure: an absent counter really is zero.
    unattributedSessions: input.unattributedSessions ?? 0
  }
}

function selectWorkspaceUsage(input: UsageSelectorInput, worktreeId: string): WorkspaceUsage {
  // The three non-numeric states carry no figures at all: listing provider
  // tokens beside `tokens: null` would contradict the status.
  if (!input.enabled) {
    return { worktreeId, status: 'disabled', tokens: null, costUsd: null, byProvider: [] }
  }
  if (input.remote) {
    return { worktreeId, status: 'remote_host', tokens: null, costUsd: null, byProvider: [] }
  }
  const byProvider = matchProviders(input, worktreeUsageKey(worktreeId))
  if (byProvider.length === 0) {
    return {
      worktreeId,
      status: 'no_matching_session',
      tokens: null,
      costUsd: null,
      byProvider: []
    }
  }
  let tokens = 0
  let costUsd: number | null = 0
  for (const slice of byProvider) {
    tokens += slice.tokens
    costUsd = costUsd === null || slice.costUsd === null ? null : costUsd + slice.costUsd
  }
  return {
    worktreeId,
    status: costUsd === null ? 'unpriced' : 'available',
    tokens,
    costUsd,
    byProvider
  }
}

/** Only a retained session has a per-agent number; a worktree rollup cannot be split. */
function selectAgentTokens(input: UsageSelectorInput): Readonly<Record<string, AgentTokenView>> {
  const agentTokens: Record<string, AgentTokenView> = {}
  for (const agent of input.agents ?? []) {
    if (!agent.session) {
      continue
    }
    agentTokens[agent.paneKey] =
      agent.session.caveat === undefined
        ? { kind: 'ai-vault', tokens: agent.session.tokens }
        : { kind: 'ai-vault', tokens: agent.session.tokens, caveat: agent.session.caveat }
  }
  return agentTokens
}

export function selectTaskWorkbenchUsage(input: UsageSelectorInput): UsageSelectorResult {
  return {
    spend: selectSpend(input),
    workspaces: input.worktreeIds.map((worktreeId) => selectWorkspaceUsage(input, worktreeId)),
    agentTokens: selectAgentTokens(input)
  }
}
