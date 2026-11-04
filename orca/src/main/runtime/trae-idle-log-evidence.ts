import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { localLogFileIdentity, readLocalLogTailRange } from '../ai-vault/local-log-tail-reader'
import { LOCAL_LOG_TAIL_CHUNK_BYTES } from '../../shared/local-log-tail-types'

const metadata = z.object({
  type: z.literal('session_meta'),
  payload: z.object({
    id: z.string(),
    source: z.literal('cli'),
    originator: z.literal('traex-tui'),
    cli_version: z.enum(['0.211.1', '0.212.1'])
  })
})
const completion = z.object({
  type: z.literal('event_msg'),
  timestamp: z.string(),
  payload: z.object({ type: z.literal('task_complete'), turn_id: z.string().uuid() })
})

/** Corroborates an existing Stop; this file observation alone never attests a live idle CLI. */
export async function readTraeIdleLogEvidence(input: {
  path: string
  sessionId: string
  hookObservedAt: number
}): Promise<string | null> {
  try {
    if (!isAbsolute(input.path) || (await realpath(input.path)) !== resolve(input.path)) {
      return null
    }
    const before = await lstat(input.path)
    if (!before.isFile() || before.isSymbolicLink() || before.size === 0) {
      return null
    }
    const identity = localLogFileIdentity(before)
    const head = await readLocalLogTailRange(input.path, 0, identity)
    const offset = Math.max(0, before.size - LOCAL_LOG_TAIL_CHUNK_BYTES)
    const tail = offset === 0 ? head : await readLocalLogTailRange(input.path, offset, identity)
    const after = await lstat(input.path)
    if (
      head.reset ||
      tail.reset ||
      tail.hasMore ||
      tail.nextByteOffset !== before.size ||
      localLogFileIdentity(after) !== identity ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return null
    }
    const headerText = Buffer.from(head.contentBase64, 'base64').toString('utf8')
    const firstNewline = headerText.indexOf('\n')
    if (firstNewline === -1) {
      return null
    }
    const header = metadata.safeParse(JSON.parse(headerText.slice(0, firstNewline)))
    if (!header.success || header.data.payload.id !== input.sessionId) {
      return null
    }
    const tailText = Buffer.from(tail.contentBase64, 'base64').toString('utf8')
    if (!tailText.endsWith('\n')) {
      return null
    }
    const end = tailText.length - 1
    const start = tailText.lastIndexOf('\n', end - 1) + 1
    if (offset > 0 && start === 0) {
      return null
    }
    // Only a complete final record counts; never scan past newer/partial/malformed activity.
    const last = completion.safeParse(JSON.parse(tailText.slice(start, end)))
    if (!last.success) {
      return null
    }
    const completedAt = Date.parse(last.data.timestamp)
    if (
      !Number.isFinite(completedAt) ||
      completedAt > Date.now() ||
      Math.abs(completedAt - input.hookObservedAt) > 5_000
    ) {
      return null
    }
    return JSON.stringify([
      identity,
      before.size,
      before.mtimeMs,
      before.ctimeMs,
      last.data.payload.turn_id,
      completedAt
    ])
  } catch {
    return null
  }
}
