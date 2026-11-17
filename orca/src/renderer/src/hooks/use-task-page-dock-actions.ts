import { useCallback, useMemo, useRef, useState } from 'react'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type { TaskDockDraftModel, TaskDockModel } from '@/components/task-page/TaskDock'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getTaskDraftName } from '@/lib/task-draft-name'
import type {
  TaskDraftDuplicateCandidate,
  TaskDraftProposal,
  TaskDraftState
} from '@/lib/task-draft-issue-create'
import {
  getDockTargetLabel,
  resolveDraftRequest,
  type ActiveTaskDraft
} from '@/lib/task-draft-create-flow'
import { buildLinkedItem } from '@/lib/task-draft-receipt'
import { deliverToActiveDraft, launchDraftAgent } from '@/lib/task-draft-agent-launch'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useTaskDraftCreateActions } from './use-task-draft-create-actions'
import { useTaskDraftPolling } from './use-task-draft-polling'

export function useTaskPageDockActions(model: TaskPageComposerActionsModel) {
  const {
    taskSource,
    primaryRepo,
    folderWorkspaces,
    newLinearIssueTargetTeam,
    selectedLinearWorkspaceId,
    setNewJiraIssueTitle,
    setNewJiraIssueBody,
    setNewJiraIssueOpen
  } = model
  const [instruction, setInstruction] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [state, setState] = useState<TaskDraftState>('idle')
  const [proposal, setProposal] = useState<TaskDraftProposal | null>(null)
  const [duplicates, setDuplicates] = useState<readonly TaskDraftDuplicateCandidate[]>([])
  const [duplicateCheckUnavailable, setDuplicateCheckUnavailable] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  // Why: one key per draft, kept until the workspace exists so a retry reuses the same scratch directory.
  const draftKeyRef = useRef<string | null>(null)
  const activeDraftRef = useRef<ActiveTaskDraft | null>(null)
  // Why: once the draft is linked the session is over, so the next instruction opens a
  // fresh draft instead of typing into the agent of a completed one.
  const onDraftLinked = useCallback((): void => {
    activeDraftRef.current = null
    draftKeyRef.current = null
  }, [])

  const targetLabel = useMemo(
    () => (primaryRepo ? getDockTargetLabel(primaryRepo, taskSource) : null),
    [primaryRepo, taskSource]
  )

  const submit = useCallback(async (): Promise<void> => {
    const text = instruction.trim()
    if (!text || submitting) {
      return
    }
    setSubmitting(true)
    setErrorMessage(null)
    setProviderError(null)
    let creating = false
    try {
      const active = activeDraftRef.current
      if (active) {
        await deliverToActiveDraft(active, text)
        // Why: a follow-up can revise a pending draft, so the poll must resume.
        if (state === 'preview-ready' || state === 'duplicate-suspected') {
          setState('drafting')
        }
        setInstruction('')
        setExpanded(false)
        return
      }
      const appState = useAppStore.getState()
      const resolved = resolveDraftRequest({
        taskSource,
        primaryRepo,
        projectGroups: appState.projectGroups,
        linearTeam: newLinearIssueTargetTeam,
        linearWorkspaceId: selectedLinearWorkspaceId
      })
      if (!resolved.ok) {
        setState(resolved.state)
        throw new Error(resolved.message)
      }
      const { repo, group, target } = resolved
      setState('creating-draft')
      creating = true
      const draftKey = draftKeyRef.current ?? createBrowserUuid()
      draftKeyRef.current = draftKey
      const folderPath = await window.api.app.getTaskDraftDirectory({ draftKey })
      const name = getTaskDraftName({
        instruction: text,
        provider: taskSource,
        existingNames: folderWorkspaces.map((workspace) => workspace.name)
      }).displayName
      const workspace = await appState.createFolderWorkspace(
        { projectGroupId: group.id, name, folderPath, taskDraft: true },
        // Why: a draft must land on this host even when the focused runtime is an environment.
        { runtimeEnvironmentId: null }
      )
      if (!workspace) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockCreateWorkspaceFailed',
            'Could not create the draft workspace.'
          )
        )
      }
      // Why: remembered before the launch so a failed launch never creates a second draft row.
      const draft: ActiveTaskDraft = {
        folderWorkspaceId: workspace.id,
        folderPath,
        primaryTabId: null,
        draftKey,
        agent: null,
        instruction: text,
        target,
        repoPath: repo.path,
        lastProposalRevision: 0,
        frozenProposal: null,
        receipt: null,
        channel: null
      }
      activeDraftRef.current = draft
      creating = false
      try {
        await launchDraftAgent(draft, group, appState.settings, text)
      } catch (error) {
        setState('agent-launch-failed')
        throw error
      }
      setState('drafting')
      setInstruction('')
      setExpanded(false)
    } catch (error) {
      if (creating) {
        setState('draft-failed')
      }
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [
    instruction,
    submitting,
    primaryRepo,
    taskSource,
    folderWorkspaces,
    state,
    newLinearIssueTargetTeam,
    selectedLinearWorkspaceId
  ])

  const reopenDraft = useCallback(async (active: ActiveTaskDraft): Promise<void> => {
    setErrorMessage(null)
    try {
      await deliverToActiveDraft(active, active.instruction)
      setState('drafting')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const {
    linkTaskItem,
    finishLink,
    createIssue,
    confirmCreate,
    retry,
    reopenAgent,
    chooseGhFallback
  } = useTaskDraftCreateActions({
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
    reopenDraft,
    onDraftLinked
  })

  useTaskDraftPolling({
    state,
    activeDraftRef,
    setProposal,
    setDuplicates,
    setDuplicateCheckUnavailable,
    setState,
    setErrorMessage,
    onFallbackReceipt: finishLink
  })

  const reuseCandidate = useCallback(
    async (candidate: TaskDraftDuplicateCandidate): Promise<void> => {
      if (state !== 'duplicate-suspected') {
        return
      }
      const active = activeDraftRef.current
      if (!active) {
        return
      }
      setErrorMessage(null)
      const linked = await linkTaskItem(active, buildLinkedItem(active.target, candidate))
      if (linked) {
        setState('idle')
        setInstruction('')
        return
      }
      setErrorMessage(
        (current) =>
          current ??
          translate(
            'auto.hooks.useTaskPageDockActions.taskDraftReuseFailed',
            'The existing issue could not be linked to this draft.'
          )
      )
    },
    [state, linkTaskItem]
  )

  const activeDraft = activeDraftRef.current
  const draft: TaskDockDraftModel = {
    state,
    provider: activeDraft?.target.provider ?? null,
    createdIssueNumber: activeDraft?.receipt?.number ?? null,
    proposal,
    duplicates,
    duplicateCheckUnavailable,
    providerError,
    onConfirmCreate: () => {
      void confirmCreate()
    },
    onCancelPreview: () => {
      if (state === 'preview-ready') {
        setState('cancelled')
      }
    },
    onReuseCandidate: (candidate) => {
      void reuseCandidate(candidate)
    },
    onCreateAnyway: () => {
      if (state === 'duplicate-suspected') {
        void createIssue()
      }
    },
    onRetry: () => {
      void retry()
    },
    onReopenAgent: reopenAgent,
    onChooseGhFallback: () => {
      void chooseGhFallback()
    }
  }

  const taskDock: TaskDockModel = {
    instruction,
    expanded,
    targetLabel,
    submitting,
    errorMessage,
    onInstructionChange: setInstruction,
    onExpandedChange: setExpanded,
    onSubmit: () => {
      void submit()
    },
    draft
  }
  return Object.assign(model, { taskDock })
}

export type TaskPageDockActionsModel = ReturnType<typeof useTaskPageDockActions>
