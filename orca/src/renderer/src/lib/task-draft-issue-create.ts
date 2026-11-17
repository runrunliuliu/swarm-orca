/**
 * The pure model behind a task draft (design §7.9.6–§7.9.9): the proposal the
 * agent writes, the duplicate check, the fifteen dock states and the one
 * confirmed-write request builder. No store, RPC, window or DOM here — the dock
 * hook and the preview card both import this module.
 */

import { isRecord } from '../../../shared/unknown-record'

export type TaskDraftProvider = 'linear' | 'github' | 'jira'

export type TaskDraftTarget = {
  provider: TaskDraftProvider
  /** `provider · owner/repo` for prompt and chip. */
  label: string
  repoId?: string | null
  projectId?: string | null
  hostId?: string | null
  owner?: string | null
  repo?: string | null
  teamId?: string | null
  teamKey?: string | null
  workspaceId?: string | null
}

export type TaskDraftProposal = { title: string; body: string; labels: string[] }

export type TaskDraftCandidate = { number: number; title: string; url: string; identifier?: string }
export type TaskDraftDuplicateCandidate = TaskDraftCandidate

/**
 * Read the agent's `task-draft-proposal.json`. The file is written by an agent,
 * so every field is checked here and a reason is returned instead of throwing.
 */
export function parseTaskDraftProposal(
  raw: unknown
): { ok: true; proposal: TaskDraftProposal } | { ok: false; reason: string } {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'not-object' }
  }
  const record = raw
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (!title) {
    return { ok: false, reason: 'empty-title' }
  }
  const body = record.body === undefined ? '' : record.body
  if (typeof body !== 'string') {
    return { ok: false, reason: 'invalid-body' }
  }
  const labels = parseTaskDraftLabels(record.labels)
  if (!labels) {
    return { ok: false, reason: 'invalid-labels' }
  }
  return { ok: true, proposal: { title, body, labels } }
}

/** Trimmed, de-duplicated labels, or null when the field is not a label list. */
function parseTaskDraftLabels(raw: unknown): string[] | null {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const labels: string[] = []
  for (const label of raw) {
    // Why: a blank or non-string entry would create a nameless label, so it
    // fails the whole file rather than being dropped.
    const trimmed = typeof label === 'string' ? label.trim() : ''
    if (!trimmed) {
      return null
    }
    if (!labels.includes(trimmed)) {
      labels.push(trimmed)
    }
  }
  return labels
}

/** Same-title candidates for the duplicate check; same provider/repo is the caller's scope. */
export function findDuplicateCandidates(
  proposal: Pick<TaskDraftProposal, 'title'>,
  candidates: readonly TaskDraftCandidate[]
): TaskDraftDuplicateCandidate[] {
  const wanted = normalizeIssueTitle(proposal.title)
  if (!wanted) {
    return []
  }
  const seen = new Set<number>()
  const matches: TaskDraftDuplicateCandidate[] = []
  for (const candidate of candidates) {
    if (normalizeIssueTitle(candidate.title) !== wanted || seen.has(candidate.number)) {
      continue
    }
    seen.add(candidate.number)
    matches.push(candidate)
  }
  return matches
}

/** The slice's only title-equality rule: trimmed, whitespace-collapsed, case-folded. */
function normalizeIssueTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

export type TaskDraftState =
  | 'idle'
  | 'no-context'
  | 'creating-draft'
  | 'draft-failed'
  | 'agent-launch-failed'
  | 'drafting'
  | 'preview-ready'
  | 'creating-issue'
  | 'issue-created-link-failed'
  | 'outcome-unknown'
  | 'provider-rejected'
  | 'duplicate-suspected'
  | 'remote-unsupported'
  | 'cancelled'
  | 'agent-crashed'
  | 'archived'

/** The only confirmed-write request builder; one call site in the dock hook. */
export type TaskDraftCreateRequest =
  | {
      kind: 'rpc'
      provider: 'linear' | 'github'
      method: 'linear.issueCreate' | 'github.createIssue'
      params: Record<string, unknown>
    }
  | { kind: 'jira-form'; provider: 'jira'; title: string; body: string }

/**
 * Build the one request the confirm handler may execute. Pure: it decides the
 * channel and its params, and performs nothing.
 */
export function buildTaskDraftCreateRequest(args: {
  target: TaskDraftTarget
  proposal: TaskDraftProposal
}): TaskDraftCreateRequest {
  const { target, proposal } = args
  const { title, body, labels } = proposal
  if (target.provider === 'jira') {
    // Why: Jira needs custom fields this slice does not know; the existing
    // pre-filled form collects them and owns the submit.
    return { kind: 'jira-form', provider: 'jira', title, body }
  }
  if (target.provider === 'github') {
    if (!target.repoId) {
      // Why: create without a repo cannot be a reachable state, so this is a bug.
      throw new Error('github.createIssue requires a repo selector')
    }
    const params: Record<string, unknown> = { repo: target.repoId, title, body }
    if (labels.length > 0) {
      params.labels = labels
    }
    return { kind: 'rpc', provider: 'github', method: 'github.createIssue', params }
  }
  const params: Record<string, unknown> = { title, body }
  // Why: Linear resolves either a team key (preferred) or a team input; one of
  // them identifies the team, and absent fields must not reach the RPC.
  if (target.teamKey) {
    params.teamKey = target.teamKey
  } else if (target.teamId) {
    params.teamInput = target.teamId
  }
  if (labels.length > 0) {
    params.labels = labels
  }
  if (target.workspaceId) {
    params.workspaceId = target.workspaceId
  }
  return { kind: 'rpc', provider: 'linear', method: 'linear.issueCreate', params }
}

export type TaskDraftRetryAction =
  | 'none'
  | 'resubmit'
  | 'relaunch-agent'
  | 'reopen'
  | 'link-only'
  | 'create'

/**
 * What the one retry control means in each state (README 7.9.7 retry owner).
 * Kept beside the state table so a new state cannot arrive without a decision.
 */
export function getTaskDraftRetryAction(state: TaskDraftState): TaskDraftRetryAction {
  switch (state) {
    case 'draft-failed':
      return 'resubmit'
    case 'agent-launch-failed':
      return 'relaunch-agent'
    case 'cancelled':
    case 'agent-crashed':
      return 'reopen'
    case 'issue-created-link-failed':
      return 'link-only'
    case 'provider-rejected':
      return 'create'
    case 'outcome-unknown':
    case 'idle':
    case 'no-context':
    case 'creating-draft':
    case 'drafting':
    case 'preview-ready':
    case 'creating-issue':
    case 'duplicate-suspected':
    case 'remote-unsupported':
    case 'archived':
      return 'none'
  }
}

/** Provider errors arrive as thrown values or as `{error:{message}}`; one string, either way. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `ENG-412` → 412, for providers whose receipt carries an identifier instead of a number. */
export function trailingNumber(identifier: string): number | null {
  const match = /(\d+)\s*$/.exec(identifier)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
