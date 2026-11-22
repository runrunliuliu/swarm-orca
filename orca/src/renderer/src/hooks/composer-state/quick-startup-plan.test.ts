import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildQuickComposerStartup } from './quick-startup-plan'

const base = {
  agent: 'claude' as const,
  settings: null,
  repoConnectionId: null,
  platform: 'darwin' as const,
  shell: 'posix' as const,
  isRemote: false,
  telemetrySource: undefined
}

describe('buildQuickComposerStartup launch mode', () => {
  it('keeps the single-agent command prompt and its draft apart', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      prompt: 'Complete https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      launch: { mode: 'single', maxWorkers: 4 }
    })

    expect(startup.creationPrompt).toBe('Complete https://github.com/acme/web-app/issues/123')
    expect(startup.launchDraftPrompt).toBe('https://github.com/acme/web-app/issues/123')
    expect(startup.deliveredPrompt).toBe('https://github.com/acme/web-app/issues/123')
    expect(startup.promptDelivery).toBe('draft')
  })

  it('keeps auto-submit for a single agent with no draft', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      prompt: 'fix the cache key',
      draftPrompt: null,
      launch: { mode: 'single', maxWorkers: 4 }
    })

    expect(startup.promptDelivery).toBe('auto-submit')
    expect(startup.creationPrompt).toBe('fix the cache key')
  })

  it('launches a Coordinator clean and hands the brief to the post-create paste', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      agent: 'codex',
      prompt: 'https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      launch: { mode: 'swarm', maxWorkers: 4 },
      linkedWorkItemUrl: 'https://github.com/acme/web-app/issues/123',
      repoPath: '/work/acme/web-app',
      baseRef: 'main',
      note: ''
    })

    expect(startup.promptDelivery).toBe('submit-after-ready')
    expect(startup.launchDraftPrompt).toBeNull()
    expect(startup.creationPrompt).toContain('max_workers=4')
    expect(startup.startupPlan?.draftPrompt).toBe(startup.creationPrompt)
    // Why: the backend must not spawn the agent with the brief on its command line, so the
    // renderer owns startup and the paste delivery.
    expect(startup.startupPlan?.launchCommand).not.toContain('max_workers')
    expect(startup.backendStartup).toBeUndefined()
  })

  it('carries the Coordinator brief as a submitted pi prefill instead of a paste', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      agent: 'pi',
      prompt: 'https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      launch: { mode: 'swarm', maxWorkers: 4 },
      linkedWorkItemUrl: 'https://github.com/acme/web-app/issues/123',
      repoPath: '/work/acme/web-app',
      baseRef: 'main',
      note: ''
    })

    // Why: #54 — paste-after-ready never reached pi, so the brief must ride the prefill env
    // with the extension's submit flag, i.e. the launch itself delivers and submits it.
    expect(startup.promptDelivery).toBe('auto-submit')
    expect(startup.creationPrompt).toContain('max_workers=4')
    expect(startup.startupPlan?.draftPrompt).toBeUndefined()
    expect(startup.startupPlan?.env).toEqual({
      ORCA_PI_PREFILL: startup.creationPrompt,
      ORCA_PI_PREFILL_SUBMIT: '1'
    })
    expect(startup.startupPlan?.launchCommand).toContain(
      'unset ORCA_PI_PREFILL ORCA_PI_PREFILL_SUBMIT'
    )
    // Why: nothing is left for the renderer to paste, so the backend spawns the pane with
    // this env and the extension starts the turn.
    expect(startup.backendStartup?.env).toEqual(startup.startupPlan?.env)
  })

  it('keeps the paste path for pi when status hooks are off, since nothing consumes the flag', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      agent: 'pi',
      settings: { ...getDefaultSettings('/tmp'), agentStatusHooksEnabled: false },
      prompt: 'https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      launch: { mode: 'swarm', maxWorkers: 4 },
      linkedWorkItemUrl: 'https://github.com/acme/web-app/issues/123',
      repoPath: '/work/acme/web-app',
      baseRef: 'main',
      note: ''
    })

    // Why: the managed extension is not installed with hooks off, so auto-submit would drop
    // the brief with no paste fallback — the exact #54 symptom.
    expect(startup.promptDelivery).toBe('submit-after-ready')
    expect(startup.startupPlan?.draftPrompt).toBe(startup.creationPrompt)
    expect(startup.startupPlan?.env).not.toHaveProperty('ORCA_PI_PREFILL_SUBMIT')
  })

  it('keeps the single-agent pi draft seed-only, with no submit flag', () => {
    const startup = buildQuickComposerStartup({
      ...base,
      agent: 'pi',
      prompt: 'https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      launch: { mode: 'single', maxWorkers: 4 }
    })

    expect(startup.promptDelivery).toBe('draft')
    expect(startup.startupPlan?.env).toEqual({ ORCA_PI_PREFILL: startup.launchDraftPrompt })
    expect(startup.startupPlan?.env).not.toHaveProperty('ORCA_PI_PREFILL_SUBMIT')
  })
})
