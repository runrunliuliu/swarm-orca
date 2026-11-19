import { useEffect, useState } from 'react'
import type {
  TaskRunHistoryRecord,
  TaskRunHistoryTaskQuery
} from '../../../shared/task-run-history'

export type TaskRunHistoryLoad = {
  /** True until the first answer arrives; the panel must not claim "never
   *  started" while the ledger has not been read yet. */
  pending: boolean
  records: TaskRunHistoryRecord[]
}

/**
 * Read-only view of the worktree → task ledger (issue #31 S2). The main process
 * writes it where worktree metadata is written; the renderer only asks what
 * survived. A missing bridge (old preload) is an empty, already-loaded ledger,
 * never a pending one that would hide the empty state forever.
 */
export function useTaskRunHistory(query: TaskRunHistoryTaskQuery | null): TaskRunHistoryLoad {
  const [load, setLoad] = useState<TaskRunHistoryLoad>({ pending: true, records: [] })
  const repoId = query?.repoId ?? null
  const itemType = query?.itemType ?? null
  const number = query?.number ?? null

  useEffect(() => {
    const api = window.api?.taskRunHistory
    if (repoId === null || itemType === null || number === null || !api) {
      setLoad({ pending: false, records: [] })
      return
    }
    let cancelled = false
    // Drop the previous task's rows immediately: keeping them while the new
    // query is in flight would merge another task's deleted record for a frame.
    setLoad({ pending: true, records: [] })
    void api
      .get({ repoId, itemType, number })
      .then((result) => {
        if (!cancelled) {
          setLoad({ pending: false, records: result.records })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({ pending: false, records: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, itemType, number])

  return load
}
