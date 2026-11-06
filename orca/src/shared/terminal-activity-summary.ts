import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { getAgentLabel } from './agent-title-identity'
import type { AgentStatusEntry } from './agent-status-types'

/**
 * One-line "what is this terminal doing right now" summary for tabs, palette rows and
 * sidebar cards. Status rows already carry the facts (current tool + input, last assistant
 * message, the live prompt); harness titles do not — Codex Ark and Trae TUI print a task
 * line, but a bare `Codex` / `⠋ Trae` title says nothing. Deriving the line here keeps one
 * rule for every surface instead of one heuristic per component.
 */

/** Hard cap so a tab label and a palette row stay scannable; CSS truncates whatever is left. */
export const TERMINAL_ACTIVITY_SUMMARY_MAX_LENGTH = 32

// Harness identity tokens: a title made only of these carries no work description.
const AGENT_TITLE_TOKENS: ReadonlySet<string> = new Set([
  'agent',
  'agy',
  'aider',
  'antigravity',
  'ark',
  'claude',
  'cli',
  'code',
  'codebuddy',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'droid',
  'dsh',
  'gemini',
  'grok',
  'hermes',
  'mimo',
  'omp',
  'openclaude',
  'opencode',
  'pi',
  'qoder',
  'terminal',
  'trae',
  'traex'
])

// State words a harness may write into its own title without describing any work.
const STATUS_TITLE_TOKENS: ReadonlySet<string> = new Set([
  'action',
  'blocked',
  'done',
  'idle',
  'input',
  'needs',
  'permission',
  'ready',
  'required',
  'running',
  'thinking',
  'waiting',
  'working'
])

const VERSION_TOKEN = /^v?\d+(?:\.\d+)*$/
// Why: a bare `.` ends a sentence but also separates a filename from its extension — only a period
// followed by whitespace (or the end) is a clause break, so `Edit: a.ts` survives.
const SUMMARY_CLAUSE_BREAK = /[!?;\n\r\u2028\u2029]|\.(?=\s|$)/u
// Why: match the tab-title scan budget so a paste-sized prompt cannot reach a renderer path.
const SUMMARY_SOURCE_SCAN_LIMIT = 512
const MIN_WORD_BOUNDARY_RATIO = 0.55

function isTitleSeparator(char: string): boolean {
  return !/[\p{L}\p{N}]/u.test(char)
}

function tokenizeTitle(title: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const char of title) {
    if (isTitleSeparator(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function foldWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/** Collapse to one clause and clip at a word boundary, code-point aware. */
export function shortenTerminalActivityText(
  value: string,
  maxLength: number = TERMINAL_ACTIVITY_SUMMARY_MAX_LENGTH
): string {
  const preview = value.slice(0, SUMMARY_SOURCE_SCAN_LIMIT)
  const folded = foldWhitespace(preview)
  if (!folded) {
    return ''
  }
  const breakIndex = folded.search(SUMMARY_CLAUSE_BREAK)
  const firstClause = breakIndex === -1 ? folded : folded.slice(0, breakIndex)
  const candidate = foldWhitespace(firstClause) || folded
  const characters = Array.from(candidate)
  if (characters.length <= maxLength) {
    return candidate
  }
  const clipped = characters.slice(0, maxLength).join('')
  const lastSpace = clipped.lastIndexOf(' ')
  const body =
    lastSpace >= Math.floor(maxLength * MIN_WORD_BOUNDARY_RATIO)
      ? clipped.slice(0, lastSpace)
      : clipped
  return `${body.trimEnd()}…`
}

/**
 * True when a terminal title names work, not just the harness or its state.
 * `agentIdentityRequired` is for callers that already know an agent owns the pane: a title with
 * no harness identity at all (`zsh`, a branch name) then counts as "no description" instead of
 * being read as a task line.
 */
export function titleCarriesActivityText(
  title: string,
  options: { agentIdentityRequired?: boolean } = {}
): boolean {
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(title)
  if (!stripped) {
    return false
  }
  const label = getAgentLabel(title)
  if (!label && options.agentIdentityRequired) {
    return false
  }
  const identityTokens = new Set(AGENT_TITLE_TOKENS)
  for (const token of label ? tokenizeTitle(label) : []) {
    identityTokens.add(token.toLowerCase())
  }
  for (const token of tokenizeTitle(stripped)) {
    const lower = token.toLowerCase()
    if (identityTokens.has(lower) || STATUS_TITLE_TOKENS.has(lower) || VERSION_TOKEN.test(lower)) {
      continue
    }
    return true
  }
  return false
}

/**
 * Resolve the live activity line for one pane status row. Empty means "nothing honest to
 * say" (finished, interrupted, monitoring a background turn, or never reported a prompt),
 * and callers fall back to the tab title.
 */
export function resolveAgentActivitySummary(
  entry: Pick<
    AgentStatusEntry,
    | 'state'
    | 'workingMode'
    | 'interrupted'
    | 'toolName'
    | 'toolInput'
    | 'lastAssistantMessage'
    | 'prompt'
  >
): string {
  // Why: a done/interrupted pane is not doing anything; a stale tool line would claim it is.
  if (entry.state === 'done' || entry.interrupted) {
    return ''
  }
  if (entry.workingMode === 'monitoring') {
    return ''
  }
  const toolName = entry.toolName?.trim() ?? ''
  const toolInput = entry.toolInput?.trim() ?? ''
  if (toolName) {
    return shortenTerminalActivityText(toolInput ? `${toolName}: ${toolInput}` : toolName)
  }
  const assistantMessage = entry.lastAssistantMessage?.trim() ?? ''
  if (assistantMessage) {
    const assistantSummary = shortenTerminalActivityText(assistantMessage)
    if (assistantSummary) {
      return assistantSummary
    }
  }
  const prompt = entry.prompt?.trim() ?? ''
  return prompt ? shortenTerminalActivityText(prompt) : ''
}

/** Prefer the title when it already names work; otherwise show what the pane is doing. */
export function composeTerminalTitleWithActivity(
  title: string,
  activitySummary: string,
  options: { agentIdentityRequired?: boolean } = {}
): string {
  const summary = activitySummary.trim()
  if (!summary) {
    return title
  }
  return titleCarriesActivityText(title, options) ? title : summary
}
