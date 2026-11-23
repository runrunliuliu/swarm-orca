import { existsSync, readFileSync } from 'node:fs'
import {
  isHistoryBackfillCommandError,
  type HistoryBackfillTask
} from '../shared/history-backfill-command'
import { isProfileStateRecoveryCommandError } from '../shared/profile-state-recovery-command'
import { normalizeTaskRecords } from '../shared/task-records-normalize'
import {
  registeredRepos,
  resolveTaskRecordByNumber,
  resolveTaskRecordRepoId
} from '../shared/task-records-lookup'
import { isReadableTaskRecords } from '../shared/task-records-types'
import { getActiveProfileStateLocation } from '../main/persistence/profile-state/profile-state-active-location'
import { openProfileStateDatabaseReadOnly } from '../main/persistence/profile-state/profile-state-database'
import { readProfileStateDomainsWithRevisionFromDatabase } from '../main/persistence/profile-state/profile-state-domain-reader'
import { parseProfileStateRoot } from '../main/persistence/profile-state/profile-state-document-validation'
import { classifyProfileStateStorage } from '../main/persistence/profile-state/profile-state-storage-classification'
import { RuntimeClientError } from './runtime-client'
import { buildHistoryTaskExport, type HistoryTaskExport } from './history-task-export'

const TASK_RECORDS_DOMAIN = 'taskRecords'
const REPOS_DOMAIN = 'repos'
const WORKTREE_META_DOMAIN = 'worktreeMeta'

type DomainValues = {
  taskRecords: unknown
  repos: unknown
  worktreeMeta: unknown
}

/**
 * `orca history task` reads the persisted `taskRecords` domain and nothing else.
 * The database is opened read-only, no revision is claimed and no domain is
 * written; the command also works while Orca is running, because SQLite's read
 * snapshot is the only thing it needs.
 */
export function readHistoryTaskExport(args: {
  userDataPath: string
  task: HistoryBackfillTask
}): HistoryTaskExport {
  try {
    return readHistoryTaskExportUnchecked(args)
  } catch (error) {
    throw asRuntimeClientError(error)
  }
}

function readHistoryTaskExportUnchecked(args: {
  userDataPath: string
  task: HistoryBackfillTask
}): HistoryTaskExport {
  const location = getActiveProfileStateLocation(args.userDataPath)
  if (!location) {
    throw new RuntimeClientError(
      'runtime_error',
      'This machine has no active Orca profile yet. Start Orca once so it writes one, then retry.'
    )
  }
  const values = readDomains(location)
  if (values.worktreeMeta === undefined || values.worktreeMeta === null) {
    throw new RuntimeClientError(
      'runtime_error',
      'The stored profile has task records but no worktree metadata, so archived/deleted cannot be determined. Start Orca once so it writes that domain, then retry.'
    )
  }
  if (!isReadableTaskRecords(values.taskRecords)) {
    throw new RuntimeClientError(
      'runtime_error',
      'The stored task records were written by a newer Orca, so this build cannot read them. Update Orca and retry.'
    )
  }
  const normalization = normalizeTaskRecords(values.taskRecords)
  const repoId = resolveTaskRecordRepoId(registeredRepos(values.repos), args.task.repo)
  const record = resolveTaskRecordByNumber(normalization.state, {
    repoId,
    task: args.task
  })
  return buildHistoryTaskExport({
    record,
    repoId,
    task: args.task,
    existingWorktreeIds: existingWorktreeIdsOf(values.worktreeMeta)
  })
}

function readDomains(location: ReturnType<typeof getActiveProfileStateLocation>): DomainValues {
  if (!location) {
    throw new RuntimeClientError('runtime_error', 'This machine has no active Orca profile.')
  }
  const classification = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (classification === 'neither') {
    throw new RuntimeClientError(
      'runtime_error',
      'This profile has no profile state yet. Start Orca once so it writes one, then retry.'
    )
  }
  if (classification === 'json-only') {
    if (!existsSync(location.dataFile)) {
      return { taskRecords: undefined, repos: undefined, worktreeMeta: undefined }
    }
    const root = parseProfileStateRoot(readFileSync(location.dataFile, 'utf8'))
    return {
      taskRecords: root[TASK_RECORDS_DOMAIN],
      repos: root[REPOS_DOMAIN],
      worktreeMeta: root[WORKTREE_META_DOMAIN]
    }
  }
  const opened = openProfileStateDatabaseReadOnly(location.databaseFile, location.profileId)
  try {
    const domains = readProfileStateDomainsWithRevisionFromDatabase(opened.db, [
      TASK_RECORDS_DOMAIN,
      REPOS_DOMAIN,
      WORKTREE_META_DOMAIN
    ])
    if (domains.kind === 'unreadable') {
      throw new RuntimeClientError(
        'runtime_error',
        `Could not read the task records domain: ${messageOf(domains.error)}. Nothing was written.`
      )
    }
    return {
      taskRecords: domains.values.get(TASK_RECORDS_DOMAIN),
      repos: domains.values.get(REPOS_DOMAIN),
      worktreeMeta: domains.values.get(WORKTREE_META_DOMAIN)
    }
  } finally {
    opened.db.close()
  }
}

/** Both the worktree id and its host-qualified form, because one locator can be
 *  owned by two hosts in one record. A raw id is kept for a legacy meta row that
 *  never wrote `hostId`. */
function existingWorktreeIdsOf(value: unknown): Set<string> {
  const ids = new Set<string>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ids
  }
  for (const [worktreeId, meta] of Object.entries(value as Record<string, unknown>)) {
    ids.add(worktreeId)
    if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
      const hostId = (meta as { hostId?: unknown }).hostId
      if (typeof hostId === 'string' && hostId.length > 0) {
        ids.add(`${worktreeId}\u0000${hostId}`)
      }
    }
  }
  return ids
}

function asRuntimeClientError(error: unknown): Error {
  if (error instanceof RuntimeClientError) {
    return error
  }
  if (isHistoryBackfillCommandError(error) || isProfileStateRecoveryCommandError(error)) {
    return new RuntimeClientError(error.code, error.message)
  }
  return new RuntimeClientError(
    'runtime_error',
    error instanceof Error ? error.message : String(error)
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
