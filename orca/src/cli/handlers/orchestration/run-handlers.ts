import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { readFile } from 'node:fs/promises'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration planned-restart': async ({ flags, client, json }) => {
    // The sealed host rejects ordinary identity probes; this RPC authenticates the envelope itself.
    const from = getOptionalStringFlag(flags, 'from')
    const request: unknown = JSON.parse(
      await readFile(getRequiredStringFlag(flags, 'request-file'), 'utf8')
    )
    const result = await client.call('orchestration.plannedRestart', { from, request })
    printResult(result, json, (r) => JSON.stringify(r))
  },
  'orchestration strict-caller-check': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{ caller: { terminalHandle: string } }>(
      'orchestration.strictCallerCheck',
      { from }
    )
    printResult(result, json, (r) => `Live strict caller verified: ${r.caller.terminalHandle}`)
  },
  'orchestration run-retire-strict': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const generation = getOptionalPositiveIntegerFlag(flags, 'generation')
    if (generation === undefined) {
      throw new Error('Missing --generation')
    }
    const result = await callOrchestrationMutation<{ runId: string }>(
      client,
      flags,
      'orchestration.runRetireStrict',
      {
        run: getRequiredStringFlag(flags, 'run'),
        from,
        generation,
        decision: getRequiredStringFlag(flags, 'decision')
      }
    )
    printResult(result, json, (r) => `Strict Run ${r.runId} retired; history retained.`)
  },
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(
      client,
      flags,
      flags.has('strict-coordinator') ? 'orchestration.runCreateStrict' : 'orchestration.runCreate',
      {
        objective: getRequiredStringFlag(flags, 'objective'),
        from
      }
    )
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run
        ? `${r.run.id} ${r.run.objective}`
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(
      result,
      json,
      (r) =>
        `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
        `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}`
    )
  }
}
