// Normalized tool-error codes (issue-sedimentation.md v2.5 §7.3, M4-1).
//
// The classifier exists so a cluster is a *stable code*, not a string that differs by provider, model
// phrasing or a temp path. Three rules it must never break:
//   * the raw error text is never stored — only the code is;
//   * the text is only used to pick a cluster code, never to decide handling (the write decision is
//     `code + count + threshold`, and high-severity is a fixed set of codes);
//   * the input is sanitized before it is matched, so a secret in the output cannot even reach a
//     regex working copy that might later be logged.
//
// `permission_denied` deliberately absorbs the design's "permission / pin / scope / immutable" family:
// they are all "a policy refused this call", they share the same operator response, and splitting them
// would multiply codes without changing any decision. It is also the high-severity single-hit code.

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

/** §7.3: these may open a candidate on the first occurrence. */
export const HIGH_SEVERITY_TOOL_ERROR_CODES: readonly ToolErrorCode[] = ['permission_denied']

export type ToolErrorSignal = {
  toolName?: string
  /** Bounded head of the tool output. Matched, then dropped; never persisted. */
  output?: string
  isError?: boolean
  exitCode?: number | null
}

/** Ordered: the first family that matches wins, and high-severity families come first. */
const PATTERNS: readonly { code: ToolErrorCode; re: RegExp }[] = [
  {
    // permission denied / EACCES / pin mismatch / out of scope / immutable / read-only refusal
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

/**
 * Classify one failed tool call.
 *
 * `isError === false` is not an error at all (the caller filters first); an exit code takes precedence
 * because it is structured evidence rather than a phrase. Everything unrecognized is `unknown` —
 * which is itself a cluster, not a null to be guessed away.
 */
export function classifyToolError(signal: ToolErrorSignal): ToolErrorCode {
  if (signal.isError === false) {
    return 'unknown'
  }
  const text = sanitizeText(signal.output ?? '', 2000)
  for (const { code, re } of PATTERNS) {
    if (re.test(text)) {
      return code
    }
  }
  if (typeof signal.exitCode === 'number' && signal.exitCode !== 0) {
    // A structured non-zero status outranks nothing above it (those already matched), but it is
    // better evidence than "unknown".
    return 'non_zero_exit'
  }
  return 'unknown'
}

export function isHighSeverityToolError(code: ToolErrorCode): boolean {
  return HIGH_SEVERITY_TOOL_ERROR_CODES.includes(code)
}
