import { useEffect, useState } from 'react'
import type { TaskProvider } from '../../../shared/task-providers'
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
  /** The page's tracker, when it has one. An unqualified query is answered only
   *  when exactly one provider claims the number, so passing this is what makes
   *  the answer exact rather than an ambiguity verdict. */
  provider?: TaskProvider
}

/** The answer plus the query it answers. Kept in state because a prop change
 *  renders before its effect runs: without the key, the first render of a new
 *  task would hand the previous task's record to the caller (issue #38 review
 *  R1) — another task's deleted workspace would name this one for a frame. */
type LoadedTaskRecord = TaskRecordLoad & { key: string | null }

const IDLE: TaskRecordLoad = { pending: false, record: null }

/** One string for the task a ledger query means. `\0` cannot appear in a repo
 *  id, an item type or a provider, so two different tasks cannot collapse into
 *  one key. */
function queryKey(query: TaskRecordQuery | null): string | null {
  return query === null
    ? null
    : `${query.repoId}\0${query.itemType}\0${query.number}\0${query.provider ?? ''}`
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
  const [load, setLoad] = useState<LoadedTaskRecord>({
    key: null,
    pending: true,
    record: null
  })
  const key = queryKey(query)
  const repoId = query?.repoId ?? null
  const itemType = query?.itemType ?? null
  const number = query?.number ?? null
  const provider = query?.provider

  useEffect(() => {
    const api = window.api?.taskRecords
    if (repoId === null || itemType === null || number === null || !api) {
      setLoad({ key, pending: false, record: null })
      return
    }
    let cancelled = false
    // Drop the previous task's record immediately: keeping it while the new query
    // is in flight would merge another task's removed workspace for a frame.
    setLoad({ key, pending: true, record: null })
    void api
      .get({ repoId, itemType, number, ...(provider ? { provider } : {}) })
      .then((result) => {
        if (!cancelled) {
          setLoad({ key, pending: false, record: result.record })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({ key, pending: false, record: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, repoId, itemType, number, provider, revision])

  // The render-time guard the effect cannot provide: between the prop change and
  // the effect, `load` still answers the previous task. Answering with the old
  // record would be exactly the cross-task leak this workbench exists to avoid,
  // so a mismatched answer reads as "still loading" instead.
  if (key === null) {
    return IDLE
  }
  if (load.key !== key) {
    return { pending: true, record: null }
  }
  return { pending: load.pending, record: load.record }
}
