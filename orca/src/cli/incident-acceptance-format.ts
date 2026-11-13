// Formatting for `orca incident acceptance …` (M5-1/M5-4).
//
// The reader's questions are: which dispatch is still hung, which rule failed, expected vs actual, and
// what the operator can do. Every output states that the actor is self-reported (§19.1) so a decision
// recorded here is not mistaken for a verified signature.

import type {
  AcceptanceRule,
  AcceptanceStop,
  AcceptanceVerdict
} from '../main/incidents/dispatch-acceptance-store'

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

function expected(rule: AcceptanceRule): string {
  const parts: string[] = []
  if (rule.expect.exitCode !== undefined) {
    parts.push(`exit=${rule.expect.exitCode}`)
  }
  if (rule.expect.stdoutMatches !== undefined) {
    parts.push(`stdout~${JSON.stringify(rule.expect.stdoutMatches)}`)
  }
  return parts.join(' ')
}

export function formatAcceptanceDeclared(rule: AcceptanceRule): string {
  return (
    `Declared acceptance rule ${rule.ruleId} for dispatch ${rule.dispatchId}: ` +
    `${rule.program}${rule.args.length > 0 ? ` ${rule.args.join(' ')}` : ''} ` +
    `(cwd=${rule.cwd}, ${expected(rule)}, timeout=${rule.timeoutMs}ms, digest=${rule.digest.slice(0, 12)}…)\n` +
    `actor=${rule.actor} (self-reported, not verified). Declaring does not run the command.`
  )
}

type ListRow = {
  dispatchId: string
  rules: AcceptanceRule[]
  stop: AcceptanceStop | null
  gate: { state: string } | null
}

export function formatAcceptanceList(rows: readonly ListRow[]): string {
  if (rows.length === 0) {
    return 'No acceptance rules declared on this host.'
  }
  const lines = [
    `${pad('DISPATCH', 24)} ${pad('RULES', 6)} ${pad('GATE', 10)} ${pad('STOP', 10)} OWNER ACTION`
  ]
  for (const row of rows) {
    const blocked = row.gate?.state === 'blocked'
    const action =
      blocked && row.stop?.state === 'pending'
        ? `orca incident acceptance resolve --dispatch ${row.dispatchId} --accept|--reject --actor <name> --reason <text>`
        : blocked
          ? 'reviewed; settlement resumes through the existing flow'
          : '—'
    lines.push(
      `${pad(row.dispatchId, 24)} ${pad(String(row.rules.length), 6)} ${pad(row.gate?.state ?? '—', 10)} ` +
        `${pad(row.stop?.state ?? '—', 10)} ${action}`
    )
    for (const rule of row.rules) {
      lines.push(`  ${rule.ruleId}: ${expected(rule)}`)
    }
  }
  lines.push('')
  lines.push('actor values are self-reported and never verified.')
  return lines.join('\n')
}

export function formatAcceptanceShow(input: {
  dispatchId: string
  rules: readonly AcceptanceRule[]
  verdicts: readonly AcceptanceVerdict[]
  stop: AcceptanceStop | null
  gate: { state: string } | null
}): string {
  const verdictByRule = new Map(input.verdicts.map((verdict) => [verdict.ruleId, verdict]))
  const lines: string[] = []
  lines.push(`${input.dispatchId}: gate=${input.gate?.state ?? 'unknown'} stop=${input.stop?.state ?? '—'}`)
  for (const rule of input.rules) {
    const verdict = verdictByRule.get(rule.ruleId)
    lines.push(`  ${rule.ruleId}: ${expected(rule)}  cwd=${rule.cwd}`)
    lines.push(
      verdict
        ? `    verdict=${verdict.verdict}  actual=${verdict.exitCode === null ? '—' : `exit=${verdict.exitCode}`}` +
            `  detail=${verdict.detail ?? '—'}  stdout_sha256=${verdict.stdoutDigest?.slice(0, 12) ?? '—'}…` +
            `  bytes=${verdict.stdoutBytes ?? '—'}  at=${new Date(verdict.evaluatedAt).toISOString()}`
        : '    verdict=not_evaluated'
    )
  }
  if (input.stop !== null) {
    lines.push(
      `  stop: state=${input.stop.state} attempts=${input.stop.attempts} ` +
        `opened=${new Date(input.stop.openedAt).toISOString()}` +
        `${input.stop.actor ? ` actor=${input.stop.actor}` : ''}` +
        `${input.stop.reason ? ` reason=${input.stop.reason}` : ''}`
    )
  }
  lines.push('')
  lines.push(
    'Expected vs actual is shown per rule. The command output itself is not stored — only its sha256 ' +
      'and byte count.'
  )
  lines.push('actor values are self-reported and never verified.')
  return lines.join('\n')
}
