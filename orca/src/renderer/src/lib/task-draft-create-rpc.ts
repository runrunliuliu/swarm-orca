/**
 * The confirmed-create transport and the draft's two durable files: the
 * provider call outcome, the receipt written before the link, and the
 * proposal/receipt readers the dock polls.
 */
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { parseTaskDraftReceipt, type TaskDraftReceipt } from '@/lib/task-draft-receipt'
import type { ActiveTaskDraft } from '@/lib/task-draft-create-flow'

export type CreateCallOutcome =
  | { kind: 'ok'; result: unknown }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string }

export async function callCreateRpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<CreateCallOutcome> {
  try {
    const response = await withTimeout(window.api.runtime.call({ method, params }), timeoutMs)
    if (!response.ok) {
      return { kind: 'rejected', message: response.error.message }
    }
    return { kind: 'ok', result: response.result }
  } catch (error) {
    // Why: a transport failure or timeout cannot prove the provider wrote nothing (D2).
    return { kind: 'unknown', message: errorText(error) }
  }
}

/** The receipt a successful provider result implies; `null` means the outcome is unreadable. */
export function readCreateReceipt(
  active: ActiveTaskDraft,
  result: unknown
): TaskDraftReceipt | null {
  const frozenTitle = active.frozenProposal?.title ?? ''
  if (active.target.provider === 'github') {
    if (!isRecord(result) || result.ok !== true) {
      return null
    }
    return parseTaskDraftReceipt(
      {
        version: 1,
        channel: 'primary-rpc',
        provider: 'github',
        number: result.number,
        url: result.url,
        title: frozenTitle,
        draftKey: active.draftKey
      },
      { draftKey: active.draftKey, provider: 'github' }
    )
  }
  if (!isRecord(result) || !isRecord(result.issue)) {
    return null
  }
  const issue = result.issue
  const identifier = typeof issue.identifier === 'string' ? issue.identifier : ''
  return parseTaskDraftReceipt(
    {
      version: 1,
      channel: 'primary-rpc',
      provider: 'linear',
      number: trailingNumber(identifier),
      url: issue.url,
      title: typeof issue.title === 'string' && issue.title.trim() ? issue.title : frozenTitle,
      identifier,
      draftKey: active.draftKey
    },
    { draftKey: active.draftKey, provider: 'linear' }
  )
}

export async function readDraftReceipt(active: ActiveTaskDraft): Promise<TaskDraftReceipt | null> {
  const content = await readDraftFile(active.folderPath, 'task-draft-receipt.json')
  if (content === null) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  return parseTaskDraftReceipt(raw, {
    draftKey: active.draftKey,
    provider: active.target.provider
  })
}

export async function readDraftFile(folderPath: string, name: string): Promise<string | null> {
  try {
    const file = await window.api.fs.readFile({ filePath: joinPath(folderPath, name) })
    return file.content
  } catch {
    // Why: the agent has not written it yet, or the file is mid-rename; the poll retries.
    return null
  }
}

export async function writeDraftFile(
  folderPath: string,
  name: string,
  content: string
): Promise<void> {
  await window.api.fs.writeFile({ filePath: joinPath(folderPath, name), content })
}

export function trailingNumber(identifier: string): number | null {
  const match = /(\d+)\s*$/.exec(identifier)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function outcomeUnknownMessage(): string {
  return translate(
    'auto.hooks.useTaskPageDockActions.taskDraftOutcomeUnknown',
    'Outcome unknown — do not retry. The provider may have created the issue.'
  )
}

export function isProviderRejection(result: unknown): result is { ok: false; error?: string } {
  return typeof result === 'object' && result !== null && 'ok' in result && result.ok === false
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The request timed out.')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
