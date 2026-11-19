import { useEffect, useState } from 'react'
import type { TaskRecord, TaskRecordItemType } from '../../../shared/task-records-types'

export type TaskRecordLoad = {
  /** True until the first answer arrives. The panel must not claim "no history"
   *  while the ledger has not been read yet. */
  pending: boolean
  record: TaskRecord | null
}

export type TaskRecordQuery = {
  repoId: string
  itemType: TaskRecordItemType
  number: number
}

/**
 * Read-only view of the task ledger (issue #36). Main writes the record where
 * worktree metadata is written and settles it before a removal; the renderer
 * only asks what survived, so a deleted workspace's history cannot depend on
 * anything the renderer happened to cache.
 *
 * A missing bridge (an older preload) is an empty, already-loaded answer: a
 * permanent "pending" would hide the never-started state forever.
 */
export function useTaskRecords(
  query: TaskRecordQuery | null,
  /** Changes when the workspace list for this repo changes. The record is written
   *  by main at removal time, so without this an open page would keep showing the
   *  pre-removal record until it remounted. */
  revision?: unknown
): TaskRecordLoad {
  const [load, setLoad] = useState<TaskRecordLoad>({ pending: true, record: null })
  const repoId = query?.repoId ?? null
  const itemType = query?.itemType ?? null
  const number = query?.number ?? null

  useEffect(() => {
    const api = window.api?.taskRecords
    if (repoId === null || itemType === null || number === null || !api) {
      setLoad({ pending: false, record: null })
      return
    }
    let cancelled = false
    // Drop the previous task's record immediately: keeping it while the new query
    // is in flight would merge another task's removed workspace for a frame.
    setLoad({ pending: true, record: null })
    void api
      .get({ repoId, itemType, number })
      .then((result) => {
        if (!cancelled) {
          setLoad({ pending: false, record: result.record })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({ pending: false, record: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId, itemType, number, revision])

  return load
}
