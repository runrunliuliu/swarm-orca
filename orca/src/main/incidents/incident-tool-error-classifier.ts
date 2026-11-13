// Normalized tool-error codes (issue-sedimentation.md v2.5 §7.3; M4-C1).
//
// The classifier exists so a cluster is a *stable code*, not a string that differs by provider, model
// phrasing or a temp path. M4-C1 tightened the trust model after review:
//
//   1. Only STRUCTURED evidence may produce a code that matters:
//        * `exitCode` — the journal tool-call item's own numeric field (`NativeChatToolMetadata`),
//          populated by the codex translation from the provider item, never by a regex;
//        * `errorKind` — a typed refusal a provider translation stamps (`permission_denied`,
//          `pin_mismatch`, `scope_violation`, `immutable`, `tool_schema`, `timeout`, `network`).
//   2. A textual hit is NOT evidence. With a structured non-zero exit code the code is
//      `non_zero_exit`; otherwise it is `unknown`. The matched family may travel as a redacted,
//      low-confidence `textHint` for clustering/display, and it NEVER sets high severity.
//   3. High severity (`permission_denied`, the design's permission / pin / scope / immutable family)
//      therefore requires an `errorKind`; a build log containing "permission denied" cannot open a
//      single-hit incident any more.
//
// The raw text is still never stored: the sanitized head is used only to compute the hint, and only
// the code + hint label reach the record.

import { sanitizeText } from './incident-sanitize'

export const TOOL_ERROR_CODES = [
  'permission_denied',
  'path_not_found',
  'command_not_found',
  'timeout',
  'non_zero_exit',
  'tool_schema',
  'network',
  'unknown'
] as const

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/**
 * The codes a provider may stamp as a structured refusal. All four denial kinds collapse to
 * `permission_denied` (same operator response), but they are accepted separately so a translation can
 * be explicit about what the provider refused.
 */
export const STRUCTURED_ERROR_KINDS = [
  'permission_denied',
  'pin_mismatch',
  'scope_violation',
  'immutable',
  'tool_schema',
  'timeout',
  'network'
] as const

export type StructuredErrorKind = (typeof STRUCTURED_ERROR_KINDS)[number]

/** §7.3: these may open a candidate on the first occurrence, and only when structured. */
export const HIGH_SEVERITY_TOOL_ERROR_CODES: readonly ToolErrorCode[] = ['permission_denied']

export type ToolErrorSignal = {
  /** Bounded head of the tool output. Used ONLY for the low-confidence hint; never for severity. */
  output?: string
  /** Structured failure flag from a tool-result block or a failed call state. */
  isError?: boolean
  /** Structured provider/tool refusal kind, when the translation could stamp one. */
  errorKind?: string | null
  /** Structured exit status from the journal item (`NativeChatToolMetadata.exitCode`). */
  exitCode?: number | null
}

export type ToolErrorConfidence = 'structured' | 'exit_code' | 'text_hint' | 'unknown'

export type ToolErrorClassification = {
  code: ToolErrorCode
  confidence: ToolErrorConfidence
  /** Only a structured denial kind can set this. */
  highSeverity: boolean
  /** Redacted family the text looked like; never the code, never high severity. */
  textHint?: ToolErrorCode
}

export const ERROR_KIND_CODE: Readonly<Record<StructuredErrorKind, ToolErrorCode>> = {
  permission_denied: 'permission_denied',
  pin_mismatch: 'permission_denied',
  scope_violation: 'permission_denied',
  immutable: 'permission_denied',
  tool_schema: 'tool_schema',
  timeout: 'timeout',
  network: 'network'
}

/** The hint families, in the order a reader should trust them (denials first, they are the loudest). */
const HINT_PATTERNS: readonly { code: ToolErrorCode; re: RegExp }[] = [
  {
    code: 'permission_denied',
    re: /\b(permission denied|eacces|eperm|not permitted|operation not permitted|pin[ _-]?mismatch|pin[ _-]?changed|out of scope|outside (the )?(allowed )?(write )?(path|scope|root)|scope (violation|denied)|immutable|read[- ]only file ?system|forbidden|unauthorized|401|403)\b/i
  },
  {
    code: 'timeout',
    re: /\b(timed out|timeout|etimedout|deadline exceeded|killed after|exceeded .* time limit)\b/i
  },
  {
    code: 'command_not_found',
    re: /\b(command not found|no such command|not installed|executable not found|is not recognized as an internal|spawn \w+ enoent)\b/i
  },
  {
    code: 'path_not_found',
    re: /\b(enoent|no such file or directory|path (does not exist|not found)|cannot find (the )?(file|path))\b/i
  },
  {
    code: 'network',
    re: /\b(econnrefused|econnreset|enotfound|eai_again|network (is )?(unreachable|error)|dns|socket hang up|tls|502|503|504)\b/i
  },
  {
    code: 'tool_schema',
    re: /\b(invalid (arguments?|input|schema|parameters?)|schema (validation|error)|required property|unexpected (argument|field|property)|failed to parse (arguments|input))\b/i
  },
  {
    code: 'non_zero_exit',
    re: /\b(exited with (code|status) [1-9]\d*|exit (code|status) [1-9]\d*|non[- ]zero exit|command failed with code [1-9]\d*)\b/i
  }
]

function errorKindCode(kind: string | null | undefined): ToolErrorCode | null {
  if (typeof kind !== 'string') {
    return null
  }
  const normalized = kind.trim().toLowerCase()
  return (STRUCTURED_ERROR_KINDS as readonly string[]).includes(normalized)
    ? ERROR_KIND_CODE[normalized as StructuredErrorKind]
    : null
}

/** The text-only family, used as a hint and nothing else. */
export function textHintFor(signal: ToolErrorSignal): ToolErrorCode | undefined {
  const text = sanitizeText(signal.output ?? '', 2000)
  return HINT_PATTERNS.find(({ re }) => re.test(text))?.code
}

/**
 * Classify one failed tool call.
 *
 * Precedence is the whole point: a structured `errorKind` outranks a structured exit code (a provider
 * that says "I refused this" is more specific than "it exited 2"), and both outrank text. Text alone
 * never yields anything but `unknown` (+ hint).
 */
export function classifyToolError(signal: ToolErrorSignal): ToolErrorClassification {
  const structured = errorKindCode(signal.errorKind)
  if (structured !== null) {
    return {
      code: structured,
      confidence: 'structured',
      highSeverity: structured === 'permission_denied'
    }
  }
  if (typeof signal.exitCode === 'number' && Number.isFinite(signal.exitCode) && signal.exitCode !== 0) {
    return { code: 'non_zero_exit', confidence: 'exit_code', highSeverity: false }
  }
  const hint = textHintFor(signal)
  if (hint !== undefined) {
    // A textual family is a clustering hint for a human, not a code: it must not decide severity and
    // must not be a stable cluster key on its own.
    return { code: 'unknown', confidence: 'text_hint', highSeverity: false, textHint: hint }
  }
  return { code: 'unknown', confidence: 'unknown', highSeverity: false }
}

export function isHighSeverityToolError(code: ToolErrorCode): boolean {
  return HIGH_SEVERITY_TOOL_ERROR_CODES.includes(code)
}
