import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

/**
 * The grant is submitted as a record, not as a dozen named params: the record is the thing that gets
 * stored and re-validated on read, so accepting it as one document keeps a single schema instead of
 * a param shape that could drift from it.
 *
 * `minter` is inside the record so the caller can see what will be stored, but the server compares it
 * with the live caller's authority and refuses a record that names someone else — a mint is never
 * allowed to attribute itself to another terminal.
 */
export const StartGrantMintParams = z.object({
  from: requiredString('Missing --from: the terminal minting the grant'),
  record: z.unknown()
})

export const StartGrantShowParams = z.object({
  grant: requiredString('Missing --grant'),
  from: z.string().min(1).optional()
})

export const StartGrantRevokeParams = z.object({
  from: requiredString('Missing --from: the terminal withdrawing the grant'),
  grant: requiredString('Missing --grant'),
  reason: requiredString('Missing --reason: why the grant is withdrawn')
})
