// Why a source assertion: the sweep only helps if startup actually calls it, and a unit test of the
// sweep cannot notice that nobody runs it. Same technique as the crash-sampling wiring guard.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const READY_RUNTIME = join(import.meta.dirname, 'main-process-ready-runtime.ts')

describe('task create journal sweep wiring', () => {
  it('is started from ready runtime services, fire-and-forget', async () => {
    const source = await readFile(READY_RUNTIME, 'utf8')
    const call = source.indexOf('void sweepTaskCreateJournalOnStart()')
    expect(call).toBeGreaterThan(-1)
    // Why fire-and-forget: startup must not wait for, or fail on, a diagnostic annotation.
    expect(source.slice(call, call + 200)).toContain('.catch(')
  })
})
