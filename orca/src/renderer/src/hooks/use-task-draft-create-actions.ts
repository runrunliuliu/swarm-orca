import { useCallback, useRef, type RefObject } from 'react'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { toFolderWorkspaceLinkedTask } from '@/components/sidebar/folder-workspace-composer-helpers'
import {
  buildTaskDraftCreateRequest,
  errorText,
  type TaskDraftState
} from '@/lib/task-draft-issue-create'
import { buildLinkedWorkItem, type TaskDraftReceipt } from '@/lib/task-draft-receipt'
import {
  buildLinkedTaskSourceContext,
  resolveGhFallback,
  type ActiveTaskDraft
} from '@/lib/task-draft-create-flow'
import {
  callCreateRpc,
  isProviderRejection,
  outcomeUnknownMessage,
  readCreateReceipt,
  runTaskDraftRetry,
  writeDraftFile
} from '@/lib/task-draft-execute'
import { formatCommandLine } from '@/lib/task-draft-agent-launch'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../shared/repo-types'

const LINEAR_CREATE_TIMEOUT_MS = 75_000
const GITHUB_CREATE_TIMEOUT_MS = 60_000

/**
 * The dock's confirmed-write actions and their per-state retry routing (D0/D2/D8).
 * The confirm handler is the only place that calls the provider.
 */
export function useTaskDraftCreateActions(args: {
  state: TaskDraftState
  activeDraftRef: RefObject<ActiveTaskDraft | null>
  setState: (state: TaskDraftState) => void
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>
  setProviderError: (message: string | null) => void
  setInstruction: (instruction: string) => void
  setNewJiraIssueTitle: (title: string) => void
  setNewJiraIssueBody: (body: string) => void
  setNewJiraIssueOpen: (open: boolean) => void
  primaryRepo: Repo | null
  submit: () => Promise<void>
  reopenDraft: (active: ActiveTaskDraft) => Promise<void>
}) {
  const {
    state,
    activeDraftRef,
    setState,
    setErrorMessage,
    setProviderError,
    setInstruction,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueOpen,
    primaryRepo,
    submit,
    reopenDraft
  } = args

  const creatingRef = useRef(false)

  const linkTaskItem = useCallback(
    async (active: ActiveTaskDraft, item: LinkedWorkItemSummary): Promise<boolean> => {
      const sourceContext = buildLinkedTaskSourceContext(active.target)
      try {
        return await useAppStore.getState().updateFolderWorkspace(active.folderWorkspaceId, {
          linkedTask: toFolderWorkspaceLinkedTask(item),
          ...(sourceContext ? { linkedTaskSourceContext: sourceContext } : {})
        })
      } catch (error) {
        setErrorMessage(errorText(error))
        return false
      }
    },
    [setErrorMessage]
  )

  const finishLink = useCallback(
    async (active: ActiveTaskDraft, receipt: TaskDraftReceipt): Promise<void> => {
      active.receipt = receipt
      const linked = await linkTaskItem(active, buildLinkedWorkItem(active.target, receipt))
      if (linked) {
        setState('idle')
        setInstruction('')
        return
      }
      setState('issue-created-link-failed')
      setErrorMessage(
        (current) =>
          current ??
          translate(
            'auto.hooks.useTaskPageDockActions.taskDraftLinkFailed',
            'The issue was created, but the draft link was not saved.'
          )
      )
    },
    [linkTaskItem, setErrorMessage, setInstruction, setState]
  )

  const createIssue = useCallback(async (): Promise<void> => {
    if (creatingRef.current) {
      return
    }
    const active = activeDraftRef.current
    const frozen = active?.frozenProposal
    if (!active || !frozen) {
      return
    }
    creatingRef.current = true
    setProviderError(null)
    setErrorMessage(null)
    try {
      let request: ReturnType<typeof buildTaskDraftCreateRequest>
      try {
        request = buildTaskDraftCreateRequest({ target: active.target, proposal: frozen })
      } catch (error) {
        setState('provider-rejected')
        setProviderError(errorText(error))
        return
      }
      if (request.kind !== 'rpc') {
        return
      }
      setState('creating-issue')
      const outcome = await callCreateRpc(
        request.method,
        request.params,
        request.provider === 'linear' ? LINEAR_CREATE_TIMEOUT_MS : GITHUB_CREATE_TIMEOUT_MS
      )
      if (outcome.kind === 'rejected') {
        setState('provider-rejected')
        setProviderError(outcome.message)
        return
      }
      if (outcome.kind === 'unknown') {
        setState('issue-created-link-failed')
        setErrorMessage(outcomeUnknownMessage())
        return
      }
      if (isProviderRejection(outcome.result)) {
        setState('provider-rejected')
        setProviderError(
          outcome.result.error ||
            translate(
              'auto.hooks.useTaskPageDockActions.taskDraftProviderRejected',
              'The provider rejected the issue.'
            )
        )
        return
      }
      const receipt = readCreateReceipt(active, outcome.result)
      if (!receipt) {
        setState('issue-created-link-failed')
        setErrorMessage(outcomeUnknownMessage())
        return
      }
      active.channel = 'primary-rpc'
      try {
        await writeDraftFile(
          active.folderPath,
          'task-draft-receipt.json',
          JSON.stringify(receipt, null, 2)
        )
      } catch {
        // Why: an unreadable receipt only narrows recovery to the in-memory retry; the link still runs.
      }
      await finishLink(active, receipt)
    } finally {
      creatingRef.current = false
    }
  }, [activeDraftRef, finishLink, setErrorMessage, setProviderError, setState])

  const confirmCreate = useCallback(async (): Promise<void> => {
    if (state !== 'preview-ready') {
      return
    }
    const active = activeDraftRef.current
    const frozen = active?.frozenProposal
    if (!active || !frozen) {
      return
    }
    if (active.target.provider === 'jira') {
      setNewJiraIssueTitle(frozen.title)
      setNewJiraIssueBody(frozen.body)
      setNewJiraIssueOpen(true)
      return
    }
    await createIssue()
  }, [
    state,
    activeDraftRef,
    createIssue,
    setNewJiraIssueBody,
    setNewJiraIssueOpen,
    setNewJiraIssueTitle
  ])

  const retry = useCallback(async (): Promise<void> => {
    await runTaskDraftRetry({
      state,
      active: activeDraftRef.current,
      submit,
      reopenDraft,
      finishLink,
      createIssue,
      setState,
      setErrorMessage
    })
  }, [
    state,
    activeDraftRef,
    submit,
    reopenDraft,
    finishLink,
    createIssue,
    setErrorMessage,
    setState
  ])

  const chooseGhFallback = useCallback(async (): Promise<void> => {
    if (state !== 'preview-ready') {
      return
    }
    const active = activeDraftRef.current
    const frozen = active?.frozenProposal
    if (!active || !frozen || active.target.provider !== 'github') {
      return
    }
    const resolved = await resolveGhFallback({ active, primaryRepo, frozen })
    if (!resolved.ok) {
      setState('remote-unsupported')
      setErrorMessage(resolved.message)
      return
    }
    if (!active.primaryTabId || !active.agent) {
      setErrorMessage(
        translate(
          'auto.components.TaskPage.taskDockNoSession',
          'This draft has no agent session. Open it from the sidebar and start an agent, then send again.'
        )
      )
      return
    }
    const delivered = await deliverLaunchPromptToAgentTab({
      tabId: active.primaryTabId,
      agent: active.agent,
      content: formatCommandLine(resolved.invocation.command, resolved.invocation.args),
      submit: true,
      forcePaste: true
    }).catch(() => false)
    if (!delivered) {
      setErrorMessage(
        translate(
          'auto.components.TaskPage.taskDockInstructionNotDelivered',
          'The draft session did not accept the instruction.'
        )
      )
      return
    }
    active.channel = 'gh-fallback'
    setState('creating-issue')
  }, [state, activeDraftRef, primaryRepo, setErrorMessage, setState])

  return {
    linkTaskItem,
    finishLink,
    createIssue,
    confirmCreate,
    retry,
    chooseGhFallback,
    reopenAgent: (): void => {
      const active = activeDraftRef.current
      if (active) {
        void reopenDraft(active)
      }
    }
  }
}
