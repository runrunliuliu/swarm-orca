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
    path: ['incident', 'wait'],
    summary: 'Declare that a pane is expected to be quiet (suppresses stall judgement)',
    usage:
      'orca incident wait --terminal <handle> --reason <text> [--until <rfc3339>] [--actor <name>] [--json]\n' +
      '       orca incident wait --terminal <handle> --clear [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'reason', 'until', 'clear', 'actor'],
    examples: [
      'orca incident wait --terminal term_abc --reason "long training run" --until 2026-11-13T20:00:00Z',
      'orca incident wait --terminal term_abc --clear'
    ],
    notes: [
      'The declaration binds to the pane epoch observed in the last sample, so a respawned pane never inherits it.',
      '--until must be a future RFC3339 timestamp. Give long waits a deadline; a declaration without one lives until --clear and is only for cases a human has explicitly confirmed.',
      '--clear removes EVERY declaration of that pane (all epochs), and cannot be combined with --reason/--until/--actor.',
      '--actor is self-reported and unverified (§19.1); it defaults to "unspecified".'
    ]
  },
  {
    path: ['incident', 'stalls'],
    summary: 'Show the last stall sample per pane (read-only; never writes an incident)',
    usage: 'orca incident stalls [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca incident stalls', 'orca incident stalls --json'],
    notes: [
      'A pane is listed with its state, age, age basis (event or state_fallback), threshold, wait declaration and wouldWriteIfEnabled verdict.',
      'This is a grayscale judgement, not a recorded accident: the default mode writes no incident, and wouldWriteIfEnabled=yes does not mean one exists.',
      'Writing no_progress incidents is off by default and controlled by INCIDENT_STALL_WRITE=on in the host process; this command never writes.'
    ]
  },
  {
    path: ['incident', 'tool-errors'],
    summary: 'Show the tool-error sliding windows (read-only; never writes an incident)',
    usage: 'orca incident tool-errors [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca incident tool-errors', 'orca incident tool-errors --json'],
    notes: [
      'Per session + tool + normalized code: the current count, the window span, and whether a write-enabled collector would record it.',
      'Normalized codes: permission_denied, path_not_found, command_not_found, timeout, non_zero_exit, tool_schema, network, unknown. permission_denied is the high-severity single-hit code.',
      'The original error text is never stored; windowing is in-process, so a restart resets the counts.',
      'Writing tool_error incidents is off by default (INCIDENT_TOOL_ERROR_WRITE=on in the host process); this command never writes.'
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
