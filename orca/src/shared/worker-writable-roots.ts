import { z } from 'zod'

export const WorkerWritableRoots = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      // oxlint-disable-next-line no-control-regex -- Reject control characters before shell quoting.
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
  )
  .min(1)
  .max(32)
