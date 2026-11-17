import type { ActiveTaskDraft } from './task-draft-create-flow'
import { relaunchDraftAgent } from './task-draft-agent-launch'
import { errorText } from './task-draft-create-rpc'
import { getTaskDraftRetryAction, type TaskDraftState } from './task-draft-issue-create'
import type { TaskDraftReceipt } from './task-draft-receipt'

/**
 * One retry control, routed by the state table (README 7.9.7 retry owner).
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
