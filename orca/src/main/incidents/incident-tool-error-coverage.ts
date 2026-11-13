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
  'Rows are raw facts: the provider-stamped errorKind (if any) and/or exit code. Orca does not normalize them, window them, or decide severity.',
  'Only claude and codex write through the structured session sink; every other agent is a declared coverage gap, so silence there is not health.'
] as const
