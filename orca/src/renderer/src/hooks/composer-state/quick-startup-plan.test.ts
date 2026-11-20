import { describe, expect, it } from 'vitest'
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
      agent: 'pi',
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
})
