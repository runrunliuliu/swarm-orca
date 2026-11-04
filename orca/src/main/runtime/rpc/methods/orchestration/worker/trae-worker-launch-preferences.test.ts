import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../../../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../../../../../shared/tui-agent-startup-shell'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { FederationAttachStartParams } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'

const selection = {
  agent: 'trae' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  backendVariant: 'max'
}

describe('Trae worker launch overrides', () => {
  it.each(['low', 'medium', 'high', 'xhigh'])('accepts and records GPT-5.4 effort %s', (effort) => {
    const preferences = { model: 'gpt-5.4', effort, backendVariant: 'standard' }
    const requested = { agent: 'trae' as const, ...preferences }
    expect(resolveWorkerLaunchPreferences(requested)).toEqual({
      preferences,
      receipt: { requested, effective: requested }
    })
  })

  it.each(['max', 'ultra', 'turbo'])('rejects unsupported GPT-5.4 effort %s', (effort) => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'trae',
        model: 'gpt-5.4',
        effort,
        backendVariant: 'standard'
      })
    ).toThrow(`does not support effort ${effort}`)
  })

  it('rejects Max on GPT-5.4 even with a valid effort', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ ...selection, model: 'gpt-5.4', effort: 'xhigh' })
    ).toThrow('does not support backendVariant max')
  })

  it.each(['gpt-5.5', 'gpt-5.6-sol', 'DeepSeek-V4-Flash', 'unknown'])(
    'does not extend xhigh support to %s',
    (model) => {
      expect(() =>
        resolveWorkerLaunchPreferences({ agent: 'trae', model, effort: 'xhigh' })
      ).toThrow('does not support effort xhigh')
    }
  )

  it('preserves explicit GPT-5.4 Standard across both worker RPC boundaries', () => {
    const requested = {
      agent: 'trae',
      model: 'gpt-5.4',
      effort: 'xhigh',
      backendVariant: 'standard'
    }
    for (const parsed of [
      WorkerStartParams.parse({ ...requested, from: 'coord', task: 'task' }),
      FederationAttachStartParams.parse({
        ...requested,
        dispatchId: 'dispatch',
        taskId: 'task',
        taskSpec: 'test',
        protocolVersion: 3,
        worktree: 'folder:remote'
      })
    ]) {
      expect(parsed).toMatchObject(requested)
      expect(parsed.backendVariant).toBe('standard')
    }
  })

  it.each([false, true])('overrides configured Max with Standard (remote=%s)', (isRemote) => {
    const settings = {
      agentDefaultArgs: {
        trae: '-c model_backend_variant="max" --config=model_backend_variant="max"'
      },
      agentCmdOverrides: { trae: 'traecli' }
    }
    const before = structuredClone(settings)
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'trae', model: 'gpt-5.4', effort: 'xhigh' })
    ).toThrow('require explicit --backend-variant standard')
    const { preferences } = resolveWorkerLaunchPreferences({
      agent: 'trae',
      model: 'gpt-5.4',
      effort: 'xhigh',
      backendVariant: 'standard'
    })
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'trae',
      settings,
      platform: 'linux',
      isRemote,
      sessionOptions: preferences
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
    expect(tokenizeStartupCommand(plan?.launchCommand ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: [
        'traecli',
        '--model',
        'gpt-5.4',
        '-c',
        'model_reasoning_effort="xhigh"',
        '-c',
        'model_backend_variant="standard"'
      ]
    })
    expect(plan?.sessionOptions).toEqual(preferences)
    expect(settings).toEqual(before)
  })

  it('accepts DeepSeek V4.1 Max-only and records absent effort as null', () => {
    const preferences = { model: 'DeepSeek-V4.1-Flash', backendVariant: 'max' }
    const requested = { agent: 'trae' as const, ...preferences }
    const recorded = { ...requested, effort: null }
    expect(resolveWorkerLaunchPreferences(requested)).toEqual({
      preferences,
      receipt: { requested: recorded, effective: recorded }
    })
  })

  it.each(['high', 'xhigh', 'max'])('rejects DeepSeek V4.1 effort %s', (effort) => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'trae',
        model: 'DeepSeek-V4.1-Flash',
        backendVariant: 'max',
        effort
      })
    ).toThrow(`does not support effort ${effort}`)
  })

  it('rejects unknown DeepSeek V4.1 backend variants', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'trae',
        model: 'DeepSeek-V4.1-Flash',
        backendVariant: 'ultra'
      })
    ).toThrow('does not support backendVariant ultra')
  })

  it.each(['gpt-5.6-sol', 'gpt-5.5'])('validates and records the complete %s tuple', (model) => {
    const requested = { ...selection, model }
    expect(resolveWorkerLaunchPreferences(requested)).toEqual({
      preferences: { model, effort: 'high', backendVariant: 'max' },
      receipt: { requested, effective: requested }
    })
  })

  it('leaves omitted configuration unchanged', () => {
    expect(resolveWorkerLaunchPreferences({ agent: 'trae' }).preferences).toBeUndefined()
    expect(
      resolveWorkerLaunchPreferences({ agent: 'trae', model: 'example-provider-model' }).preferences
    ).toEqual({ model: 'example-provider-model' })
    expect(
      resolveWorkerLaunchPreferences({ agent: 'trae', model: 'DeepSeek-V4-Flash', effort: 'high' })
        .preferences
    ).toEqual({ model: 'DeepSeek-V4-Flash', effort: 'high' })
  })

  it.each([
    { ...selection, effort: 'max' },
    { ...selection, backendVariant: 'standard' },
    { ...selection, model: 'DeepSeek-V4-Flash' },
    { ...selection, model: 'example-provider-model', backendVariant: undefined },
    { ...selection, model: 'unknown' },
    { ...selection, agent: 'codex' as const },
    { agent: 'trae' as const, backendVariant: 'max' }
  ])('refuses unsupported combinations before placement: %o', (args) => {
    expect(() => resolveWorkerLaunchPreferences(args)).toThrow()
  })

  it('rejects Max on a reused terminal', () => {
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({ terminal: 'term_old', backendVariant: 'max' })
    ).toThrow('cannot be applied when reusing')
  })

  it('fails closed on old hosts for Trae model-only and Max requests', () => {
    const old = {
      capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY],
      serverName: 'old'
    }
    expect(() => assertWorkerLaunchPreferencesRuntimeSupported({ ...old, ...selection })).toThrow(
      'Trae'
    )
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        ...old,
        agent: 'trae',
        model: selection.model
      })
    ).toThrow('Trae')
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({ ...old, agent: 'trae' })
    ).not.toThrow()
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        ...old,
        ...selection,
        capabilities: [...old.capabilities, TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]
      })
    ).not.toThrow()
  })

  it('preserves the option on both worker RPC boundaries', () => {
    expect(
      WorkerStartParams.parse({ ...selection, from: 'coord', task: 'task' }).backendVariant
    ).toBe('max')
    expect(
      FederationAttachStartParams.parse({
        ...selection,
        dispatchId: 'dispatch',
        taskId: 'task',
        taskSpec: 'test',
        protocolVersion: 3,
        worktree: 'folder:remote'
      }).backendVariant
    ).toBe('max')
  })

  it('never invents effective Max or Trae model evidence from a ready response', () => {
    const requested = createPendingWorkerLaunchReceipt(selection)
    expect(() => resolveFederatedWorkerLaunchReceipt(undefined, requested, true)).toThrow(
      'did not confirm'
    )
    expect(() =>
      resolveFederatedWorkerLaunchReceipt(
        { requested: selection, effective: { ...selection, backendVariant: undefined } },
        requested,
        true
      )
    ).toThrow('did not confirm')
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, false)).toBe(requested)
    const receipt = { requested: selection, effective: selection }
    expect(resolveFederatedWorkerLaunchReceipt(receipt, requested, true)).toEqual(receipt)
  })

  it('requires remote confirmation of Standard, never legacy omission or Max', () => {
    const selected = {
      agent: 'trae' as const,
      model: 'gpt-5.4',
      effort: 'xhigh',
      backendVariant: 'standard'
    }
    const requested = createPendingWorkerLaunchReceipt(selected)
    for (const backendVariant of [undefined, 'max']) {
      expect(() =>
        resolveFederatedWorkerLaunchReceipt(
          { requested: selected, effective: { ...selected, backendVariant } },
          requested,
          true
        )
      ).toThrow('did not confirm')
    }
    const receipt = { requested: selected, effective: selected }
    expect(resolveFederatedWorkerLaunchReceipt(receipt, requested, true)).toEqual(receipt)
  })
})
