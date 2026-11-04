import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTraeIdleLogEvidence } from './trae-idle-log-evidence'

const dirs: string[] = []
const at = Date.now() - 3_600_000
const baseHeader = {
  type: 'session_meta',
  payload: {
    id: 'session-1',
    source: 'cli',
    originator: 'traex-tui',
    cli_version: '0.211.1'
  }
}
const complete = {
  type: 'event_msg',
  timestamp: new Date(at).toISOString(),
  payload: {
    type: 'task_complete',
    turn_id: '01a1854b-b1d2-7602-8790-62765be56004'
  }
}
const line = (record: unknown) => `${JSON.stringify(record)}\n`
async function log(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'trae-idle-log-'))
  dirs.push(dir)
  const path = join(dir, 'rollout.jsonl')
  await writeFile(path, content)
  return { path, sessionId: 'session-1', hookObservedAt: at }
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe.each(['0.211.1', '0.212.1'])('bounded Trae Stop corroboration (%s)', (version) => {
  const header = {
    type: 'session_meta',
    payload: { ...baseHeader.payload, cli_version: version }
  }
  it('checks the head and final completion of a multi-megabyte log', async () => {
    const input = await log(
      line(header) + line({ padding: 'x'.repeat(3_000_000) }) + line(complete)
    )
    expect(await readTraeIdleLogEvidence(input)).not.toBeNull()
  })
  it.each([
    ['new start', line({ type: 'event_msg', payload: { type: 'task_started' } })],
    ['new context', line({ type: 'turn_context', payload: {} })],
    ['unknown newer record', line({ type: 'new_provider_event' })],
    ['partial append', '{'],
    ['malformed line', 'no json\n'],
    ['blank trailing line', '\n']
  ])('does not look past %s', async (_label, suffix) => {
    expect(
      await readTraeIdleLogEvidence(await log(line(header) + line(complete) + suffix))
    ).toBeNull()
  })
  it.each(['session', 'time', 'version', 'missing newline'])(
    'rejects mismatched %s',
    async (kind) => {
      const input = await log(
        line(
          kind === 'version'
            ? { ...header, payload: { ...header.payload, cli_version: 'unknown' } }
            : header
        ) + (kind === 'missing newline' ? JSON.stringify(complete) : line(complete))
      )
      if (kind === 'session') {
        input.sessionId = 'other'
      }
      if (kind === 'time') {
        input.hookObservedAt -= 60_000
      }
      expect(await readTraeIdleLogEvidence(input)).toBeNull()
    }
  )
  it('refuses symlink substitution', async () => {
    const input = await log(line(header) + line(complete))
    await symlink(input.path, `${input.path}.link`)
    expect(await readTraeIdleLogEvidence({ ...input, path: `${input.path}.link` })).toBeNull()
  })
})
