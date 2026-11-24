import { useEffect, useState } from 'react'
import {
  TASK_RECORDS_GET_RPC,
  type TaskRecordsRemoteResult
} from '../../../shared/task-records-remote'
import { TASK_RECORDS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { TaskRecordQuery } from './use-task-records'
import type {
  TaskRecordSourceAnswer,
  TaskRecordSourceFailure
} from '@/lib/task-workbench/task-workbench-record-sources'
import { classifyTaskRecordsRemoteFailure } from '@/lib/task-workbench/task-workbench-record-source-failures'

/**
 * Read one task's record from each remote environment this task's workspaces
 * belong to (issue #31).
 *
 * This is the counterpart of `useTaskRecords` (which asks the client's own
 * profile over IPC). Both run: the local profile is the existing path and the
 * fallback content, and each environment is an additional source whose answers
 * the pure merge folds in (`task-workbench-record-sources.ts`).
 *
 * Four decisions that are the whole of this file:
 * - **A host that advertises no `taskRecords.v1` is not called.** The verdict is
 *   the same `unsupported` the `method_not_found` path produces, so an older
 *   runtime costs a status lookup instead of a doomed round trip — and the panel
 *   says the same sentence either way.
 * - **A failure is an `unavailable` answer, never an empty result.** `catch`
 *   classifies (unsupported / forbidden / unreachable) and the caller keeps its
 *   content, so "we could not ask" can never render as "this task never ran".
 * - **`repoKnown: false` is `repo-unknown`, not `record: null`.** The runtime
 *   answered, but it has no such repository registration, which is a scope
 *   answer and not a history fact.
 * - **One read per (query, environment set, revision).** The answers are keyed by
 *   the query string the same way `useTaskRecords` keys its load, so a prop change
 *   cannot hand this task the previous task's remote history for a frame.
 */
export const TASK_RECORDS_REMOTE_TIMEOUT_MS = 15_000

/** Just enough of a runtime-status row to decide whether a host can be asked. A
 *  structural type rather than the store's own row: the view hook passes the
 *  store map unchanged, and a test can pass a two-field object. */
export type TaskRecordsRuntimeStatus = {
  status: { capabilities?: readonly string[] } | null
  /** Printed only when this host turned out to be too old to answer: the version
   *  is what makes "update that environment" actionable. */
  appVersion?: string | null
}

export type TaskRecordsRemoteLoad = {
  /** True until every selected environment answered or failed. The panel must not
   *  print "no history" while a remote answer may still arrive. */
  pending: boolean
  answers: TaskRecordSourceAnswer[]
}

type LoadedAnswers = TaskRecordsRemoteLoad & { key: string | null }

const IDLE: TaskRecordsRemoteLoad = { pending: false, answers: [] }

/** Same key discipline as `useTaskRecords`: `\0` cannot appear in any part, so two
 *  different tasks (or two different environment sets) cannot collapse. */
function remoteQueryKey(query: TaskRecordQuery | null, environmentIds: readonly string[]): string {
  return query === null
    ? '\0none'
    : [
        query.repoId,
        query.itemType,
        String(query.number),
        query.provider ?? '',
        [...environmentIds].sort().join(',')
      ].join('\0')
}

function isRemoteResult(value: unknown): value is TaskRecordsRemoteResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { repoKnown?: unknown; record?: unknown }
  if (typeof candidate.repoKnown !== 'boolean') {
    return false
  }
  // The wire is untrusted even from a host this client trusts: a record without a
  // binding list would crash the merge, so it is not accepted as an answer here.
  if (candidate.record === null) {
    return true
  }
  return (
    typeof candidate.record === 'object' &&
    candidate.record !== null &&
    Array.isArray((candidate.record as { bindings?: unknown }).bindings)
  )
}

function unavailable(
  target: RuntimeClientTarget,
  failure: TaskRecordSourceFailure
): TaskRecordSourceAnswer {
  return { target, kind: 'unavailable', failure }
}

export function useTaskRecordsRemote(args: {
  query: TaskRecordQuery | null
  /** Environments this task's workspaces name, in store order (see
   *  `selectTaskRecordEnvironments`). Empty is the ordinary local-only task. */
  environmentIds: readonly string[]
  /** The status store's per-environment rows, used only to skip a call a host has
   *  already advertised it cannot serve. Read during render into
   *  `capabilityGate`, never inside the effect: an inline `new Map(...)` argument
   *  would otherwise be a fresh dependency every render and the effect would
   *  re-arm itself forever (measured: an infinite render loop, not a warning). */
  statusByEnvironment?: ReadonlyMap<string, TaskRecordsRuntimeStatus>
  /** Changes when something the record depends on changes (the repo's workspace
   *  list), matching `useTaskRecords`. */
  revision?: unknown
}): TaskRecordsRemoteLoad {
  const { query, environmentIds, statusByEnvironment, revision } = args
  const key = remoteQueryKey(query, environmentIds)
  // The set is compared by content through `key`; the joined form is what the
  // effect iterates so an inline array literal cannot re-trigger it.
  const environmentKey = [...environmentIds].sort().join(',')
  // `y` advertised, `n` advertised without the capability, `?` not known yet (the
  // call decides). The rendered decision, not the map, is what the effect depends
  // on, so a caller may pass a fresh Map without looping.
  const capabilityGate = [...environmentIds]
    .sort()
    .map((environmentId) => {
      const advertised = statusByEnvironment?.get(environmentId)?.status?.capabilities
      const verdict =
        advertised === undefined
          ? '?'
          : advertised.includes(TASK_RECORDS_RUNTIME_CAPABILITY)
            ? 'y'
            : 'n'
      return `${environmentId}=${verdict}`
    })
    .join(',')
  const [load, setLoad] = useState<LoadedAnswers>({ key: null, pending: true, answers: [] })
  const repoId = query?.repoId ?? null
  const itemType = query?.itemType ?? null
  const number = query?.number ?? null
  const provider = query?.provider

  useEffect(() => {
    if (repoId === null || itemType === null || number === null || environmentKey === '') {
      setLoad({ key, pending: false, answers: [] })
      return
    }
    const environmentIdsForRead = environmentKey.split(',')
    const gate = new Map(
      capabilityGate
        .split(',')
        .filter((entry) => entry !== '')
        .map((entry) => {
          const separator = entry.lastIndexOf('=')
          return [entry.slice(0, separator), entry.slice(separator + 1)] as const
        })
    )
    let cancelled = false
    setLoad({ key, pending: true, answers: [] })
    const read = async (): Promise<void> => {
      const answers = await Promise.all(
        environmentIdsForRead.map(async (environmentId): Promise<TaskRecordSourceAnswer> => {
          const target: RuntimeClientTarget = { kind: 'environment', environmentId }
          if (gate.get(environmentId) === 'n') {
            return unavailable(target, 'unsupported')
          }
          try {
            const result = await callRuntimeRpc<unknown>(
              target,
              TASK_RECORDS_GET_RPC,
              {
                repoId,
                itemType,
                number,
                ...(provider ? { provider } : {})
              },
              { timeoutMs: TASK_RECORDS_REMOTE_TIMEOUT_MS, reuseRecentCompatibilityFailure: true }
            )
            if (!isRemoteResult(result)) {
              return unavailable(target, 'unreachable')
            }
            if (!result.repoKnown) {
              return unavailable(target, 'repo-unknown')
            }
            return { target, kind: 'answered', record: result.record }
          } catch (error) {
            return unavailable(target, classifyTaskRecordsRemoteFailure(error))
          }
        })
      )
      if (!cancelled) {
        setLoad({ key, pending: false, answers })
      }
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [
    key,
    environmentKey,
    repoId,
    itemType,
    number,
    provider,
    capabilityGate,
    revision
  ])

  if (environmentKey === '') {
    return IDLE
  }
  // Between a prop change and the effect that answers it, `load` still belongs to
  // the previous task. Reporting it as pending is what keeps another task's remote
  // history from printing for a frame.
  if (load.key !== key) {
    return { pending: true, answers: [] }
  }
  return { pending: load.pending, answers: load.answers }
}
