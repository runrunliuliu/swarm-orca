import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why local-only is stated in the summary itself: M1 records incidents on the host that owns the
// PTY (§11.1), and a caller who reads this help on a laptop must not assume it can list a server's
// incidents. `remote_incident_capture: unsupported` in the output is the machine-readable half of
// the same promise.

export const INCIDENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['incident', 'list'],
    summary: "List this host's recorded incidents (local only)",
    usage:
      'orca incident list [--limit <n>] [--status <status>] [--class <class>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'status', 'class'],
    examples: [
      'orca incident list',
      'orca incident list --status untriaged --limit 20',
      'orca incident list --class crash --json'
    ],
    notes: [
      'Crashes are recorded by this host only. Remote (SSH) hosts are not captured: the output always reports remote_incident_capture=unsupported.',
      'currently_limited=true means the store is refusing new non-crash rows right now; capacity_latch_set=true means it has refused before (a prune can clear the limit, not the history).'
    ]
  },
  {
    path: ['incident', 'show'],
    summary: 'Show one incident, with its unknown boundaries and evidence pointers',
    usage: 'orca incident show <id> [--md] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'md'],
    positionalArgs: ['id'],
    examples: ['orca incident show inc_abc123', 'orca incident show inc_abc123 --md']
  },
  {
    path: ['incident', 'decide'],
    destructive: true,
    summary: 'Record a triage decision for one incident (append-only)',
    usage:
      'orca incident decide <id> --to <status> --reason <text> [--actor <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'to', 'actor', 'reason'],
    positionalArgs: ['id'],
    examples: [
      'orca incident decide inc_abc123 --to watch --reason "waiting for a second occurrence"',
      'orca incident decide inc_abc123 --to confirmed --actor alice --reason "reproduced"'
    ],
    notes: [
      '--actor is self-reported and never verified; it is kept as an audit trail, not a permission.',
      '--actor is required for --to confirmed and optional elsewhere (unspecified).',
      'Decisions are appended: an incident row is never edited.'
    ]
  },
  {
    path: ['incident', 'report'],
    summary: "Record an incident you observed yourself (self-report, local only)",
    usage:
      'orca incident report --class <class> --code <code> [--summary <text>] [--evidence <path>]... [--repro <text>] [--source-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'class',
      'code',
      'summary',
      'evidence',
      'repro',
      'source-id'
    ],
    repeatableFlags: ['evidence'],
    examples: [
      'orca incident report --class tool_error --code tool_schema_mismatch --summary "write tool rejected a valid patch"',
      'orca incident report --class crash --code worker_died --evidence ./agent.log --repro "run the same dispatch twice"'
    ],
    notes: [
      '--class and --code are required. The record starts untriaged: a self-report is T3 and is never independently verified by this command.',
      '--evidence paths must exist on this host; only the path, size and sha256 are stored (never the contents). Each file is capped at 64 MiB and an oversized file is refused, not skipped.',
      '--evidence path strings are stored as given (redacted for credentials): a path can itself name a sensitive project, so pass a copy when that matters.',
      '--source-id makes the report idempotent: repeating it appends nothing, and the existing record is never overwritten.'
    ]
  },
  {
    path: ['incident', 'prune'],
    destructive: true,
    summary: 'Delete old closed/invalid/duplicate incidents (dry run by default)',
    usage: 'orca incident prune [--dry-run | --apply] [--keep-days <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dry-run', 'apply', 'keep-days'],
    examples: ['orca incident prune', 'orca incident prune --apply --keep-days 90'],
    notes: [
      'Without --apply this only reports candidates; nothing is deleted.',
      'Only closed, invalid and duplicate incidents older than --keep-days (default 90) are eligible; untriaged/confirmed/needs_archive never are.',
      '--json reports the candidate ids and the ids actually deleted (capped, with a truncation flag) so the retained decision rows stay locatable.',
      'Decision rows are retained after prune: they are the audit trail of why a row was removed.'
    ]
  }
]
