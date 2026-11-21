import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/**
 * The `history` family (issue #53 B). One command, and it is deliberately the only
 * one: the backfill is an explicit repair step for records written before the
 * snapshot existed, not a read surface (reading the task history is the workbench's
 * job, and `orca history task` belongs to issue #31).
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
  }
]
