import { describe, expect, it } from 'vitest'
import type { HistoryBackfillTask } from '../shared/history-backfill-command'
import type {
  TaskRecord,
  TaskRecordRun,
  TaskRecordSession,
  TaskWorkspaceBinding
} from '../shared/task-records-types'
import { buildHistoryTaskExport } from './history-task-export'
import {
  HISTORY_TASK_HUMAN_FIELD_LIMIT,
  formatHistoryTaskExport,
  terminalSafeField
} from './history-task-format'

const TASK: HistoryBackfillTask = {
  repo: { kind: 'auto', value: 'repo-1' },
  number: 53
}
const NOW = Date.UTC(2026, 10, 18, 12, 0)

function run(overrides: Partial<TaskRecordRun> = {}): TaskRecordRun {
  return {
    key: 'claude|session_id:abc',
    providerSession: { provider: 'claude', key: 'session_id', id: 'abc' },
    title: 'Wire JWT',
    agentType: 'claude',
    resumeCommand: 'claude --resume abc',
    startedAt: NOW - 3_600_000,
    endedAt: NOW,
    messageCount: 12,
    outcome: 'success',
    transcriptPath: '/home/u/.claude/sessions/abc.jsonl',
    transcriptCheck: {
      checkedAt: NOW,
      presence: 'present',
      dev: 1,
      ino: 2,
      mtimeMs: NOW,
      size: 42
    },
    source: 'archive-snapshot',
    recordedAt: NOW,
    firstSeenAt: NOW - 3_600_000,
    lastSeenAt: NOW,
    ...overrides
  }
}

function session(overrides: Partial<TaskRecordSession> = {}): TaskRecordSession {
  return {
    provider: 'codex',
    key: 'session_id',
    id: 'def',
    title: 'Verify JWT',
    agentType: 'codex',
    startedAt: NOW - 7_200_000,
    endedAt: NOW - 3_600_000,
    transcriptPath: '/home/u/.codex/def.jsonl',
    transcriptCheck: { checkedAt: NOW, presence: 'missing' },
    source: 'removal-snapshot',
    recordedAt: NOW,
    firstSeenAt: NOW - 7_200_000,
    lastSeenAt: NOW,
    ...overrides
  }
}

function binding(overrides: Partial<TaskWorkspaceBinding> = {}): TaskWorkspaceBinding {
  return {
    worktreeId: 'wt-archived',
    repoId: 'repo-1',
    hostId: 'local',
    path: '/repos/app',
    isArchived: false,
    boundAt: NOW - 10_000,
    boundBy: 'created',
    lastVerifiedAt: NOW,
    sessions: [],
    ...overrides
  }
}

function record(bindings: TaskWorkspaceBinding[]): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:53',
    hostId: 'local',
    origin: {
      kind: 'external',
      provider: 'github',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'web' },
      itemType: 'issue',
      number: 53,
      url: 'https://github.com/acme/web/issues/53',
      titleSnapshot: 'Fix JWT'
    },
    bindings,
    intent: {},
    createdAt: NOW - 20_000,
    updatedAt: NOW,
    schemaVersion: 3
  }
}

function fixture(): TaskRecord {
  return record([
    binding({
      worktreeId: 'wt-archived',
      isArchived: true,
      runs: [
        run({
          gaps: [
            {
              kind: 'ambiguous_match',
              candidateCount: 2,
              observedAt: NOW,
              detail: 'two sessions match this run'
            }
          ]
        })
      ],
      usageSettlement: {
        kind: 'known',
        collectedAt: NOW,
        scope: 'worktree-rollup',
        worktreeId: 'wt-archived',
        providers: [{ provider: 'claude', tokens: 1200, costUsd: 1.2 }],
        estimatedCostUsd: 1.2
      }
    }),
    binding({
      worktreeId: 'wt-removed',
      path: '/repos/app-old',
      sessions: [session()],
      gaps: [
        {
          kind: 'session_unattributable',
          candidateCount: 3,
          observedAt: NOW,
          detail: 'three sessions match this checkout'
        }
      ],
      usageSettlement: {
        kind: 'unavailable',
        collectedAt: NOW,
        scope: 'worktree-rollup',
        worktreeId: 'wt-removed',
        reason: 'usage_not_enabled'
      }
    })
  ])
}

function exportOf(
  record: TaskRecord,
  existing: string[] = ['wt-archived']
): ReturnType<typeof buildHistoryTaskExport> {
  return buildHistoryTaskExport({
    record,
    repoId: 'repo-1',
    task: TASK,
    existingWorktreeIds: existing
  })
}

describe('history task JSON shape', () => {
  it('states task identity, bindings, runs, facts, trace, historySource and gaps', () => {
    const result = exportOf(fixture())
    expect(Object.keys(result).sort()).toEqual(
      [
        'agents',
        'bindings',
        'gaps',
        'historySource',
        'schemaVersion',
        'task',
        'tokens',
        'trace',
        'wall'
      ].sort()
    )
    expect(result.schemaVersion).toBe(1)
    expect(result.task).toMatchObject({
      taskId: 'task:github:repo-1:issue:53',
      repoId: 'repo-1',
      provider: 'github',
      owner: 'acme',
      repo: 'web',
      itemType: 'issue',
      number: 53,
      url: 'https://github.com/acme/web/issues/53',
      title: 'Fix JWT'
    })
    expect(result.bindings.map((entry) => entry.state)).toEqual(['archived', 'removed'])
    expect(result.trace).toBe('deleted')
    expect(result.historySource).toBe('record')
    expect(result.gaps.map((gap) => [gap.scope, gap.kind, gap.standalone])).toEqual([
      ['run', 'ambiguous_match', false],
      ['binding', 'session_unattributable', false]
    ])
    const recorded = result.bindings[0]!.runs[0]!
    expect(recorded).toMatchObject({
      key: 'claude|session_id:abc',
      title: 'Wire JWT',
      agentType: 'claude',
      startedAt: NOW - 3_600_000,
      endedAt: NOW,
      messageCount: 12,
      resumeCommand: 'claude --resume abc',
      transcriptPath: '/home/u/.claude/sessions/abc.jsonl'
    })
    expect(recorded.transcriptCheck).toMatchObject({ presence: 'present', checkedAt: NOW })
    // The session row of the removed workspace keeps only the stat, never content.
    expect(result.bindings[1]!.sessions[0]!.transcriptCheck).toMatchObject({ presence: 'missing' })
    expect(JSON.stringify(result)).not.toContain('transcriptContent')
    // The removed binding has only a session row; the workbench fold derives it too.
    expect(result.agents).toEqual({ kind: 'known', count: 2 })
    expect(result.wall).toEqual({ kind: 'measured', startedAt: NOW - 7_200_000, endedAt: NOW })
    // Two bindings, one measured and one unavailable: the task total cannot be known.
    expect(result.tokens).toEqual({ kind: 'unavailable', reason: 'usage_not_enabled' })
  })

  it('uses the existing trace rule: a removed workspace wins over an archived one', () => {
    expect(exportOf(record([binding({ isArchived: true })])).trace).toBe('archived')
    expect(exportOf(record([binding({ isArchived: true })]), []).trace).toBe('deleted')
    expect(exportOf(record([binding({ isArchived: false })]), ['wt-archived']).trace).toBe('none')
  })
})

describe('unknown is never rendered as zero', () => {
  const empty = record([
    binding({
      worktreeId: 'wt-removed',
      sessions: [],
      runs: [],
      usageSettlement: undefined
    })
  ])

  it('keeps every absent fact as a typed unknown in JSON', () => {
    const result = exportOf(empty, [])
    expect(result.agents).toEqual({ kind: 'unknown', reason: 'no_run_recorded' })
    expect(result.wall).toEqual({ kind: 'unknown', reason: 'no_run_recorded' })
    expect(result.tokens).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(result.bindings[0]!.usage).toEqual({ kind: 'unknown', reason: 'unattributed' })
    expect(JSON.stringify(result)).not.toMatch(/"tokens":0|\$0/)
  })

  it('prints unknown reasons instead of 0 tokens or $0', () => {
    const text = formatHistoryTaskExport(exportOf(empty, []))
    expect(text).toContain('agents: unknown (no_run_recorded)')
    expect(text).toContain('wall: unknown (no_run_recorded)')
    expect(text).toContain('tokens: unknown (no_matching_session)')
    expect(text).toContain('usage: unknown (unattributed)')
    expect(text).not.toMatch(/\b0\b|\$0/)
  })
})

describe('terminalSafe human output', () => {
  it('strips escapes before clipping a value', () => {
    const value = `\u001b]52;c;cGF5bG9hZA==\u0007\u001b[31m${'x'.repeat(200)}`
    const safe = terminalSafeField(value, 40)
    expect(safe).not.toContain('\u001b')
    expect(safe).toHaveLength(40)
    expect(safe.endsWith('...')).toBe(true)
  })

  it('clips a long title and transcript path without letting control bytes through', () => {
    const hostile = `resize\u001b[2J ${'y'.repeat(HISTORY_TASK_HUMAN_FIELD_LIMIT * 2)}`
    const result = exportOf(
      record([
        binding({
          isArchived: true,
          runs: [run({ title: hostile, transcriptPath: hostile })]
        })
      ])
    )
    const text = formatHistoryTaskExport(result)
    expect(text).not.toContain('\u001b')
    expect(text).toContain('...')
    const longest = Math.max(...text.split('\n').map((line) => line.length))
    expect(longest).toBeLessThanOrEqual(HISTORY_TASK_HUMAN_FIELD_LIMIT * 3)
  })
})
