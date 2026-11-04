import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime-terminal-contracts'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { TERMINAL_SEND_METHODS } from './methods/terminal/terminal-send-method'
import { orchestrationRequest, idOf, resultOf } from './orchestration-session-caller-test-fixture'
import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'

export const COORD = 'term_coord'
export const WORKER = 'term_worker'
export const OTHER = 'term_other'
export const OPERATOR = 'term_operator'

export function strictCoordinatorHarness(streaming = false) {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const authorities = new Map<string, OrchestrationCompatibilityTerminalAuthority>()
  for (const [index, handle] of [COORD, WORKER, OTHER, OPERATOR].entries()) {
    authorities.set(handle, {
      runtimeId: 'runtime-test',
      terminalHandle: handle,
      ptyId: `pty-${handle}`,
      worktreeId: 'folder',
      processIncarnation: `pty-${handle}:1`,
      paneKey: `tab:${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      launchTokenHash: createHash('sha256').update(`launch-${handle}`).digest('hex'),
      hostScope: { kind: 'local', hostId: 'local' }
    })
  }
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
    (h) => authorities.get(h) ?? null
  )
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
    (h) => authorities.get(h)?.paneKey ?? null
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
    (h) => authorities.get(h)?.paneKey ?? null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
    (h) => authorities.get(h)?.processIncarnation ?? null
  )
  vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  const nudge = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => undefined)
  const listTerminals = vi.spyOn(runtime, 'listTerminals').mockImplementation(async () => {
    const terminals: RuntimeTerminalSummary[] = [...authorities].map(([handle, authority]) => ({
      handle,
      ptyId: authority.ptyId,
      worktreeId: 'folder',
      worktreePath: '/tmp/folder',
      branch: '',
      tabId: 'tab',
      leafId: authority.paneKey?.slice(4) ?? '',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    }))
    return { terminals, totalCount: terminals.length, truncated: false }
  })
  const rawSend = vi.spyOn(runtime, 'sendTerminal').mockResolvedValue({
    handle: WORKER,
    accepted: true,
    bytesWritten: 1
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...ORCHESTRATION_METHODS, ...TERMINAL_SEND_METHODS]
  })
  const evidence = (handle: string) => ({
    terminalHandle: handle,
    paneKey: authorities.get(handle)?.paneKey ?? '',
    launchToken: `launch-${handle}`
  })
  async function call(
    method: string,
    params: Record<string, unknown>,
    caller?: string,
    requestId?: string
  ) {
    const request = orchestrationRequest(
      method,
      method === 'orchestration.send' ? { subject: 'test', ...params } : params,
      { evidence: caller ? evidence(caller) : undefined, requestId }
    )
    if (!streaming) {
      return dispatcher.dispatch(request)
    }
    const replies: string[] = []
    await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply))
    if (replies.length !== 1) {
      throw new Error(`Unexpected replies: ${replies.length}`)
    }
    const reply: unknown = JSON.parse(replies[0]!)
    return reply
  }
  async function create() {
    const result = resultOf(
      await call(
        'orchestration.runCreateStrict',
        { from: COORD, objective: 'Train and research' },
        COORD
      )
    )
    return idOf(result.run)
  }
  async function dispatch(run: string, to = WORKER) {
    const task = idOf(
      resultOf(
        await call(
          'orchestration.taskCreate',
          {
            run,
            callerTerminalHandle: COORD,
            spec: `Work for ${to}`
          },
          COORD
        )
      ).task
    )
    return idOf(
      resultOf(await call('orchestration.dispatch', { run, from: COORD, task, to }, COORD)).dispatch
    )
  }
  return {
    db,
    runtime,
    authorities,
    dispatcher,
    nudge,
    rawSend,
    listTerminals,
    evidence,
    call,
    create,
    dispatch,
    close: () => db.close()
  }
}
