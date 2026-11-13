// Fixtures for the incident panel tests (M7-B).
//
// Kept in one place so every test states the same defaults for "an incident that needs triage" and a
// test that cares about one field says only that field. The values are deliberately boring: nothing
// here is a real Run/Task/Dispatch/host identifier.

import type {
  IncidentCountsDto,
  IncidentCoverageDto,
  IncidentDetailDto,
  IncidentListItemDto
} from '../../../../../shared/incident-api-types'
import type {
  IncidentPaneClocksViewDto,
  IncidentToolErrorsViewDto
} from '../../../../../shared/incident-gray-types'

export const FIXTURE_NOW = 1_700_000_000_000

export function coverageFixture(overrides: Partial<IncidentCoverageDto> = {}): IncidentCoverageDto {
  return {
    remoteIncidentCapture: 'unsupported',
    capacityLatchSet: false,
    currentlyLimited: false,
    capacity: { rows: 1, bytes: 4096, maxRows: 50_000, maxBytes: 500 * 1024 * 1024 },
    shadowReplay: {
      lastSeq: 0,
      incomplete: false,
      lastStopReason: null,
      failures: 0,
      lastError: null,
      dropped: 0,
      lastDroppedReason: null,
      lastRun: null
    },
    paneClock: {
      sampledAt: FIXTURE_NOW,
      panes: 1,
      declaredWaits: 0,
      skipped: 0,
      errors: 0,
      lastError: null
    },
    ...overrides
  }
}

export function listItemFixture(overrides: Partial<IncidentListItemDto> = {}): IncidentListItemDto {
  return {
    id: 'inc_fixture_1',
    class: 'crash',
    sourceKind: 'pty_exit',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    agentSessionId: 'sess-abcdef123456',
    status: 'untriaged',
    effectiveStatus: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    summary: 'Agent process killed by signal 9; on host-a; pane pane-1',
    createdAt: FIXTURE_NOW - 60_000,
    decisionCount: 0,
    ...overrides
  }
}

export function detailFixture(overrides: Partial<IncidentDetailDto> = {}): IncidentDetailDto {
  return {
    id: 'inc_fixture_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: 'sess-abcdef123456',
    ptyIncarnationId: 'ptyinc-1',
    class: 'crash',
    status: 'untriaged',
    effectiveStatus: 'untriaged',
    exitCause: { kind: 'unknown', reason: 'stop_unverified' },
    fingerprint: 'f'.repeat(64),
    evidence: {
      pointers: [
        {
          kind: 'transcript',
          path: '/tmp/does-not-exist/transcript.jsonl',
          sha256: 'a'.repeat(64),
          bytes: 4096,
          startOffset: 120,
          endOffset: 480,
          lineWindow: 50,
          truncated: false
        }
      ],
      unknownBoundaries: ['no transcript pointer at PTY teardown']
    },
    summary: 'Agent process stop was requested but never confirmed',
    createdAt: FIXTURE_NOW - 60_000,
    decisionCount: 1,
    lastDecisionAt: FIXTURE_NOW - 30_000,
    decisions: [
      {
        id: 'dec_1',
        incidentId: 'inc_fixture_1',
        fromStatus: 'untriaged',
        toStatus: 'watch',
        actor: 'alice',
        reason: 'wait for a repeat',
        createdAt: FIXTURE_NOW - 30_000
      }
    ],
    ...overrides
  }
}

export function paneClocksViewFixture(
  overrides: Partial<IncidentPaneClocksViewDto> = {}
): IncidentPaneClocksViewDto {
  return {
    rows: [
      {
        paneKey: 'pane-1',
        terminalHandle: 'term-1',
        state: 'working',
        stateStartedAt: FIXTURE_NOW - 2 * 60 * 60_000,
        turnStartedAt: FIXTURE_NOW - 2 * 60 * 60_000,
        lastSemanticEventAt: FIXTURE_NOW - 50 * 60_000,
        ageMs: 50 * 60_000,
        ageBasis: 'event',
        observedAt: FIXTURE_NOW,
        declaredWait: null
      }
    ],
    coverage: coverageFixture(),
    ...overrides
  }
}

export function toolErrorsViewFixture(
  overrides: Partial<IncidentToolErrorsViewDto> = {}
): IncidentToolErrorsViewDto {
  return {
    updatedAt: FIXTURE_NOW,
    writeEnabled: false,
    published: 2,
    total: 2,
    evicted: 0,
    windows: [
      {
        sessionId: 'sess-abcdef123456',
        turn: 'turn-1',
        toolName: 'bash',
        code: 'non_zero_exit',
        count: 5,
        windowStart: FIXTURE_NOW - 5 * 60_000,
        lastAt: FIXTURE_NOW,
        highSeverity: false,
        wouldWriteIfEnabled: true,
        written: false
      },
      {
        sessionId: 'sess-abcdef123456',
        turn: 'turn-2',
        toolName: 'edit',
        code: 'permission_denied',
        count: 1,
        windowStart: FIXTURE_NOW - 2 * 60_000,
        lastAt: FIXTURE_NOW,
        highSeverity: true,
        wouldWriteIfEnabled: true,
        written: true
      }
    ],
    coveredProviders: ['claude', 'codex'],
    uncoveredProviders: ['pi', 'trae'],
    ...overrides
  }
}

export function countsFixture(overrides: Partial<IncidentCountsDto> = {}): IncidentCountsDto {
  return {
    untriaged: 1,
    total: 1,
    byClass: {
      crash: 1,
      no_progress: 0,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    },
    byWorktree: [{ worktreeId: 'wt-1', untriaged: 1 }],
    coverage: {
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      shadowReplayDropped: 0,
      remoteIncidentCapture: 'unsupported',
      gap: false
    },
    readAt: FIXTURE_NOW,
    ...overrides
  }
}
