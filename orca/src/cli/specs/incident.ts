import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// Why local-only is stated in the summary itself: M1 records incidents on the host that owns the
// PTY (§11.1), and a caller who reads this help on a laptop must not assume it can list a server's
// incidents. `remote_incident_capture: unsupported` in the output is the machine-readable half of
// the same promise.

export const INCIDENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['incident', 'list'],
    group: 'daily',
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
    group: 'daily',
    summary: 'Show one incident, with its unknown boundaries and evidence pointers',
    usage: 'orca incident show <id> [--md] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'md'],
    positionalArgs: ['id'],
    examples: ['orca incident show inc_abc123', 'orca incident show inc_abc123 --md']
  },
  {
    path: ['incident', 'decide'],
    group: 'daily',
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
    path: ['incident', 'export'],
    group: 'daily',
    summary: "Export this host's incidents as NDJSON for an agent-side triage (read-only)",
    usage: 'orca incident export [--since 24h|7d|90m] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since', 'limit'],
    examples: ['orca incident export --since 7d --json', 'orca incident export --since 24h'],
    notes: [
      'One JSON record per line: meta (view, exportVersion, window, coverage), then incident rows, then end (counts, truncation). No grouping, no thresholds, no candidates.',
      'Read-only: the store is opened without writing, migrating or creating a WAL. Judgement is not in Orca; run the incident-triage skill over this stream and keep the report it produces.',
      'coverage is always present: a window with zero rows plus an incomplete shadow replay or a capacity latch is not "no incidents".',
      'Rows carry run/task/dispatch ids and evidence pointers. `incident list --json` is the human view and is intentionally unchanged; export is the machine seam.',
      '--limit bounds the stream and end.truncated says the window had more rows than were printed. A truncated window is not a total.',
      'The stream names its view (incident_triage_rows) and exportVersion, so a report can say exactly which shape it judged.'
    ]
  },
  {
    path: ['incident', 'report'],
    group: 'diagnostic',
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
    path: ['incident', 'pane-clocks'],
    group: 'diagnostic',
    summary: 'Show the stored pane event clocks (facts only; no threshold, no verdict)',
    usage: 'orca incident pane-clocks [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca incident pane-clocks', 'orca incident pane-clocks --json'],
    notes: [
      'One fact row per pane: state, the age of its last semantic event, which clock the age came from (event or state_fallback), when it was observed, and any operator wait declaration.',
      'There is no threshold and no would-write verdict: M8 removed the in-process stall judgement. A quiet pane is not an incident until triage says it is; report one with `orca incident report`.',
      'ageBasis=state_fallback is a weaker signal: the host never reported a semantic event clock, so the age falls back to stateStartedAt.',
      'This command never writes. A wait declaration is shown as context, not as a suppressor.'
    ]
  },
  {
    path: ['incident', 'tool-failures'],
    group: 'diagnostic',
    summary: 'Show recorded failed tool calls as raw facts (no normalization, no window, no verdict)',
    usage: 'orca incident tool-failures [--since 24h|7d|90m] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since', 'limit'],
    examples: ['orca incident tool-failures', 'orca incident tool-failures --since 7d --json'],
    notes: [
      'One row per failed tool call: session, turn, tool, the provider-stamped errorKind and/or exit code, and when it was observed. No text is stored.',
      'Orca does not normalize the error, count a window or decide severity any more: those are triage questions. Clustering and "is this worth fixing" belong to the incident-triage skill.',
      'Coverage is partial and stated: only claude and codex write through the structured session sink; every other agent is listed as a gap, so silence there is not health.',
      'dropped is a floor warning: rows refused by the store cap or lost to an insert failure are counted, never silently discarded.',
      'Read-only: the store is opened without writing or migrating.'
    ]
  },
  {
    path: ['incident', 'mirror'],
    group: 'diagnostic',
    summary: 'Show the remote mirror link state (read-only; never writes an incident)',
    usage: 'orca incident mirror [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca incident mirror', 'orca incident mirror --json'],
    notes: [
      'The host that owns a PTY writes its own incidents; this host only mirrors what an origin exported. remote_capture has three states: unsupported = no origin host is registered with this store, not_probed = registered but never read (treat its incidents as unknown, never as zero), mirrored = at least one origin has been read.',
      'unsynced is the origin\'s own statement of how many of its rows are still past the cursor, kept from the last time it spoke; unknown means the origin never said. unreachable counts origins whose most recent probe failed.',
      'Rows refused because this host already owns the fact key, and rows an operator pruned, are counted rather than hidden: one fact is one row, and a mirror never resurrects a deleted one.',
      'Pulling happens in the runtime (startup and reconnect); this command only reports the link rows and never opens a remote connection.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'list'],
    group: 'diagnostic',
    summary: 'List dispatch acceptance rules, gates and stops (read-only)',
    usage: 'orca incident acceptance list [--dispatch <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch'],
    notes: [
      'A blocked dispatch with a pending stop is the visible stop: it is never settled by acceptance, and it never silently stays running without an owner.',
      'STOP=rejected means the dispatch STAYS UNSETTLED until its owner repairs the work and reports again — nothing resumes automatically.',
      'STOP=accepted means settlement resumes on the coordinator\'s next tick, which re-reads the unread worker_done.',
      'STOP=overridden means an operator settled it with --override-acceptance on a maintenance command; the skipped rules are listed and the audit incident is class acceptance_overridden.',
      'If the incidents store cannot be read the command says so instead of printing an empty list: settlement on such a host is fail-closed.',
      'actor values are self-reported.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'show'],
    group: 'diagnostic',
    summary: 'Show one dispatch acceptance state, including expected vs actual per rule',
    usage: 'orca incident acceptance show --dispatch <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch'],
    notes: [
      'Shows each rule, its latest verdict, the actual exit code, the stdout sha256 and byte count — never the output text.',
      'actor values are self-reported.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'declare'],
    group: 'maintenance',
    summary: 'Declare an acceptance rule for a dispatch (does not run it)',
    usage:
      'orca incident acceptance declare --dispatch <id> --rule <id> --cwd <dir> --worktree-root <root> ' +
      '--command <program> [--command <arg>]... [--expect-exit <n>] [--expect-stdout <substr>] ' +
      '[--timeout-ms <n>] [--actor <name>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'dispatch',
      'rule',
      'cwd',
      'worktree-root',
      'command',
      'expect-exit',
      'expect-stdout',
      'timeout-ms',
      'actor'
    ],
    repeatableFlags: ['command'],
    examples: [
      'orca incident acceptance declare --dispatch disp_1 --rule tests --worktree-root /path/to/worktree --cwd /path/to/worktree --command npm --command test --expect-exit 0',
      'orca incident acceptance declare --dispatch disp_1 --rule archive --worktree-root /path/to/worktree --cwd /path/to/worktree/packages/app --command test --command -f --command out/report.json --expect-stdout "PASS"'
    ],
    notes: [
      'argv only: the first --command is the program, each later one is an argument. No shell is involved, so nothing is interpolated.',
      '--worktree-root is required: it must be an existing git worktree root on this host, and --cwd must be that root or a directory inside it. Both are resolved through realpath before the declaration is stored, so a symlinked or escaping cwd is refused.',
      'The stored rule is bound to its digest: changing any part of it (including the root) invalidates the previous verdict and reopens a resolved stop.',
      'At least one of --expect-exit / --expect-stdout is required. Multiple rules per dispatch are allowed and judged independently.',
      'Re-declaring the same --rule replaces it; the rule id is the idempotency key.',
      'The actor is self-reported and never verified (§19.1). Declaring does not execute anything.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'resolve'],
    group: 'maintenance',
    summary: 'Resolve a pending acceptance stop (accept or reject)',
    usage:
      'orca incident acceptance resolve --dispatch <id> (--accept | --reject) --actor <name> --reason <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'accept', 'reject', 'actor', 'reason'],
    destructive: true,
    notes: [
      '--accept lets settlement resume through the existing flow; --reject records the decision and leaves the dispatch unsettled for its owner.',
      'This command never fails a dispatch and never settles one itself.',
      '--actor is required and self-reported (§19.1): the decision names a person, it does not verify one.'
    ]
  },
  {
    path: ['incident', 'wait'],
    group: 'maintenance',
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
    path: ['incident', 'prune'],
    group: 'maintenance',
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
