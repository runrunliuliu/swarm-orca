import type {
  AgentStatusIpcPayload,
  TraeIdleRevalidation
} from '../../shared/agent-status-ipc-payload'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { createHash } from 'node:crypto'
import { z } from 'zod'

export type TraeIdleRevalidationRequest = {
  expected: AgentStatusIpcPayload
  proof: TraeIdleRevalidation
}

export function matchesTraeIdleRevalidation(
  row: AgentHookEventPayload | undefined,
  request: TraeIdleRevalidationRequest
): row is EnrichedAgentHookEventPayload {
  if (!row) {
    return false
  }
  const parsed = enrichedFields.safeParse(row)
  if (!parsed.success) {
    return false
  }
  const fields = parsed.data
  const { expected, proof } = request
  return (
    row.source === 'trae' &&
    row.hookEventName === 'Stop' &&
    row.payload.agentType === 'trae' &&
    row.payload.state === 'done' &&
    expected.agentType === 'trae' &&
    expected.state === 'done' &&
    !fields.restoredUnconfirmed &&
    !row.providerSessionOnly &&
    !row.isReplay &&
    !row.toolAgentId &&
    !expected.restoredUnconfirmed &&
    !expected.providerSessionOnly &&
    row.connectionId === null &&
    expected.connectionId === null &&
    launchIdentityMatches(row, expected) &&
    row.paneKey === expected.paneKey &&
    fields.receivedAt === expected.receivedAt &&
    row.tabId === expected.tabId &&
    row.worktreeId === expected.worktreeId &&
    fields.stateStartedAt === expected.stateStartedAt &&
    fields.evidenceObservedAt === expected.evidenceObservedAt &&
    observationMatches(fields, expected) &&
    row.providerSession?.key === 'session_id' &&
    expected.providerSession?.key === 'session_id' &&
    row.providerSession.id === expected.providerSession?.id &&
    !!row.providerSession.transcriptPath &&
    row.providerSession.transcriptPath === expected.providerSession?.transcriptPath &&
    proof.hookObservedAt ===
      (fields.traeIdleRevalidation?.hookObservedAt ??
        fields.evidenceObservedAt ??
        fields.receivedAt) &&
    Number.isSafeInteger(proof.inputSequence) &&
    proof.inputSequence >= 0 &&
    proof.processIncarnation.length > 0
  )
}

const launchTokenHashRe = /^[a-f0-9]{64}$/

function hashLaunchToken(token: string | undefined): string | null {
  const trimmed = token?.trim()
  return trimmed ? createHash('sha256').update(trimmed).digest('hex') : null
}

function readLaunchTokenHash(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const hash = Reflect.get(value, 'launchTokenHash')
  if (typeof hash !== 'string') {
    return null
  }
  const trimmed = hash.trim()
  return launchTokenHashRe.test(trimmed) ? trimmed : null
}

function launchIdentityMatches(
  row: AgentHookEventPayload,
  expected: AgentStatusIpcPayload
): boolean {
  if (row.launchToken && expected.launchToken) {
    return row.launchToken === expected.launchToken
  }
  const rowHash = hashLaunchToken(row.launchToken) ?? readLaunchTokenHash(row)
  const expectedHash = hashLaunchToken(expected.launchToken) ?? readLaunchTokenHash(expected)
  return !!rowHash && !!expectedHash && rowHash === expectedHash
}

function observationMatches(
  fields: z.infer<typeof enrichedFields>,
  expected: AgentStatusIpcPayload
): boolean {
  if (fields.observation) {
    return (
      fields.observation.revision === expected.observation?.revision &&
      fields.observation.authorityId === expected.observation?.authorityId
    )
  }
  return expected.observation?.revision === undefined && expected.observation?.authorityId === undefined
}

const enrichedFields = z.object({
  receivedAt: z.number(),
  evidenceObservedAt: z.number().optional(),
  stateStartedAt: z.number(),
  observation: z.object({ revision: z.number(), authorityId: z.string() }).optional(),
  restoredUnconfirmed: z.boolean().optional(),
  traeIdleRevalidation: z.object({ hookObservedAt: z.number() }).optional()
})
