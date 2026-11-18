/**
 * Write-once snapshot of a linked GitHub issue, captured when Orca creates the worktree.
 *
 * Why persisted instead of fetched on demand: the agent draft paths that consume it
 * (`launchAgentInNewTab`, the linked-context block wrappers) are synchronous renderer code, and
 * fetching a body from there would either break those call sites or put a network call on the
 * agent-startup path. One capture at create time keeps every reader synchronous.
 *
 * Why no refresh: staleness is accepted for this iteration, so the snapshot carries the provider's
 * `updatedAt` — the reader can tell how old the text is instead of assuming it is current.
 */

/** Bumped when the persisted shape changes; an unknown version is ignored rather than guessed at. */
export const LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION = 1

/**
 * Mirrors the renderer's linked-context block budget (`LINKED_CONTEXT_BLOCK_MAX_CHARS`).
 *
 * Why cap the persisted copy too: `orca-data.json` is re-serialized on every save, so one long
 * issue body per linked worktree is a recurring cost, and a body past the block budget can never
 * reach the agent anyway.
 */
export const LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS = 12000

export type LinkedIssueContextSnapshot = {
  version: typeof LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION
  /** GitHub issue number this snapshot describes. */
  number: number
  title: string
  url: string
  /** Provider-reported last update, ISO string; '' when the response carried none. */
  updatedAt: string
  /** Capture time (epoch ms). */
  capturedAt: number
  body: string
}

export type LinkedIssueContextSource = {
  number: number
  title?: string | null
  url?: string | null
  body?: string | null
  updatedAt?: string | null
  capturedAt?: number
}

// Control characters would let a provider body smuggle terminal escapes into a draft.
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
// eslint-disable-next-line no-control-regex
const INLINE_WHITESPACE_PATTERN = /\s+/g

function normalizeInline(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.replace(CONTROL_CHARS_PATTERN, '').replace(INLINE_WHITESPACE_PATTERN, ' ').trim()
}

function normalizeBody(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_PATTERN, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (normalized.length <= LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS) {
    return normalized
  }
  return normalized.slice(0, LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS).trimEnd()
}

function isPositiveIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Build the persisted snapshot from a provider response. Returns null when the response is not a
 * usable issue, so a capture that produced nothing is never stored as an empty snapshot.
 */
export function buildLinkedIssueContextSnapshot(
  source: LinkedIssueContextSource | null | undefined
): LinkedIssueContextSnapshot | null {
  if (!source || !isPositiveIssueNumber(source.number)) {
    return null
  }
  const url = normalizeInline(source.url)
  if (!url) {
    return null
  }
  const title = normalizeInline(source.title)
  const capturedAt = source.capturedAt ?? Date.now()
  return {
    version: LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION,
    number: source.number,
    title,
    url,
    updatedAt: normalizeInline(source.updatedAt),
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
    body: normalizeBody(source.body)
  }
}

/**
 * Validate a snapshot read back from disk. The persisted file is not a trusted shape: an older
 * build, a hand edit, or a future version must yield null instead of an untyped object.
 */
export function normalizeLinkedIssueContextSnapshot(
  value: unknown
): LinkedIssueContextSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<Record<keyof LinkedIssueContextSnapshot, unknown>>
  if (raw.version !== LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION) {
    return null
  }
  if (!isPositiveIssueNumber(raw.number)) {
    return null
  }
  const url = typeof raw.url === 'string' ? normalizeInline(raw.url) : ''
  if (!url) {
    return null
  }
  const capturedAt = typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt)
    ? raw.capturedAt
    : 0
  return {
    version: LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION,
    number: raw.number,
    title: typeof raw.title === 'string' ? normalizeInline(raw.title) : '',
    url,
    updatedAt: typeof raw.updatedAt === 'string' ? normalizeInline(raw.updatedAt) : '',
    capturedAt: capturedAt > 0 ? capturedAt : 0,
    body: typeof raw.body === 'string' ? normalizeBody(raw.body) : ''
  }
}

/**
 * Render the snapshot as the source text the linked-context wrapper quotes. The wrapper (with its
 * untrusted-data preamble, delimiters and 12000-char cap) is applied by the renderer, so this
 * function stays a plain text projection with no presentation markup.
 */
export function renderLinkedIssueContextSnapshot(snapshot: LinkedIssueContextSnapshot): string {
  const lines = [
    'GitHub issue context snapshot',
    `Issue: #${snapshot.number}`,
    `Title: ${snapshot.title || '(untitled)'}`,
    `URL: ${snapshot.url}`
  ]
  if (snapshot.updatedAt) {
    lines.push(`Updated: ${snapshot.updatedAt}`)
  }
  lines.push('', 'Body:', snapshot.body || '(empty)')
  return lines.join('\n')
}
