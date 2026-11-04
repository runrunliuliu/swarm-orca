import { parseTomlKeyPath, parseTomlTableHeaderPath } from '../codex/config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../codex/config-toml-line-scan'
import { escapeTomlBasicString } from '../codex/config-toml-syntax'

/** Append only; existing project policy, comments and unrelated settings are never rewritten. */
export function appendTraeWorkspaceTrust(
  existing: string,
  workspaceKeys: readonly string[]
): string {
  let state = createTomlLineScanState()
  let inRoot = true
  const headers = new Set<string>()
  for (const line of existing.split(/\r?\n/)) {
    if (isTomlStructuralLine(state) && line.trim() && !line.trimStart().startsWith('#')) {
      if (line.trimStart().startsWith('[')) {
        const header = getTomlTableHeader(line)
        const table = header === null ? null : parseTomlTableHeaderPath(header)
        if (!table) {
          throw new Error('Unrecognized Trae config table; leaving trust unchanged')
        }
        if (table.segments[0] === 'projects') {
          // Why: inline/dotted project maps need a full TOML rewrite; leave those to Trae.
          if (table.isArray || table.segments.length < 2) {
            throw new Error('Unsupported Trae projects layout; leaving trust unchanged')
          }
          if (workspaceKeys.includes(table.segments[1]!)) {
            return existing
          }
        }
        const identity = JSON.stringify(table.segments)
        if (!table.isArray && headers.has(identity)) {
          throw new Error('Duplicate Trae config table; leaving trust unchanged')
        }
        headers.add(identity)
        inRoot = false
      } else {
        const key = parseTomlKeyPath(line)
        if (!key || line[key.end] !== '=' || !line.slice(key.end + 1).trim()) {
          throw new Error('Unrecognized Trae config entry; leaving trust unchanged')
        }
        if (inRoot && key.segments[0] === 'projects') {
          throw new Error('Unsupported Trae projects layout; leaving trust unchanged')
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  if (!isTomlStructuralLine(state)) {
    throw new Error('Incomplete Trae config; leaving trust unchanged')
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const blocks = [...new Set(workspaceKeys)].map(
    (key) => `[projects."${escapeTomlBasicString(key)}"]${eol}trust_level = "trusted"${eol}`
  )
  return `${existing}${existing ? eol + eol : ''}${blocks.join(eol)}`
}
