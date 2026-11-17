/**
 * The agent-written proposal envelope, the durable create receipt and the
 * `gh` fallback argv (contract D1/D2/D8). Pure: no window, store or DOM.
 */
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { isRecord } from '../../../shared/unknown-record'
import {
  parseTaskDraftProposal,
  type TaskDraftProposal,
  type TaskDraftProvider,
  type TaskDraftTarget
} from '@/lib/task-draft-issue-create'

/** Provider-side hard limits; a draft this large never reaches a create call. */
const TITLE_MAX = 256
const BODY_MAX = 65_536
const LABEL_MAX = 128
const LABEL_COUNT_MAX = 32
const URL_MAX = 2_048
const IDENTIFIER_MAX = 128

export type TaskDraftProposalEnvelopeFailure =
  | 'partial'
  | 'wrong-draft'
  | 'wrong-target'
  | 'unsupported-version'
  | 'invalid'

/**
 * Read the envelope against the live draft. `partial` means "not finished
 * writing yet" and the hook keeps polling; every other reason is terminal.
 */
export function parseTaskDraftProposalEnvelope(
  raw: unknown,
  expected: { draftKey: string; provider: TaskDraftProvider; repoId: string | null }
):
  | { ok: true; proposal: TaskDraftProposal; revision: number }
  | { ok: false; reason: TaskDraftProposalEnvelopeFailure } {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'invalid' }
  }
  if (raw.version === undefined) {
    return { ok: false, reason: 'partial' }
  }
  if (raw.version !== 1) {
    return { ok: false, reason: 'unsupported-version' }
  }
  if (raw.draftKey !== expected.draftKey) {
    return { ok: false, reason: 'wrong-draft' }
  }
  if (raw.provider !== expected.provider) {
    return { ok: false, reason: 'wrong-target' }
  }
  if (normalizeRepoId(raw.repoId) !== expected.repoId) {
    return { ok: false, reason: 'wrong-target' }
  }
  // Why: an absent field is a half-written file, a present-but-wrong one is not.
  if (raw.revision === undefined || raw.proposal === undefined) {
    return { ok: false, reason: 'partial' }
  }
  if (!isPositiveInteger(raw.revision)) {
    return { ok: false, reason: 'invalid' }
  }
  const parsed = parseTaskDraftProposal(raw.proposal)
  if (!parsed.ok || !isProposalWithinBounds(parsed.proposal)) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, proposal: parsed.proposal, revision: raw.revision }
}

export type TaskDraftReceipt = {
  version: 1
  channel: 'primary-rpc' | 'gh-fallback'
  provider: TaskDraftProvider
  number: number
  url: string
  title: string
  identifier?: string
  draftKey: string
}

/** The durable create receipt; a missing or unreadable file is `null`, never fatal. */
export function parseTaskDraftReceipt(
  raw: unknown,
  expected: { draftKey: string; provider: TaskDraftProvider }
): TaskDraftReceipt | null {
  if (!isRecord(raw) || raw.version !== 1) {
    return null
  }
  const channel = raw.channel
  if (channel !== 'primary-rpc' && channel !== 'gh-fallback') {
    return null
  }
  if (raw.provider !== expected.provider || raw.draftKey !== expected.draftKey) {
    return null
  }
  if (!isPositiveInteger(raw.number)) {
    return null
  }
  const url = readString(raw.url, URL_MAX)
  const title = readString(raw.title, TITLE_MAX)
  if (!url || !title) {
    return null
  }
  const identifier = readString(raw.identifier, IDENTIFIER_MAX)
  if (identifier === null) {
    return null
  }
  return {
    version: 1,
    channel,
    provider: expected.provider,
    number: raw.number,
    url,
    title,
    ...(identifier ? { identifier } : {}),
    draftKey: expected.draftKey
  }
}

/**
 * The one `gh issue create` argv for the weaker manual path. Never a shell
 * string: every value stays its own argv entry so nothing is interpolated.
 */
export function buildGhFallbackInvocation(args: {
  owner: string
  repo: string
  title: string
  body: string
  labels: readonly string[]
}): { command: string; args: string[] } {
  const owner = args.owner.trim()
  const repo = args.repo.trim()
  if (!owner || !repo) {
    throw new Error('gh fallback needs an explicit owner/repo')
  }
  const title = args.title.trim()
  if (!title || title.length > TITLE_MAX) {
    throw new Error('gh fallback title is empty or too long')
  }
  if (args.body.length > BODY_MAX) {
    throw new Error('gh fallback body is too long')
  }
  if (args.labels.length > LABEL_COUNT_MAX) {
    throw new Error('gh fallback has too many labels')
  }
  const labels = args.labels.map((label) => label.trim())
  if (labels.some((label) => !label || label.length > LABEL_MAX)) {
    throw new Error('gh fallback has an empty or over-long label')
  }
  return {
    command: 'gh',
    args: [
      'issue',
      'create',
      '--repo',
      `${owner}/${repo}`,
      '--title',
      title,
      '--body',
      args.body,
      ...labels.flatMap((label) => ['--label', label])
    ]
  }
}

/** One mapper for both a validated receipt and a reused duplicate candidate (same fields). */
export function buildLinkedItem(
  target: TaskDraftTarget,
  item: { number: number; title: string; url: string; identifier?: string }
): LinkedWorkItemSummary {
  return {
    provider: target.provider,
    type: 'issue',
    number: item.number,
    title: item.title,
    url: item.url,
    ...(target.provider === 'linear' && item.identifier
      ? { linearIdentifier: item.identifier }
      : {}),
    ...(target.provider === 'jira' && item.identifier ? { jiraIdentifier: item.identifier } : {}),
    ...(target.provider === 'github' && target.repoId ? { repoId: target.repoId } : {})
  }
}

function isProposalWithinBounds(proposal: TaskDraftProposal): boolean {
  return (
    proposal.title.length <= TITLE_MAX &&
    proposal.body.length <= BODY_MAX &&
    proposal.labels.length <= LABEL_COUNT_MAX &&
    proposal.labels.every((label) => label.length <= LABEL_MAX)
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function normalizeRepoId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Trimmed non-empty bounded string, `undefined` passthrough, or `null` when invalid. */
function readString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}
