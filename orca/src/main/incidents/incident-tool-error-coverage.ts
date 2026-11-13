// Which providers this collector actually sees (issue-sedimentation.md v2.5 §7.3; M4-C3).
//
// Coverage is a claim, so it is stated rather than implied. Tool errors are collected from the
// *structured session* event sink, and only the structured-adapter router's providers write through
// it. Every other launchable agent reports its tool activity through a path this collector never sees,
// so `tool-errors` lists them as a gap: silence from them must not read as "no tool errors".
//
// The uncovered list is the TuiAgent union minus the routed two, kept here (rather than imported)
// because that union is compile-time only. When a provider joins `structured-agent-session-adapter-router`,
// move it to `covered` in the same change.

export const TOOL_ERROR_COVERED_PROVIDERS = ['claude', 'codex'] as const

export const TOOL_ERROR_UNCOVERED_PROVIDERS = [
  'claude-agent-teams', 'codebuddy', 'openclaude', 'codex-ark', 'autohand', 'opencode', 'opencode2', 'mimo-code', 'pi', 'omp', 'qoder', 'gemini', 'antigravity', 'aider', 'goose', 'amp', 'kilo', 'kiro', 'crush', 'aug', 'cline', 'codebuff', 'freebuff', 'command-code', 'continue', 'cursor', 'droid', 'kimi', 'mistral-vibe', 'qwen-code', 'rovo', 'hermes', 'openclaw', 'copilot', 'grok', 'devin', 'ante', 'trae', 'muse', 'zcode', 'prime-agent', 'dsh'
] as const

/**
 * Gaps that bound how the numbers may be read. Printed with `tool-errors` and kept as data so the CLI
 * cannot drop one silently.
 */
export const TOOL_ERROR_COVERAGE_NOTES = [
  'High severity (single hit) requires a structured provider refusal kind; no provider stamps one yet, so permission_denied is unreachable in practice until a translation does.',
  'Text-only matches are recorded as unknown with a low-confidence hint and never open a candidate on their own.',
  'unknown and non_zero_exit have no separate noise quota this milestone: observe them in default mode before enabling INCIDENT_TOOL_ERROR_WRITE.'
] as const

/** Precondition for turning the switch on, stated where an operator reads it. */
export const TOOL_ERROR_WRITE_PRECONDITION =
  'Before INCIDENT_TOOL_ERROR_WRITE=on: run `orca incident tool-errors` for a while and confirm the ' +
  'unknown/non_zero_exit windows are not wall-to-wall; those two codes have no quota yet.'
