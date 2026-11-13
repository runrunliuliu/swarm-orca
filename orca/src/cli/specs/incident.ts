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
      'Per session + TURN + tool + normalized code: the current count, the window span, and whether a write-enabled collector would record it. A new turn starts a new window.',
      'Normalized codes: permission_denied, path_not_found, command_not_found, timeout, non_zero_exit, tool_schema, network, unknown. permission_denied is the high-severity single-hit code.',
      'The original error text is never stored; windowing is in-process, so a restart resets the counts. Turns, LRU evictions and list truncation are all reported in the output.',
      'Codes come from structured evidence: a provider-stamped refusal kind, or a structured non-zero exit code. Text-only matches are recorded as unknown with a low-confidence hint and never open a candidate on their own.',
      'Coverage is partial: only claude and codex write through the structured session sink; every other agent is listed as a coverage gap, so silence there is not health.',
      'Default mode writes zero incident ROWS but still publishes this snapshot (INCIDENT_TOOL_ERROR_WRITE=on in the host process to write rows; this command never writes).'
    ]
  },
  {
    path: ['incident', 'digest'],
    summary: 'Daily summary of incident counts (read-only; no mining, no triage)',
    usage: 'orca incident digest [--since 24h|7d|90m] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since'],
    examples: ['orca incident digest', 'orca incident digest --since 7d --json'],
    notes: [
      'Counts by class, effective status and fingerprint (top 5), plus unseen/untriaged, dropped shadow lines, replay state, capacity and tool-error windows.',
      'unseen = effective status is still `untriaged`. It is not a per-person read marker: the store has no such field, and the digest does not invent one.',
      'Every number is one aggregate over the incidents database, so it cannot drift from the store. `orca incident mine --json` embeds this same object, so the triage view and the counting view always agree.',
      'Designed to be run by a scheduled automation: a session runs this command and posts the output. No scheduler is added in code.'
    ]
  },
  {
    path: ['incident', 'mine'],
    summary: 'Cluster incidents into bounded triage candidates (dry-run; --apply writes decisions only)',
    usage:
      'orca incident mine [--since 7d] [--max-groups <n>] [--max-candidates <n>] ' +
      '[--time-budget-ms <n>] [--target watch|duplicate|needs_archive] [--apply] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'since',
      'max-groups',
      'max-candidates',
      'time-budget-ms',
      'target',
      'apply'
    ],
    examples: [
      'orca incident mine',
      'orca incident mine --since 7d --json',
      'orca incident mine --apply --target watch --max-candidates 10'
    ],
    notes: [
      'Groups by fingerprint inside the window and reports class/source_kind counts, distinct source ids, first/last seen, the worktrees and runs involved, and the rule that promoted the cluster.',
      'Candidate rules: at least 3 rows from at least 2 distinct source ids; a crash cluster carrying a signal, or an acceptance_failed cluster on one invariant, may qualify on 2 rows. The thresholds are constants in incident-mine.ts.',
      'Rows already duplicate/invalid/closed are excluded from the cluster counts and reported separately, so a triaged accident cannot keep growing a cluster.',
      'Dry run by default: it prints the clusters, the selected candidates and what it would set, and writes nothing (the store is opened read-only).',
      '--apply appends one decision per candidate with actor=miner. The reason carries the rule name and its statistics (count, distinct source ids, first/last seen), never an incident body.',
      'The miner can only set watch, duplicate or needs_archive. `confirmed` is refused by name: that decision needs a human or independent context (R1).',
      'Repeat runs are idempotent: an incident already in the target state, or already duplicate/invalid/closed, is skipped and no decision is appended, so running twice does not grow the decision log.',
      'Bounded: --max-groups and --max-candidates cap the output, and a wall-clock budget caps the pass. Every cap that fires is reported (truncated.*) together with the full totals, so truncation is never silent.',
      '--json emits a stable shape (version: 1) for automations: totals, excluded, truncated, limits, clusters, candidates, digest. No scheduler and no automation type is added in code.',
      'The `digest` field is the very object `orca incident digest` returns for the same window, built by the same function: the two commands cannot report different totals, capacity or replay state. Both text outputs print that coverage block through one formatter.',
      'The miner never changes a dispatch, an orchestration row, or any code: repair work stays a separate authorised task.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'declare'],
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
    path: ['incident', 'acceptance', 'list'],
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
    summary: 'Show one dispatch acceptance state, including expected vs actual per rule',
    usage: 'orca incident acceptance show --dispatch <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch'],
    notes: [
      'Shows each rule, its latest verdict, the actual exit code, the stdout sha256 and byte count — never the output text.',
      'actor values are self-reported.'
    ]
  },
  {
    path: ['incident', 'acceptance', 'resolve'],
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
