// Why (M2): task sparse workspaces must fail before any Git side effect, so the strict
// request rules live in one pure module — no fs, no Git, no cone expansion, no repair.

// Why re-exported: the M0 limits are contract values (shared, so a client can pre-validate), while
// the strict parse rules that enforce them stay here with their tests.
export {
  SPARSE_TASK_MAX_DIRECTORY_COUNT,
  SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES,
  SPARSE_TASK_MAX_REQUIRED_PATH_COUNT,
  SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES
} from '../../shared/worktree/sparse-task-limits'

import {
  SPARSE_TASK_MAX_DIRECTORY_COUNT,
  SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES,
  SPARSE_TASK_MAX_REQUIRED_PATH_COUNT,
  SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES
} from '../../shared/worktree/sparse-task-limits'

/** Codes from the M0 contract, plus two M2 registrations (`sparse_task_tree_probe_invalid`,
 *  `sparse_task_pinned_sha_invalid`) that describe "cannot prove" rather than "absent/unusable" and
 *  are documented in the M0 error table. All are fail-closed and never retryable. */
export type SparseTaskValidationCode =
  | 'sparse_task_directory_invalid'
  | 'sparse_task_directory_limit_exceeded'
  | 'sparse_task_directory_missing'
  | 'sparse_task_directory_not_tree'
  | 'sparse_task_required_path_invalid'
  | 'sparse_task_required_path_missing'
  | 'sparse_task_tree_probe_invalid'
  | 'sparse_task_pinned_sha_invalid'

/** Carries a stable code because the existing create error channel may only carry `message`
 *  (M0), so `message` always embeds the code inside brackets. */
export class SparseTaskValidationError extends Error {
  readonly code: SparseTaskValidationCode

  constructor(code: SparseTaskValidationCode, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'SparseTaskValidationError'
    this.code = code
  }
}

const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/
const utf8Encoder = new TextEncoder()

// Why a scan over a regex: oxlint forbids control characters in patterns, and this check is the
// NUL/control gate for every path that reaches Git.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return true
    }
  }
  return false
}

export function sparseTaskUtf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length
}

type SparseTaskPathListRules = {
  /** Used verbatim inside messages, e.g. "sparse task directory". */
  kind: string
  invalidCode: SparseTaskValidationCode
  limitCode: SparseTaskValidationCode
  maxCount: number
  maxUtf8Bytes: number
  minCount: number
}

function describeEntry(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text
  return JSON.stringify(preview)
}

/** One separator rule and one canonical form for every list: backslashes are separators,
 *  repeated separators are not repaired, and anything Git could interpret as a different
 *  path is rejected. Preserves spaces inside a name; rejects surrounding whitespace. */
function normalizeSparseTaskRelativePath(value: string, rules: SparseTaskPathListRules): string {
  if (value.length === 0) {
    throw new SparseTaskValidationError(rules.invalidCode, `A ${rules.kind} is empty.`)
  }
  if (value !== value.trim()) {
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `A ${rules.kind} has surrounding whitespace: ${describeEntry(value)}`
    )
  }
  if (hasControlCharacter(value)) {
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `A ${rules.kind} contains a control character: ${describeEntry(value)}`
    )
  }
  const unified = value.replaceAll('\\', '/')
  if (unified.startsWith('/') || WINDOWS_DRIVE_PREFIX_PATTERN.test(unified)) {
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `A ${rules.kind} must be repo-relative, not absolute: ${describeEntry(value)}`
    )
  }
  const segments = unified.split('/')
  if (segments.includes('')) {
    // Why: `a//b` and `a/` mean different things to different Git call sites; refuse instead of
    // picking one silently.
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `A ${rules.kind} has an empty path segment: ${describeEntry(value)}`
    )
  }
  if (segments.includes('.') || segments.includes('..')) {
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `A ${rules.kind} has a dot or parent-traversal segment: ${describeEntry(value)}`
    )
  }
  return segments.join('/')
}

function parseSparseTaskPathList(
  input: readonly string[],
  rules: SparseTaskPathListRules
): string[] {
  // Why before dedupe: the count bound is on the raw request a caller sent, while the byte bound
  // below is on the pathspec argv Git will receive. They bound different things on purpose.
  if (input.length > rules.maxCount) {
    throw new SparseTaskValidationError(
      rules.limitCode,
      `At most ${rules.maxCount} ${rules.kind}s are allowed, got ${input.length}.`
    )
  }
  const seen = new Set<string>()
  const parsed: string[] = []
  for (const [index, raw] of input.entries()) {
    const entry: unknown = raw
    if (typeof entry !== 'string') {
      throw new SparseTaskValidationError(
        rules.invalidCode,
        `${rules.kind} #${index} is not a string.`
      )
    }
    const normalized = normalizeSparseTaskRelativePath(entry, rules)
    // Why: stable first-occurrence dedupe — the receipt lists what was requested, in request
    // order, so a retry hashes the same list.
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    parsed.push(normalized)
  }
  if (parsed.length < rules.minCount) {
    throw new SparseTaskValidationError(
      rules.invalidCode,
      `At least ${rules.minCount} ${rules.kind} is required.`
    )
  }
  const totalBytes = parsed.reduce((sum, entry) => sum + sparseTaskUtf8ByteLength(entry), 0)
  if (totalBytes > rules.maxUtf8Bytes) {
    throw new SparseTaskValidationError(
      rules.limitCode,
      `${rules.kind} UTF-8 total is ${totalBytes} bytes; at most ${rules.maxUtf8Bytes} allowed.`
    )
  }
  return parsed
}
const DIRECTORY_RULES: SparseTaskPathListRules = {
  kind: 'sparse task directory',
  invalidCode: 'sparse_task_directory_invalid',
  limitCode: 'sparse_task_directory_limit_exceeded',
  maxCount: SPARSE_TASK_MAX_DIRECTORY_COUNT,
  maxUtf8Bytes: SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES,
  minCount: 1
}

const REQUIRED_PATH_RULES: SparseTaskPathListRules = {
  kind: 'required path',
  invalidCode: 'sparse_task_required_path_invalid',
  limitCode: 'sparse_task_required_path_invalid',
  maxCount: SPARSE_TASK_MAX_REQUIRED_PATH_COUNT,
  maxUtf8Bytes: SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES,
  // Why: a caller may declare no required path; only the syntax and size caps apply.
  minCount: 0
}

/** Strict request cone: at least one entry, canonical repo-relative paths, stable dedupe. */
export function parseSparseTaskDirectories(input: readonly string[]): string[] {
  return parseSparseTaskPathList(input, DIRECTORY_RULES)
}

/** Strict required-path list (files or directories), stable dedupe, may be empty.
 *  M0 gives no separate limit code here, so an oversize list reports the invalid code. */
export function parseSparseTaskRequiredPaths(input: readonly string[]): string[] {
  return parseSparseTaskPathList(input, REQUIRED_PATH_RULES)
}
