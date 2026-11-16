import { z } from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../orchestration-run-pagination'

export const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

/**
 * Create a Run under a start grant. A distinct method (and a mandatory `grant`) rather than an
 * optional flag on `runCreateStrict`: an older server that does not know the field would otherwise
 * strip it and create an uncapped strict Run, which is the exact outcome the grant exists to stop.
 */
export const RunCreateGrantedParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  grant: requiredString('Missing --grant: the start grant this Run is created under')
})

export const RunRetireStrictParams = z.object({
  run: requiredString('Missing --run'),
  from: requiredString('Missing coordinator terminal'),
  generation: z.number().int().positive(),
  decision: requiredString('Missing --decision: Coordinator reconciliation reference')
})

export const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

export const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })

export const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})

export const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })
