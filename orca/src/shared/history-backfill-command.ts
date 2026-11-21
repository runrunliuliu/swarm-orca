import { z } from 'zod'
import type { TaskRecordsDiscardedFacts } from './task-records-types'

/**
 * The one-shot history backfill (issue #53 B) as a contract between three
 * processes:
 *
 * - the CLI (`orca history backfill --task <repo>#<number>`) parses the argument,
 * - a headless preflight launch of the Orca executable does the work, because only
 *   the main-process graph contains the agent session index; the CLI graph must not
 *   (see `config/tsconfig.cli.json`: it lists the main files the CLI compiles, and
 *   the AI-Vault scanner is not one of them),
 * - the same preflight process holds the profile-state maintenance lock, so no
 *   running app can overwrite the write.
 *
 * It mirrors `profile-state-recovery-command.ts` on purpose: one flag, one strict
 * request, one prefixed result line on stdout, one exit code, and a typed error the
 * other side can print as the CLI's normal error shape. No new wire contract and no
 * RPC method: the request only names what to backfill.
 */

export const HISTORY_BACKFILL_FLAG = '--history-backfill'
export const HISTORY_BACKFILL_RESULT_PREFIX = '[history-backfill] '

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** `<repo>` names a registered repo. `id` and `path` are the explicit forms
 *  (`id:<repoId>` / `path:<checkout>`); `auto` is the bare form, matched as an id
 *  first and as a path second, so `repo-1#53` and `/repos/app#53` both work. */
export const historyBackfillRepoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('path'), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('auto'), value: z.string().min(1) }).strict()
])

/** `itemType` is a narrowing hint, not a requirement: on one tracker an issue and a
 *  pull request cannot share a number, so the number usually resolves to one record
 *  by itself. When a repo has two trackers claiming one number, the resolver refuses
 *  with the count instead of picking one. */
export const historyBackfillRequestSchema = z
  .object({
    userDataPath: z.string().min(1),
    task: z
      .object({
        repo: historyBackfillRepoSchema,
        number: positiveInteger,
        itemType: z.enum(['issue', 'pr']).optional()
      })
      .strict()
  })
  .strict()

/** One examined binding. `detail` is the stored gap text, so the report and the
 *  record cannot describe the same absence differently. */
export const historyBackfillBindingSchema = z
  .object({
    worktreeId: z.string(),
    hostId: z.string(),
    path: z.string(),
    outcome: z.enum([
      'resolved',
      'session_unattributable',
      'ambiguous_match',
      'other_host',
      'refused'
    ]),
    /** Rows this run actually added: 0 when the observation changed nothing. */
    sessionRows: nonNegativeInteger,
    runRows: nonNegativeInteger,
    candidateCount: nonNegativeInteger.optional(),
    detail: z.string().optional(),
    /** Why a write was refused. `missing_binding` is the shared writer's
     *  "the binding I was addressing is gone" signal, which a backfill must report
     *  as a refusal rather than as a completed run with zero rows.
     *
     *  `settlement_downgrade` is the **shared writer's** re-archive arm
     *  (`setTaskRecordBindingSettlement` refusing to replace a measured settlement
     *  with `unavailable`), not a backfill outcome: this command writes no
     *  settlement at all. It stays in the vocabulary because this report carries the
     *  writer's `skipped` union verbatim rather than re-spelling it and risking the
     *  two drifting apart; a backfill never produces the value. */
    refusedReason: z
      .enum(['limit', 'external_index_conflict', 'missing_binding', 'settlement_downgrade'])
      .optional()
  })
  .strict()

/** The load boundary's own counters (`TaskRecordsDiscardedFacts`), pinned here so a
 *  field added there cannot silently stop being reported: this is the only consumer,
 *  and a run that shortened a record without saying so is the defect it exists for. */
const discardedFactsSchema = z
  .object({
    sessions: nonNegativeInteger,
    runs: nonNegativeInteger,
    gaps: nonNegativeInteger,
    providers: nonNegativeInteger,
    fields: nonNegativeInteger,
    transcriptChecks: nonNegativeInteger
  })
  .strict() satisfies z.ZodType<TaskRecordsDiscardedFacts>

/**
 * What the operator needs to judge the run — and deliberately no token figure: the
 * four usage stores belong to the running app, so this command cannot measure one.
 * An absent usage figure is stated as unknown with a reason by the reader, never `0`.
 */
export const historyBackfillResultSchema = z
  .object({
    taskId: z.string(),
    repoId: z.string(),
    number: positiveInteger,
    provider: z.string(),
    itemType: z.string(),
    /** Every binding of the task, selected or not. */
    bindings: nonNegativeInteger,
    examined: nonNegativeInteger,
    resolved: nonNegativeInteger,
    rowsWritten: z.object({ sessions: nonNegativeInteger, runs: nonNegativeInteger }).strict(),
    changed: z.boolean(),
    /** Revision the domain was written at; null when nothing changed (a second
     *  identical run writes nothing at all). */
    revision: nonNegativeInteger.nullable(),
    /** Rows and fields the load boundary refused to keep **while reading the stored
     *  domain** — the whole domain, not only this task's record, because
     *  normalization is domain-wide. Reported so a run can never shorten a record
     *  silently; see `writeRefusedReason` for the arm that also blocks the write. */
    discarded: discardedFactsSchema,
    /** Why this command wrote nothing although the stored domain was writable.
     *  `null` means the normal rules applied and `changed`/`revision` answer it.
     *  `load_discarded_runs` means the stored domain holds more valid run rows than a
     *  write may store (over `TASK_RECORDS_MAX_RUNS_PER_BINDING`, or unreadable run
     *  rows this build dropped), so writing the normalized domain back would persist
     *  a trim: the run reports the discarded count, examines nothing and leaves the
     *  stored payload exactly as it found it. The exit code stays 0 and this field —
     *  not prose — is the machine-readable outcome. */
    writeRefusedReason: z.enum(['load_discarded_runs']).nullable(),
    outcomes: z.array(historyBackfillBindingSchema).readonly()
  })
  .strict()

export const historyBackfillResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: historyBackfillResultSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid_argument', 'runtime_error']),
    message: z.string()
  })
])

export type HistoryBackfillRepoSelector = z.infer<typeof historyBackfillRepoSchema>
export type HistoryBackfillTask = z.infer<typeof historyBackfillRequestSchema>['task']
export type HistoryBackfillRequest = z.infer<typeof historyBackfillRequestSchema>
export type HistoryBackfillBinding = z.infer<typeof historyBackfillBindingSchema>
export type HistoryBackfillResult = z.infer<typeof historyBackfillResultSchema>
export type HistoryBackfillResponse = z.infer<typeof historyBackfillResponseSchema>

export class HistoryBackfillCommandError extends Error {
  constructor(
    readonly code: 'invalid_argument' | 'runtime_error',
    message: string
  ) {
    super(message)
    this.name = 'HistoryBackfillCommandError'
  }
}

export function isHistoryBackfillCommandError(
  error: unknown
): error is Error & { code: 'invalid_argument' | 'runtime_error' } {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'invalid_argument' || error.code === 'runtime_error')
  )
}

/**
 * Strict `--task` parsing: `<repo>#<number>`, where the number is taken from the
 * **last** `#` so a checkout path that contains one still names its number. Nothing
 * here guesses: a malformed value is an error the CLI prints, never a no-op.
 */
export function parseHistoryBackfillTaskArgument(raw: string): HistoryBackfillTask {
  const separator = raw.lastIndexOf('#')
  const repo = separator === -1 ? '' : raw.slice(0, separator).trim()
  const numberText = separator === -1 ? '' : raw.slice(separator + 1).trim()
  if (repo.length === 0 || !/^[1-9][0-9]*$/.test(numberText)) {
    throw new HistoryBackfillCommandError(
      'invalid_argument',
      `--task expects <repo>#<number>, where <repo> is a registered repo id or its checkout path, and <number> is the tracker number (got "${raw}").`
    )
  }
  const number = Number(numberText)
  if (!Number.isSafeInteger(number)) {
    throw new HistoryBackfillCommandError(
      'invalid_argument',
      `--task number is out of range: ${numberText}`
    )
  }
  return { repo: historyBackfillRepoSelector(repo), number }
}

/** The selector the CLI derives from the textual form; the main side re-resolves it
 *  against the persisted repo list (and re-validates it), so the two sides cannot
 *  disagree about which repo a value names. */
export function historyBackfillRepoSelector(value: string): HistoryBackfillRepoSelector {
  if (value.startsWith('id:')) {
    return { kind: 'id', value: value.slice('id:'.length) }
  }
  if (value.startsWith('path:')) {
    return { kind: 'path', value: value.slice('path:'.length) }
  }
  return { kind: 'auto', value }
}
