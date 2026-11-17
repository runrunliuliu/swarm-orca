import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type {
  TaskDockModel,
  TaskDockModelOption,
  TaskDockTranscriptLine,
  TaskDockTranscriptStatus
} from '@/components/task-page/TaskDock'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getTaskDraftName } from '@/lib/task-draft-name'
import { deliverToActiveDraft, launchDraftAgent } from '@/lib/task-draft-agent-launch'
import { readTaskDockTranscript } from '@/lib/task-dock-transcript'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { TuiAgent } from '../../../shared/tui-agent'

/** How often the dock re-reads the agent terminal while it is open. */
const TRANSCRIPT_POLL_MS = 1200
/** Lines kept in the panel; the host truncates further and the panel scrolls. */
const TRANSCRIPT_LINE_LIMIT = 40

/** The draft this dock submit created; a follow-up goes to the same agent session. */
export type ActiveTaskDraft = {
  folderWorkspaceId: string
  folderPath: string
  draftKey: string
  primaryTabId: string | null
  agent: TuiAgent | null
}

/** What the page passes on: the model it received plus the dock's own view model. */
export type TaskPageDockActionsModel = TaskPageComposerActionsModel & { taskDock: TaskDockModel }

/**
 * The Tasks list page's agent entry: one instruction becomes a draft workspace with an agent
 * session, and later instructions go to that same session (design §7.9.5, minus the app-side
 * ticket creation — the agent owns that with its skills).
 */
export function useTaskPageDockActions(model: TaskPageComposerActionsModel): TaskPageDockActionsModel {
  const { taskSource, primaryRepo, folderWorkspaces } = model
  const [instruction, setInstruction] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [modelId, setModelId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<readonly TaskDockTranscriptLine[]>([])
  const [transcriptStatus, setTranscriptStatus] = useState<TaskDockTranscriptStatus>('none')
  // Why state and not the ref: the dock only knows a session exists once a send succeeded, and the
  // panel's status must re-render at that point.
  const [hasSession, setHasSession] = useState(false)
  // Why: one key per draft, kept until the workspace exists so a retry reuses the same scratch directory.
  const draftKeyRef = useRef<string | null>(null)
  const activeDraftRef = useRef<ActiveTaskDraft | null>(null)

  const targetLabel = useMemo(
    () => primaryRepo ? getTargetLabel(primaryRepo, taskSource) : null,
    [primaryRepo, taskSource]
  )
  const modelOptions = useMemo<TaskDockModelOption[]>(
    () => resolveModelOptions(),
    []
  )

  const submit = useCallback(async (): Promise<void> => {
    const text = instruction.trim()
    if (!text || submitting) {
      return
    }
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const active = activeDraftRef.current
      if (active) {
        await deliverToActiveDraft(active, text)
        setHasSession(true)
        setInstruction('')
        setExpanded(false)
        return
      }
      const appState = useAppStore.getState()
      const repo = primaryRepo
      if (!repo) {
        throw new Error(
          translate('auto.components.TaskPage.taskDockPickTarget', 'Pick a source and a repository first.')
        )
      }
      const group = appState.projectGroups.find((candidate) => candidate.id === repo.projectGroupId)
      if (!group) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockNoProjectGroup',
            'Pick a repository that belongs to a project group.'
          )
        )
      }
      // Why: the scratch directory is app-owned and local; a remote group has no path this host can create.
      if (group.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        throw new Error(
          translate('auto.components.TaskPage.taskDockLocalRepoRequired', 'Drafts need a local repository.')
        )
      }
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
        draftKey,
        primaryTabId: null,
        agent: null
      }
      activeDraftRef.current = draft
      await launchDraftAgent({
        draft,
        group,
        settings: appState.settings ?? null,
        instruction: text,
        model: modelId,
        targetLabel
      })
      setHasSession(true)
      setInstruction('')
      setExpanded(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [instruction, submitting, primaryRepo, taskSource, folderWorkspaces, modelId, targetLabel])

  // Why poll instead of subscribe: the draft's agent terminal is not necessarily on screen, so the
  // renderer has no terminal stream for it; the runtime can still answer a read. Only while the
  // dock is open and a session exists, so a closed dock costs nothing.
  useEffect(() => {
    if (!expanded || !hasSession) {
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      const draft = activeDraftRef.current
      if (!draft) {
        return
      }
      const read = await readTaskDockTranscript({
        settings: useAppStore.getState().settings,
        folderWorkspaceId: draft.folderWorkspaceId,
        primaryTabId: draft.primaryTabId,
        limit: TRANSCRIPT_LINE_LIMIT
      })
      if (cancelled || !read) {
        return
      }
      setTranscript(read.lines.map((text) => ({ text })))
      setTranscriptStatus(read.ended ? 'ended' : 'live')
    }
    void tick()
    const timer = setInterval(() => void tick(), TRANSCRIPT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [expanded, hasSession])

  const taskDock: TaskDockModel = {
    instruction,
    expanded,
    targetLabel,
    model: modelId,
    modelOptions,
    transcript,
    transcriptStatus,
    submitting,
    errorMessage,
    onInstructionChange: setInstruction,
    onModelChange: setModelId,
    onExpandedChange: setExpanded,
    onSubmit: () => {
      void submit()
    }
  }

  return { ...model, taskDock }
}

/**
 * The model list the dock can offer. Only agents with a session-option catalog (claude, codex)
 * publish one; for the others the dock falls back to a free-text model id, because the agent's
 * TUI owns its model list and Orca does not mirror it.
 */
function resolveModelOptions(): TaskDockModelOption[] {
  const state = useAppStore.getState()
  const agent = state.settings?.defaultTuiAgent
  if (!agent) {
    return []
  }
  const catalog = getAgentSessionOptionCatalog(agent as Parameters<typeof getAgentSessionOptionCatalog>[0])
  return (
    catalog?.models.map((entry) => ({
      id: entry.id,
      label: 'label' in entry && typeof entry.label === 'string' ? entry.label : entry.id
    })) ?? []
  )
}

function getTargetLabel(repo: Repo, taskSource: TaskPageComposerActionsModel['taskSource']): string {
  const owner = repo.upstream?.owner
  const name = repo.upstream?.repo
  return owner && name ? `${taskSource} · ${owner}/${name}` : repo.displayName
}
