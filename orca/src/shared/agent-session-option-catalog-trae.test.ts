import { describe, expect, it } from 'vitest'
import { toAgentLaunchPreferences } from './agent-launch-preferences'
import { LaunchPreferences } from './rpc-contract/agent-session-params'
import { TRAE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-trae'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import { buildAgentStartupPlan } from './tui-agent-startup'
import {
  hasAgentConfigOverride,
  removeAgentConfigOverride
} from './agent-session-option-config-args'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

const selection = { model: 'gpt-5.6-sol', effort: 'high', backendVariant: 'max' }

describe('Trae session launch options', () => {
  it('keeps independent Max across session conversion and RPC parsing', () => {
    expect(toAgentLaunchPreferences(selection)).toEqual(selection)
    expect(LaunchPreferences.parse(selection)).toEqual(selection)
  })

  it('emits separate model, effort and backend overrides', () => {
    expect(resolveAgentSessionOptionLaunch('trae', selection, [], false)).toEqual({
      args: [
        '--model',
        selection.model,
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'model_backend_variant="max"'
      ],
      appliedValues: selection
    })
  })

  it('registers GPT-5.4 reasoning levels without Max or an effort default', () => {
    const model = TRAE_SESSION_OPTION_CATALOG.models.find((entry) => entry.id === 'gpt-5.4')
    expect(model?.options).toHaveLength(2)
    expect(model?.options[0]).toMatchObject({
      id: 'effort',
      kind: {
        type: 'select',
        choices: [
          { value: '', label: 'Use Trae config' },
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh' }
        ],
        defaultValue: ''
      }
    })
    expect(model?.options[1]).toMatchObject({
      id: 'backendVariant',
      kind: {
        choices: [
          { value: '', label: 'Use Trae config' },
          { value: 'standard', label: 'standard' }
        ],
        defaultValue: ''
      }
    })
  })

  it.each(['low', 'medium', 'high', 'xhigh'])('emits GPT-5.4 effort %s without Max', (effort) => {
    const requested = { model: 'gpt-5.4', effort }
    for (const defaults of [false, true]) {
      expect(resolveAgentSessionOptionLaunch('trae', requested, [], defaults)).toEqual({
        args: ['--model', requested.model, '-c', `model_reasoning_effort="${effort}"`],
        appliedValues: defaults ? { ...requested, backendVariant: '' } : requested
      })
      expect(
        resolveAgentSessionOptionLaunch('trae', { model: requested.model }, [], defaults).args
      ).toEqual(['--model', requested.model])
    }
  })

  it('applies GPT-5.4 xhigh through the Linux/SSH startup pipeline', () => {
    const requested = { model: 'gpt-5.4', effort: 'xhigh', backendVariant: 'standard' }
    const plan = buildAgentStartupPlan({
      agent: 'trae',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: { trae: 'traecli' },
      platform: 'linux',
      isRemote: true,
      sessionOptions: requested,
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '-m old -c model_reasoning_effort="low" -c model_backend_variant="max" --no-daemon'
    })
    expect(plan?.launchCommand).toBe(
      "traecli '--no-daemon' '--model' 'gpt-5.4' '-c' 'model_reasoning_effort=\"xhigh\"' '-c' 'model_backend_variant=\"standard\"'"
    )
    expect(plan?.sessionOptions).toEqual(requested)
  })

  it('does not inject effort or Max into model-only or default launches', () => {
    for (const defaults of [false, true]) {
      expect(
        resolveAgentSessionOptionLaunch('trae', { model: selection.model }, [], defaults).args
      ).toEqual(['--model', selection.model])
    }
    expect(resolveAgentSessionOptionLaunch('trae', undefined).args).toEqual([])
  })

  it('emits DeepSeek V4.1 Max without inventing a reasoning effort', () => {
    const maxOnly = { model: 'DeepSeek-V4.1-Flash', backendVariant: 'max' }
    for (const defaults of [false, true]) {
      expect(resolveAgentSessionOptionLaunch('trae', maxOnly, [], defaults)).toEqual({
        args: ['--model', maxOnly.model, '-c', 'model_backend_variant="max"'],
        appliedValues: maxOnly
      })
      expect(
        resolveAgentSessionOptionLaunch('trae', { model: maxOnly.model }, [], defaults).args
      ).toEqual(['--model', maxOnly.model])
    }
  })

  it.each([
    ['-c', 'model_backend_variant="old"'],
    ['--config', 'model_backend_variant = "old"'],
    ['-cmodel_backend_variant="old"'],
    ['-c=model_backend_variant="old"'],
    ['--config=model_backend_variant="old"'],
    ['--config', '"model_backend_variant" = "old"'],
    ['-c', "'model_backend_variant' = 'old'"]
  ])('replaces only the explicit TOML key in %j', (...tokens) => {
    const args = [...tokens, '-c', 'unrelated=true', '--', '-c', 'model_backend_variant="literal"']
    expect(hasAgentConfigOverride(args, 'model_backend_variant')).toBe(true)
    expect(removeAgentConfigOverride(args, 'model_backend_variant')).toEqual(
      args.slice(tokens.length)
    )
  })

  it('preserves malformed, nested and similarly named config assignments', () => {
    const args = [
      '-c',
      'model_backend_variantx',
      '-c',
      'model_backend_variant_extra="x"',
      '-c',
      'nested.model_backend_variant="x"'
    ]
    expect(removeAgentConfigOverride(args, 'model_backend_variant')).toEqual(args)
    expect(hasAgentConfigOverride(args, 'model_backend_variant')).toBe(false)
  })

  it('removes all model spellings while retaining unrequested effort and Max', () => {
    expect(
      removeOverriddenAgentSessionArgs('trae', { model: selection.model }, [
        '-mold',
        '--model=old',
        '-c',
        'model="old"',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'model_backend_variant="max"'
      ])
    ).toEqual(['-c', 'model_reasoning_effort="high"', '-c', 'model_backend_variant="max"'])
  })

  it('builds the fresh Linux/SSH launch through the existing startup pipeline', () => {
    const plan = buildAgentStartupPlan({
      agent: 'trae',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: { trae: 'traecli' },
      platform: 'linux',
      isRemote: true,
      sessionOptions: selection,
      sessionOptionsOverrideAgentArgs: true,
      agentArgs:
        '-m DeepSeek-V4-Flash -c model_reasoning_effort="low" -c model_backend_variant="old" --no-daemon'
    })
    expect(plan?.launchCommand).toBe(
      "traecli '--no-daemon' '--model' 'gpt-5.6-sol' '-c' 'model_reasoning_effort=\"high\"' '-c' 'model_backend_variant=\"max\"'"
    )
    expect(plan?.sessionOptions).toEqual(selection)
  })

  it.each([
    '-m old',
    '-c model="old"',
    '-c model_reasoning_effort="low"',
    '-c model_backend_variant="old"'
  ])('refuses a command override that would defeat the requested tuple: %s', (flags) => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'trae',
        cmdOverrides: { trae: `traecli ${flags}` },
        platform: 'linux',
        shell: 'posix',
        isRemote: true,
        sessionOptions: selection,
        sessionOptionsOverrideAgentArgs: true
      })
    ).toMatchObject({ ok: false })
  })
})
