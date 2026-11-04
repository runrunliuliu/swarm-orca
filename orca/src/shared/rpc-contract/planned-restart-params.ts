import { z } from 'zod'

const Sha = z.string().regex(/^[a-f0-9]{64}$/)

export const PlannedSuccessorRequest = z
  .object({
    reviewCanonicalSha256: Sha,
    proposalCanonicalSha256: Sha
  })
  .strict()

export const PlannedRestartParams = z
  .object({
    from: z.string().optional(),
    request: z.unknown()
  })
  .strict()
