import type { AppState } from '@/store/types'
import {
  worktreeUsageKey,
  type UsageBreakdownRow,
  type UsageSelectorInput
} from './task-workbench-selector-types'
import type { SessionTokenClaim } from './task-workbench-session-totals'

/**
 * The store→selector adapters the workbench hook used to hold inline.
 *
 * They are here, not in the hook, for two reasons that both survive this module:
 * `use-task-workbench-view.ts` is over its `max-lines` budget (it was already
 * over it before issue #53), and these four translations are pure store-shape
 * knowledge with no React and no selector rule of their own. Recomputing an
 * attribution rule here would give the workbench a second opinion on usage — so
 * nothing below decides anything; it only renames fields.
 */

/** The four providers' retained sessions as one claim list. A provider's own
 *  total is all this layer knows; `sessionTokenTotals` owns the ambiguity rule
 *  for a session id two providers both claim. */
export function sessionTokenClaims(sources: {
  claude: AppState['claudeUsageRecentSessions']
  codex: AppState['codexUsageRecentSessions']
  opencode: AppState['openCodeUsageRecentSessions']
  muse: AppState['museUsageRecentSessions']
}): SessionTokenClaim[] {
  return [
    ...sources.claude.map((session) => ({
      sessionId: session.sessionId,
      tokens: claudeSessionTokens(session)
    })),
    ...sources.codex.map((session) => ({
      sessionId: session.sessionId,
      tokens: session.totalTokens
    })),
    ...sources.opencode.map((session) => ({
      sessionId: session.sessionId,
      tokens: session.totalTokens
    })),
    ...sources.muse.map((session) => ({
      sessionId: session.sessionId,
      tokens: session.totalTokens
    }))
  ]
}

/** One provider's rows normalized to `UsageBreakdownRow`, keeping only keys that
 * are one of the active `worktree:<id>` values — an exact match, never a
 * substring and never a `repo:` sibling (README §7.6). Claude publishes four
 * token fields and no total; the other three expose `totalTokens`; Muse
 * publishes no cost at all, which stays `null` (unpriced), never `$0`. */
export function selectProviders(
  activeWorktreeIds: readonly string[],
  claude: AppState['claudeUsageProjectBreakdown'],
  codex: AppState['codexUsageProjectBreakdown'],
  opencode: AppState['openCodeUsageProjectBreakdown'],
  muse: AppState['museUsageProjectBreakdown']
): UsageSelectorInput['providers'] {
  const keys = new Set(activeWorktreeIds.map((worktreeId) => worktreeUsageKey(worktreeId)))
  const select = <T extends { key: string; label: string }>(
    rows: readonly T[],
    tokensOf: (row: T) => number,
    costOf: (row: T) => number | null
  ): UsageBreakdownRow[] =>
    rows
      .filter((row) => keys.has(row.key))
      .map((row) => ({
        key: row.key,
        label: row.label,
        tokens: tokensOf(row),
        costUsd: costOf(row)
      }))
  return [
    {
      provider: 'claude',
      rows: select(claude, claudeBreakdownTokens, (row) => row.estimatedCostUsd)
    },
    {
      provider: 'codex',
      rows: select(
        codex,
        (row) => row.totalTokens,
        (row) => row.estimatedCostUsd
      )
    },
    {
      provider: 'opencode',
      rows: select(
        opencode,
        (row) => row.totalTokens,
        (row) => row.estimatedCostUsd
      )
    },
    {
      provider: 'muse',
      rows: select(
        muse,
        (row) => row.totalTokens,
        () => null
      )
    }
  ]
}

function claudeBreakdownTokens(row: AppState['claudeUsageProjectBreakdown'][number]): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
}

function claudeSessionTokens(row: AppState['claudeUsageRecentSessions'][number]): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
}
