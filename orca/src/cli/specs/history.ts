import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/**
 * The `history` family (issue #53 B, issue #31 S3). Two commands with one grammar:
 * `backfill` is the explicit repair step for records written before the snapshot
 * existed, and `task` is the read-only export of a task the record already holds.
 * Neither is a background scan, and `task` writes nothing at all.
 */
export const HISTORY_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['history', 'backfill'],
    group: 'maintenance',
    summary:
      'Backfill agent runs for an archived task workspace from the local agent session index',
    usage: 'orca history backfill --task <repo>#<number> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task'],
    notes: [
      '<repo> is a registered repo id (`repo-1`) or its checkout path (`/repos/app`); `id:<repoId>` and `path:<checkout>` name one explicitly. <number> is the tracker number; the last `#` separates them.',
      'Explicit and repeatable, never automatic: nothing runs this on a schedule or at startup. Only a binding that is archived with an empty session list is examined, so once a binding resolves, re-running is a no-op — a second identical run writes nothing at all and does not even scan. The union rule (`firstSeenAt` min, `lastSeenAt` max) covers a re-observation: a later snapshot, or another backfill, that sees the same session claim again advances that row in place and never adds a duplicate.',
      'Only bindings that are archived with no recorded sessions are touched. Everything else is reported by count; nothing is guessed.',
      'Read-only when the read would lose data: if the stored task records hold run rows this build can only load in trimmed form (over the per-binding cap), the discard is reported and nothing is written — an unrelated backfill never stores a shortened record.',
      'Local evidence only: the agent session index filtered by the binding absolute path and its time window, plus one `stat` of the transcript. The transcript content is never read or stored, only its path and dev/ino/mtime/size.',
      'Orca must be stopped. This writes the profile state database offline, like `orca profile state rollback`; while the app is running the command refuses and writes nothing.',
      'It writes no usage figure: the four usage stores belong to the running app, so tokens stay unknown rather than `0`.'
    ],
    examples: [
      'orca history backfill --task repo-1#53 --json',
      'orca history backfill --task path:/repos/app#31'
    ]
  },
  {
    path: ['history', 'task'],
    group: 'maintenance',
    summary: 'Export one task’s recorded history (read-only)',
    usage: 'orca history task <repo>#<number> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task'],
    positionalArgs: ['task'],
    notes: [
      'Read-only export of the `taskRecords` domain in this machine’s active Orca profile: it writes nothing, opens the database read-only, and needs no runtime RPC. It can run while Orca is running.',
      '<repo> is a registered repo id (`repo-1`) or its checkout path (`/repos/app`); `id:<repoId>` and `path:<checkout>` name one explicitly. <number> is the tracker number; the last `#` separates them.',
      'Unknown facts stay unknown, never `0` or `$0`: `agents` and `wall` carry a kind and an unknown reason, and `tokens` is `unavailable` with a reason when no settlement was recorded.',
      '`trace` is one of `archived`, `deleted`, or `none`; a removed workspace wins over an archived one, matching the workbench history rule. No fourth state is invented.',
      '`--json` has a stable shape: task identity, bindings, runs, the three facts (`agents`/`wall`/`tokens`) with their kind and reason, `trace`, `historySource`, and `gaps`.',
      'Transcript evidence is its path and the stored reachability check only; transcript content is never read or printed.',
      'Only records already persisted by a bound workspace are exported. This command does not reconstruct or backfill anything; use `orca history backfill` for that.'
    ],
    examples: ['orca history task repo-1#53 --json', 'orca history task path:/repos/app#31']
  }
]
