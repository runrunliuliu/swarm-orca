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
  'orchestration start-grant-mint': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    // The record is submitted as the file the minter already persisted: re-serialising it here would
    // change the bytes a retry has to reproduce for the mint to be idempotent.
    const record: unknown = JSON.parse(
      await readFile(getRequiredStringFlag(flags, 'record-file'), 'utf8')
    )
    const result = await callOrchestrationMutation<{
      grant: { grantId: string; maxWorkers: number }
      effectsApplied: boolean
    }>(client, flags, 'orchestration.startGrantMint', { from, record })
    printResult(result, json, (r) =>
      r.effectsApplied
        ? `Start grant ${r.grant.grantId} minted (${r.grant.maxWorkers} Workers).`
        : `Start grant ${r.grant.grantId} already minted with the same record.`
    )
  },
  'orchestration start-grant-show': async ({ flags, client, json }) => {
    const result = await client.call('orchestration.startGrantShow', {
      grant: getRequiredStringFlag(flags, 'grant')
    })
    printResult(result, json, (r) => JSON.stringify(r))
  },
  'orchestration start-grant-revoke': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      revocation: { grantId: string; revokedAt: string }
      effectsApplied: boolean
    }>(client, flags, 'orchestration.startGrantRevoke', {
      from,
      grant: getRequiredStringFlag(flags, 'grant'),
      reason: getRequiredStringFlag(flags, 'reason')
    })
    printResult(result, json, (r) =>
      r.effectsApplied
        ? `Start grant ${r.revocation.grantId} revoked at ${r.revocation.revokedAt}.`
        : `Start grant ${r.revocation.grantId} was already revoked with the same reason.`
    )
  },
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const objective = getRequiredStringFlag(flags, 'objective')
    const grant = getOptionalStringFlag(flags, 'grant')
    if (grant !== undefined && !flags.has('strict-coordinator')) {
      // Why refuse instead of implying it: a grant only covers a strict Run today, and silently
      // accepting the flag on the plain path would mint a Run that no grant covers.
      throw new Error('--grant requires --strict-coordinator; a start grant only covers a strict Run.')
    }
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
      effectsApplied?: boolean
    }>(
      client,
      flags,
      grant !== undefined
        ? 'orchestration.runCreateGranted'
        : flags.has('strict-coordinator')
          ? 'orchestration.runCreateStrict'
          : 'orchestration.runCreate',
      {
        objective,
        from,
        ...(grant !== undefined ? { grant } : {})
      }
    )
    printResult(result, json, (r) =>
      r.effectsApplied === false
        ? `Run ${r.run.id} already created by this grant: ${r.run.objective}`
        : `Run ${r.run.id} created and bound: ${r.run.objective}`
    )
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
