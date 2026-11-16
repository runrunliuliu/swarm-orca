import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

/**
 * The grant is submitted as a record, not as a dozen named params: the record is the thing that gets
 * stored and re-validated on read, so accepting it as one document keeps a single schema instead of
 * a param shape that could drift from it.
 *
 * The record must **not** contain `minter`. The server writes it from the caller's verified live
 * authority, because a caller cannot read its own `launchTokenHash`; a record that names a minter is
 * refused rather than having the field quietly replaced, so a mint can never be attributed to a
 * terminal that did not call.
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
