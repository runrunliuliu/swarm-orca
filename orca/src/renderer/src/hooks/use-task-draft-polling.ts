import { useEffect, type RefObject } from 'react'
import type {
  TaskDraftDuplicateCandidate,
  TaskDraftProposal,
  TaskDraftState
} from '@/lib/task-draft-issue-create'
import {
  parseTaskDraftProposalEnvelope,
  type TaskDraftReceipt
} from '@/lib/task-draft-receipt'
import { findDuplicates, type ActiveTaskDraft } from '@/lib/task-draft-create-flow'
import {
  outcomeUnknownMessage,
  readDraftFile,
  readDraftReceipt
} from '@/lib/task-draft-create-rpc'
import { translate } from '@/i18n/i18n'

const PROPOSAL_POLL_MS = 1_500
const PROPOSAL_DEADLINE_MS = 5 * 60 * 1_000
const RECEIPT_POLL_MS = 1_500
const GH_RECEIPT_TIMEOUT_MS = 60 * 1_000

type ProposalRead =
  | { kind: 'wait' }
  | { kind: 'crash'; message: string }
  | { kind: 'ok'; proposal: TaskDraftProposal; revision: number }

async function readProposal(active: ActiveTaskDraft): Promise<ProposalRead> {
  const content = await readDraftFile(active.folderPath, 'task-draft-proposal.json')
  if (content === null) {
    return { kind: 'wait' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    // Why: a half-written JSON file is normal mid-write; the next poll reads it whole.
    return { kind: 'wait' }
  }
  const parsed = parseTaskDraftProposalEnvelope(raw, {
    draftKey: active.draftKey,
    provider: active.target.provider,
    repoId: active.target.repoId ?? null
  })
  if (parsed.ok) {
    return { kind: 'ok', proposal: parsed.proposal, revision: parsed.revision }
  }
  if (parsed.reason === 'partial') {
    return { kind: 'wait' }
  }
  return {
    kind: 'crash',
    message: translate(
      'auto.hooks.useTaskPageDockActions.taskDraftProposalRejected',
      'The agent wrote a proposal this draft cannot accept ({{value0}}).',
      { value0: parsed.reason }
    )
  }
}

/**
 * The dock's two bounded polls: the agent's proposal while `drafting`, and the
 * agent-written receipt while a `gh` fallback is `creating-issue`. Both stop on
 * every state exit and on unmount, and neither polls outside its state.
 */
export function useTaskDraftPolling(args: {
  state: TaskDraftState
  activeDraftRef: RefObject<ActiveTaskDraft | null>
  setProposal: (proposal: TaskDraftProposal) => void
  setDuplicates: (duplicates: readonly TaskDraftDuplicateCandidate[]) => void
  setDuplicateCheckUnavailable: (unavailable: boolean) => void
  setState: (state: TaskDraftState) => void
  setErrorMessage: (message: string | null) => void
  onFallbackReceipt: (active: ActiveTaskDraft, receipt: TaskDraftReceipt) => Promise<void>
}): void {
  const {
    state,
    activeDraftRef,
    setProposal,
    setDuplicates,
    setDuplicateCheckUnavailable,
    setState,
    setErrorMessage,
    onFallbackReceipt
  } = args

  useEffect(() => {
    if (state !== 'drafting') {
      return
    }
    const active = activeDraftRef.current
    if (!active) {
      return
    }
    let cancelled = false
    let checkingRevision = 0
    const deadline = Date.now() + PROPOSAL_DEADLINE_MS

    const tick = async (): Promise<void> => {
      if (cancelled) {
        return
      }
      const read = await readProposal(active)
      if (cancelled) {
        return
      }
      if (read.kind === 'crash') {
        setState('agent-crashed')
        setErrorMessage(read.message)
        return
      }
      if (read.kind === 'ok' && read.revision > active.lastProposalRevision) {
        active.lastProposalRevision = read.revision
        active.frozenProposal = read.proposal
        setProposal(read.proposal)
      }
      if (!active.frozenProposal) {
        if (Date.now() >= deadline) {
          setState('agent-crashed')
          setErrorMessage(
            translate(
              'auto.hooks.useTaskPageDockActions.taskDraftNoProposal',
              'The agent did not write a draft in time.'
            )
          )
        }
        return
      }
      if (checkingRevision === active.lastProposalRevision) {
        return
      }
      const revision = active.lastProposalRevision
      checkingRevision = revision
      let found: TaskDraftDuplicateCandidate[]
      try {
        found = await findDuplicates(active, active.frozenProposal.title)
      } catch {
        if (cancelled || active.lastProposalRevision !== revision) {
          return
        }
        setDuplicates([])
        setDuplicateCheckUnavailable(true)
        setState('preview-ready')
        return
      }
      if (cancelled || active.lastProposalRevision !== revision) {
        return
      }
      setDuplicates(found)
      setDuplicateCheckUnavailable(false)
      setState(found.length > 0 ? 'duplicate-suspected' : 'preview-ready')
    }

    const interval = setInterval(() => {
      void tick()
    }, PROPOSAL_POLL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [state, activeDraftRef, setProposal, setDuplicates, setDuplicateCheckUnavailable, setState, setErrorMessage])

  useEffect(() => {
    if (state !== 'creating-issue') {
      return
    }
    const active = activeDraftRef.current
    if (!active || active.channel !== 'gh-fallback') {
      return
    }
    let cancelled = false
    const deadline = Date.now() + GH_RECEIPT_TIMEOUT_MS
    const tick = async (): Promise<void> => {
      if (cancelled) {
        return
      }
      const receipt = await readDraftReceipt(active)
      if (cancelled) {
        return
      }
      if (receipt) {
        if (receipt.channel !== 'gh-fallback') {
          return
        }
        cancelled = true
        clearInterval(interval)
        await onFallbackReceipt(active, receipt)
        return
      }
      if (Date.now() >= deadline) {
        cancelled = true
        clearInterval(interval)
        setState('issue-created-link-failed')
        setErrorMessage(outcomeUnknownMessage())
      }
    }
    const interval = setInterval(() => {
      void tick()
    }, RECEIPT_POLL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [state, activeDraftRef, setState, setErrorMessage, onFallbackReceipt])
}
