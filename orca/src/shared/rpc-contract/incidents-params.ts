// Wire params for the incident read RPC (A-fix, 2026-11-16).
//
// Why these exist separately from the IPC shapes: the desktop panel reaches a *paired* runtime over
// runtime RPC, so the params must be validated at the host boundary like every other method. The
// shapes stay close to `incident-api-types.ts` on purpose — one vocabulary, two transports.

import { z } from 'zod'

const INCIDENT_STATUSES = [
  'untriaged',
  'confirmed',
  'duplicate',
  'invalid',
  'watch',
  'needs_archive',
  'acceptance_pending',
  'closed'
] as const

const INCIDENT_CLASSES = [
  'crash',
  'no_progress',
  'tool_error',
  'acceptance_failed',
  'acceptance_overridden',
  'unknown_state'
] as const

const boundedCount = (max: number) =>
  z.number().int().min(0).max(max).optional()

export const IncidentSnapshotParams = z
  .object({
    limit: boundedCount(5_000),
    status: z.enum(INCIDENT_STATUSES).optional(),
    class: z.enum(INCIDENT_CLASSES).optional()
  })
  .optional()

export const IncidentDetailParams = z.object({
  incidentId: z.string().min(1).max(200)
})

export const IncidentCountsParams = z
  .object({
    topWorktrees: boundedCount(100)
  })
  .optional()
