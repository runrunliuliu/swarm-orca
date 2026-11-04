import { WorkerWritableRoots } from '../../../shared/worker-writable-roots'
import { RuntimeClientError } from '../../runtime-client'

export function parseWorkerWritableRootsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      '--writable-roots must be a JSON array of directory paths.'
    )
  }
  const result = WorkerWritableRoots.safeParse(parsed)
  if (!result.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--writable-roots requires 1–32 nonempty paths without control characters (maximum 4096 characters each).'
    )
  }
  return result.data
}
