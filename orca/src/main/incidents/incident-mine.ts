// `orca incident mine` — the public surface (issue-sedimentation.md v2.8 §10; simplify S3).
//
// Three modules carry the work and this file is only the door:
//   * `incident-mine-rules.ts`   — stable source identity, thresholds, rule/low-information judgement
//                                  (no database, no writes);
//   * `incident-mine-build.ts`   — the bounded read: one window query, grouping, cluster report;
//   * `incident-mine-apply.ts`   — the bounded write: append-only decisions with the untriaged guard.
//
// Re-exported here: what the CLI and the formatter import, and nothing else. The rule helpers stay in
// their module so a reader of the miner's policy does not have to pass through the DTO layer, and the
// test suites import the module they exercise.

export {
  buildIncidentMine,
  type BuildIncidentMineOptions,
  type IncidentMine,
  type MineCandidate,
  type MineCandidateStats,
  type MineCluster,
  type MineExcluded,
  type MineLimits,
  type MineScan,
  type MineTotals,
  type MineTruncation
} from './incident-mine-build'

export {
  applyMineCandidates,
  mineDecisionReason,
  type ApplyMineOptions,
  type MineApplyOutcome,
  type MineApplyResult,
  type MineApplySummary,
  type MineStore
} from './incident-mine-apply'

export {
  DEFAULT_MINE_MAX_CANDIDATES,
  DEFAULT_MINE_MAX_GROUPS,
  DEFAULT_MINE_MAX_SCAN_ROWS,
  DEFAULT_MINE_TIME_BUDGET_MS,
  DEFAULT_MINE_WINDOW_MS,
  DEFAULT_MINER_TARGET,
  MINER_ACTOR,
  MINER_TARGETS,
  MINE_MAX_LOW_INFORMATION_CANDIDATES,
  isMinerTarget,
  type MinerTarget
} from './incident-mine-rules'
