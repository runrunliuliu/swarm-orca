// M4 read-only surface: which task creates never settled, and what each one left on disk.
//
// Why its own module: `worktree.ts` is at its file budget, and this handler is a self-contained
// query — it resolves nothing, writes nothing and shares no helpers with create/remove.

import { formatTaskCreateStatus, printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import type { RuntimeClient } from '../runtime-client'

export type TaskCreateStatusResult = {
  repoId: string
  repoPath: string
  attempts: {
    attempt: {
      requestId: string
      branch: string
      worktreePath: string
      state: string
      reasons: string[]
      pinnedSha: string
      createdAt: number
    }
    observation: {
      state: string
      reasons: string[]
      ghostRegistration: boolean
      directoryExists: boolean
    }
  }[]
}

export async function handleWorktreeCreateStatus(args: {
  flags: Map<string, string | boolean>
  client: RuntimeClient
  json: boolean
}): Promise<void> {
  const limit = getOptionalPositiveIntegerFlag(args.flags, 'limit')
  const result = await args.client.call<TaskCreateStatusResult>('worktree.createStatus', {
    repo: getRequiredStringFlag(args.flags, 'repo'),
    ...(limit !== undefined ? { limit } : {})
  })
  printResult(result, args.json, formatTaskCreateStatus)
}
