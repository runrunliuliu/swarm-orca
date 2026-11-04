import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import { RuntimeClient } from '../runtime-client'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'
import { TRAE_WORKER_WRITABLE_ROOTS_CAPABILITY } from '../../shared/protocol-version'
import { parseWorkerWritableRootsFlag } from './orchestration/worker-writable-roots-flag'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'

describe('worker writable roots CLI', () => {
  const exitCode = process.exitCode
  afterEach(() => {
    process.exitCode = exitCode
  })
  function setup(capabilities: string[]) {
    const client = new RuntimeClient('/tmp/orca-roots-cli-unit', 60_000, null, null)
    const call = vi
      .fn()
      .mockResolvedValueOnce({ result: { capabilities } })
      .mockResolvedValueOnce({ result: { state: 'ready' } })
    client.call = call
    return {
      call,
      invoke: (value: string) => {
        const { flags } = parseArgs([
          'orchestration',
          'worker-start',
          '--spec',
          'test',
          '--from',
          'term_coord',
          '--agent',
          'trae',
          '--writable-roots',
          value
        ])
        return ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
          flags,
          client,
          cwd: '/tmp',
          json: true
        })
      }
    }
  }
  it('gates roots even without model overrides before any mutation', async () => {
    const { call, invoke } = setup([])
    await expect(invoke('["/tmp/evidence"]')).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
  })
  it('forwards parsed exact paths', async () => {
    const { call, invoke } = setup([TRAE_WORKER_WRITABLE_ROOTS_CAPABILITY])
    await invoke('["/tmp/evidence", "/tmp/with spaces"]')
    expect(call).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        writableRoots: ['/tmp/evidence', '/tmp/with spaces']
      })
    )
  })
  it.each(['not-json', 'null', '[]', '{}', '[1]', '[""]', '["a\\n"]'])(
    'rejects invalid input without contacting runtime: %s',
    async (input) => {
      const { call, invoke } = setup([])
      await expect(invoke(input)).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )
  it('preserves omission and documents scoped behavior', () => {
    expect(parseWorkerWritableRootsFlag(undefined)).toBeUndefined()
    const spec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (item) => item.path.join(' ') === 'orchestration worker-start'
    )
    if (!spec) {
      throw new Error('worker-start spec missing')
    }
    expect(spec.allowedFlags).toContain('writable-roots')
    expect(formatCommandHelp(spec)).toContain('--writable-roots <json_array>')
  })
})
