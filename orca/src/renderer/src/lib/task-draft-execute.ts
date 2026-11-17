/**
 * Everything the dock executes after a confirmation: the one provider call, the
 * draft's durable files, and the one retry router the state table names.
 */
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { isRecord } from '../../../shared/unknown-record'
import { parseTaskDraftReceipt, type TaskDraftReceipt } from '@/lib/task-draft-receipt'
import type { ActiveTaskDraft } from '@/lib/task-draft-create-flow'
import { relaunchDraftAgent } from '@/lib/task-draft-agent-launch'
import {
  errorText,
  getTaskDraftRetryAction,
  trailingNumber,
  type TaskDraftState
} from '@/lib/task-draft-issue-create'

export type CreateCallOutcome =
  | { kind: 'ok'; result: unknown }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string; code: string | null }

/** The backend names an unconfirmed write explicitly; the write may already have landed. */
const UNCONFIRMED_WRITE_CODE = /_write_unconfirmed$/

export async function callCreateRpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<CreateCallOutcome> {
  try {
    const response = await withTimeout(window.api.runtime.call({ method, params }), timeoutMs)
    if (!response.ok) {
      // Why: retrying an unconfirmed write as a fresh create duplicates the issue. Every other
      // failure is a rejection the user may re-confirm.
      if (UNCONFIRMED_WRITE_CODE.test(response.error.code)) {
        return { kind: 'unknown', message: response.error.message, code: response.error.code }
      }
      return { kind: 'rejected', message: response.error.message }
    }
    return { kind: 'ok', result: response.result }
  } catch (error) {
    // Why: a transport failure or timeout cannot prove the provider wrote nothing (D2).
    return { kind: 'unknown', message: errorText(error), code: null }
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

export function outcomeUnknownMessage(): string {
  return translate(
    'auto.hooks.useTaskPageDockActions.taskDraftOutcomeUnknown',
    'Outcome unknown — do not retry. The provider may have created the issue.'
  )
}

export function isProviderRejection(result: unknown): result is { ok: false; error?: string } {
  return typeof result === 'object' && result !== null && 'ok' in result && result.ok === false
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

/**
 * One retry control, routed by the state table (README §7.9.7 retry owner).
 * `link-only` retries the write-back and never re-creates; `create` is the
 * provider-rejected path the user re-confirms; unknown states do nothing.
 */
export async function runTaskDraftRetry(args: {
  state: TaskDraftState
  active: ActiveTaskDraft | null
  submit: () => Promise<void>
  reopenDraft: (active: ActiveTaskDraft) => Promise<void>
  finishLink: (active: ActiveTaskDraft, receipt: TaskDraftReceipt) => Promise<void>
  createIssue: () => Promise<void>
  setState: (state: TaskDraftState) => void
  setErrorMessage: (message: string | null) => void
}): Promise<void> {
  const action = getTaskDraftRetryAction(args.state)
  if (action === 'none') {
    return
  }
  if (action === 'resubmit') {
    await args.submit()
    return
  }
  const active = args.active
  if (!active) {
    return
  }
  if (action === 'relaunch-agent') {
    args.setErrorMessage(null)
    try {
      await relaunchDraftAgent(active)
      args.setState('drafting')
    } catch (error) {
      args.setState('agent-launch-failed')
      args.setErrorMessage(errorText(error))
    }
    return
  }
  if (action === 'reopen') {
    if (active.frozenProposal) {
      args.setState('preview-ready')
      return
    }
    await args.reopenDraft(active)
    return
  }
  if (action === 'link-only') {
    if (active.receipt) {
      await args.finishLink(active, active.receipt)
    }
    return
  }
  await args.createIssue()
}
