import { describe, expect, it } from 'vitest'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  HistoryBackfillCommandError,
  historyBackfillRequestSchema,
  historyBackfillResponseSchema,
  isHistoryBackfillCommandError,
  parseHistoryBackfillTaskArgument
} from './history-backfill-command'

describe('history backfill --task parsing', () => {
  it.each([
    { raw: 'repo-1#53', repo: { kind: 'auto', value: 'repo-1' }, number: 53 },
    { raw: 'id:repo-1#7', repo: { kind: 'id', value: 'repo-1' }, number: 7 },
    { raw: 'path:/repos/app#31', repo: { kind: 'path', value: '/repos/app' }, number: 31 },
    // The number is taken from the last `#`, so a checkout path may contain one.
    { raw: '/repos/a#b#9', repo: { kind: 'auto', value: '/repos/a#b' }, number: 9 }
  ])('parses $raw', ({ raw, repo, number }) => {
    expect(parseHistoryBackfillTaskArgument(raw)).toEqual({ repo, number })
  })

  it.each(['repo-1', '#53', 'repo-1#', 'repo-1#0', 'repo-1#01', 'repo-1#abc', '  #53', ''])(
    'rejects %s instead of silently doing nothing',
    (raw) => {
      try {
        parseHistoryBackfillTaskArgument(raw)
        throw new Error('expected a refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(HistoryBackfillCommandError)
        expect(isHistoryBackfillCommandError(error)).toBe(true)
        if (isHistoryBackfillCommandError(error)) {
          expect(error.code).toBe('invalid_argument')
          expect(error.message).toContain('<repo>#<number>')
        }
      }
    }
  )
})

describe('history backfill wire contract', () => {
  const request = {
    userDataPath: '/home/u/.orca',
    task: { repo: { kind: 'id', value: 'repo-1' }, number: 53 }
  }

  /** One fully populated result, shared by the round-trip and the required-key test. */
  const result = {
    taskId: 'task:github:repo-1:issue:53',
    repoId: 'repo-1',
    number: 53,
    provider: 'github',
    itemType: 'issue',
    bindings: 1,
    examined: 1,
    resolved: 0,
    rowsWritten: { sessions: 0, runs: 0 },
    changed: true,
    revision: 4,
    discarded: {
      sessions: 0,
      runs: 0,
      gaps: 0,
      providers: 0,
      fields: 0,
      transcriptChecks: 0
    },
    writeRefusedReason: null,
    outcomes: [
      {
        worktreeId: 'repo-1::/repos/app',
        hostId: 'local',
        path: '/repos/app',
        outcome: 'ambiguous_match' as const,
        sessionRows: 0,
        runRows: 0,
        candidateCount: 2,
        detail: '2 sessions match this path'
      }
    ]
  }

  it('accepts the CLI request and a stated item type', () => {
    expect(historyBackfillRequestSchema.parse(request)).toEqual(request)
    expect(
      historyBackfillRequestSchema.parse({ ...request, task: { ...request.task, itemType: 'pr' } })
        .task.itemType
    ).toBe('pr')
  })

  it('rejects unknown keys, a malformed selector and a non-positive number', () => {
    expect(historyBackfillRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false)
    expect(
      historyBackfillRequestSchema.safeParse({
        ...request,
        task: { ...request.task, repo: { kind: 'url', value: 'x' } }
      }).success
    ).toBe(false)
    expect(
      historyBackfillRequestSchema.safeParse({ ...request, task: { ...request.task, number: 0 } })
        .success
    ).toBe(false)
  })

  it('round-trips a result with gaps and without a token figure', () => {
    const response = { ok: true as const, result }
    expect(historyBackfillResponseSchema.parse(response)).toEqual(response)
    expect(JSON.stringify(response)).not.toContain('tokens')
  })

  it('refuses a result that drops a required fact', () => {
    expect(
      historyBackfillResponseSchema.safeParse({
        ok: true,
        result: { taskId: 'task:x', repoId: 'repo-1' }
      }).success
    ).toBe(false)
    expect(
      historyBackfillResponseSchema.safeParse({ ok: false, code: 'nope', message: 'x' }).success
    ).toBe(false)
  })

  it('requires the load-boundary counters and the write outcome on the wire (R1)', () => {
    const parsed = historyBackfillResponseSchema.parse({ ok: true, result })
    if (!parsed.ok) {
      throw new Error('fixture must parse')
    }
    // Dropping either field would let a preflight report the loss in prose only, or
    // lose it entirely between the two processes; both are required keys.
    const { discarded, writeRefusedReason, ...withoutDiscard } = parsed.result
    expect(writeRefusedReason).toBeNull()
    expect(discarded.runs).toBe(0)
    expect(
      historyBackfillResponseSchema.safeParse({ ok: true, result: withoutDiscard }).success
    ).toBe(false)
    expect(
      historyBackfillResponseSchema.safeParse({
        ok: true,
        result: { ...parsed.result, writeRefusedReason: 'trimmed' }
      }).success
    ).toBe(false)
  })

  it('keeps one flag and one result prefix, as the launcher and preflight agree', () => {
    expect(HISTORY_BACKFILL_FLAG).toBe('--history-backfill')
    expect(HISTORY_BACKFILL_RESULT_PREFIX).toBe('[history-backfill] ')
  })
})
