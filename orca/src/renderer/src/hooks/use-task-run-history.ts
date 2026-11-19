import { useEffect, useState } from 'react'
import type {
  TaskRunHistoryRecord,
  TaskRunHistoryTaskQuery
} from '../../../shared/task-run-history'

export type TaskRunHistoryLoad = {
  /** True until the first answer arrives; the panel must not claim "never
   * started" while the ledger has not been read yet. */
  pending: boolean
  records: TaskRunHistoryRecord[]
}

/** The answer plus the query it answers. Kept in state because a prop change
 *  renders before its effect runs: without the key, the first render of a new
 *  task would hand the previous task's records to the caller (issue #38 review
 *  R1) — another task's deleted workspace would name this one for a frame. */
type LoadedTaskRunHistory = TaskRunHistoryLoad & { key: string | null }

const IDLE: TaskRunHistoryLoad = { pending: false, records: [] }

/** One string for the task a ledger query means. `\0` cannot appear in a repo
 *  id or an item type, so two different tasks cannot collapse into one key. */
function queryKey(query: TaskRunHistoryTaskQuery | null): string | null {
  return query === null ? null : `${query.repoId}\0${query.itemType}\0${query.number}`
}

/**
 * Read-only view of the worktree → task ledger (issue #31 S2). The main process
 * writes it where worktree metadata is written; the renderer only asks what
 * survived. A missing bridge (old preload) is an empty, already-loaded ledger,
 * never a pending one that would hide the empty state forever.
 */
export function useTaskRunHistory(query: TaskRunHistoryTaskQuery | null): TaskRunHistoryLoad {
  const [load, setLoad] = useState<LoadedTaskRunHistory>({
    key: null,
    pending: true,
    records: []
  })
  const key = queryKey(query)
  const repoId = query?.repoId ?? null
  const itemType = query?.itemType ?? null
  const number = query?.number ?? null

  useEffect(() => {
    const api = window.api?.taskRunHistory
    if (repoId === null || itemType === null || number === null || !api) {
      setLoad({ key, pending: false, records: [] })
      return
    }
    let cancelled = false
    // Drop the previous task's rows immediately: keeping them while the new
    // query is in flight would merge another task's deleted record for a frame.
    setLoad({ key, pending: true, records: [] })
    void api
      .get({ repoId, itemType, number })
      .then((result) => {
        if (!cancelled) {
          setLoad({ key, pending: false, records: result.records })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({ key, pending: false, records: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, repoId, itemType, number])

  // The render-time guard the effect cannot provide: between the prop change and
  // the effect, `load` still answers the previous task. Answering with the old
  // rows would be exactly the cross-task leak this workbench exists to avoid, so
  // a mismatched answer reads as "still loading" instead.
  if (key === null) {
    return IDLE
  }
  if (load.key !== key) {
    return { pending: true, records: [] }
  }
  return { pending: load.pending, records: load.records }
}
