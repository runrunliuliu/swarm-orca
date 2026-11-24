import type { TaskWorkbenchRecordSource } from '@/components/task-workbench/task-workbench-view'
import type { TaskRecordSources } from './task-workbench-record-sources'

/**
 * The presentational projection of where a task's record came from (issue #31).
 *
 * Kept out of the store-reading hook because it is a decision, not a read: which
 * environments count as "asked", which failures are worth a sentence, and how a
 * disagreement is named. The hook's job is to obtain facts; this function's is to
 * say them, so the panel cannot print a verdict the facts do not support.
 *
 * Two rules:
 * - An environment is *asked* only when it is in `environmentIds`. A source the
 *   client never tried (an environment switch mid-read) is not an absence.
 * - `kept: null` means the client's own profile won a tie. The panel prints that
 *   as "this computer", not as an empty string, because the id would be a machine
 *   identifier the reader cannot act on.
 */
export function projectTaskRecordSource(args: {
  environmentIds: readonly string[]
  sources: TaskRecordSources
  pending: boolean
  /** Display names by environment id (the environment catalog). */
  labels?: ReadonlyMap<string, string>
  /** The host's own app version by environment id (the status store). Printed
   *  only with `unsupported`, where the version is the actionable fact. */
  appVersions?: ReadonlyMap<string, string>
}): TaskWorkbenchRecordSource | undefined {
  if (args.environmentIds.length === 0) {
    return undefined
  }
  const asked = new Set(args.environmentIds)
  return {
    environmentIds: [...args.environmentIds],
    answered: args.sources.answered.flatMap((target) =>
      target.kind === 'environment' && asked.has(target.environmentId) ? [target.environmentId] : []
    ),
    unavailable: args.sources.unavailable.flatMap((entry) => {
      const target = entry.target
      if (target.kind !== 'environment' || !asked.has(target.environmentId)) {
        return []
      }
      const label = args.labels?.get(target.environmentId)
      const appVersion = args.appVersions?.get(target.environmentId)
      return [
        {
          environmentId: target.environmentId,
          failure: entry.failure,
          ...(label ? { label } : {}),
          ...(entry.failure === 'unsupported' && appVersion ? { appVersion } : {})
        }
      ]
    }),
    conflicts: args.sources.conflicts.map((conflict) => ({
      worktreeId: conflict.worktreeId,
      kept: conflict.kept.kind === 'environment' ? conflict.kept.environmentId : null,
      fields: [...conflict.fields]
    })),
    pending: args.pending
  }
}
