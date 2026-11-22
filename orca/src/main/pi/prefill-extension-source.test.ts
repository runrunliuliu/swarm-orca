import { runInNewContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { getPiPrefillExtensionSource } from './prefill-extension-source'

type PrefillKind = 'pi' | 'omp'

type HookContext = { hasUI?: boolean; ui?: { setEditorText?: (text: string) => void } }
type SessionStartHandler = (event: unknown, ctx?: HookContext) => Promise<void> | void

type PrefillExtension = {
  env: Record<string, string | undefined>
  sessionStart: SessionStartHandler
  /** Editor seeds observed through the context this harness hands the extension. */
  editorSeeds: string[]
  /** Messages sent through `pi.sendUserMessage`. */
  submitted: string[]
  /** A UI context that records editor seeds instead of rendering them. */
  ctx: HookContext
}

/** Run the generated extension in a sandbox, like Pi loads it, and expose its hooks. */
function loadPrefillExtension(args: {
  kind: PrefillKind
  env: Record<string, string | undefined>
  withSendUserMessage?: boolean
}): PrefillExtension {
  const env: Record<string, string | undefined> = { ...args.env }
  const output = ts.transpileModule(getPiPrefillExtensionSource(args.kind), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const module: { exports: { default?: (pi: unknown) => void } } = { exports: {} }
  const context: Record<string, unknown> = {
    module,
    exports: module.exports,
    process: { env }
  }
  context.globalThis = context
  runInNewContext(output, context)

  const handlers: Record<string, SessionStartHandler> = {}
  const editorSeeds: string[] = []
  const submitted: string[] = []
  const pi: Record<string, unknown> = {
    on: (name: string, handler: SessionStartHandler) => {
      handlers[name] = handler
    }
  }
  if (args.withSendUserMessage !== false) {
    pi.sendUserMessage = (content: string) => {
      submitted.push(content)
    }
  }
  module.exports.default?.(pi)
  const sessionStart = handlers.session_start
  if (!sessionStart) {
    throw new Error('expected a session_start handler in the generated extension')
  }
  return {
    env,
    sessionStart,
    editorSeeds,
    submitted,
    ctx: {
      ui: {
        setEditorText: (text: string) => {
          editorSeeds.push(text)
        }
      }
    }
  }
}

describe('getPiPrefillExtensionSource', () => {
  it('accepts OMP session_start events without a reason field', () => {
    const source = getPiPrefillExtensionSource('omp')
    expect(source).toContain('process.env.ORCA_OMP_PREFILL')
    expect(source).not.toContain("event.reason !== 'startup'")
  })

  it('keeps Pi startup reason filtering', () => {
    expect(getPiPrefillExtensionSource('pi')).toContain("event.reason !== 'startup'")
  })

  it('leaves OMP without the submit flag, so an OMP draft stays editable', () => {
    // Why: only pi has a measured submit entry point (pi.sendUserMessage); OMP keeps seed-only.
    expect(getPiPrefillExtensionSource('omp')).not.toContain('ORCA_OMP_PREFILL_SUBMIT')
  })
})

describe('generated Pi prefill extension', () => {
  it('seeds the editor without submitting when no submit flag is set', async () => {
    const extension = loadPrefillExtension({
      kind: 'pi',
      env: { ORCA_PANE_KEY: 'pane-1', ORCA_PI_PREFILL: 'Coordinator brief' }
    })

    await extension.sessionStart({ reason: 'startup' }, extension.ctx)

    expect(extension.editorSeeds).toEqual(['Coordinator brief'])
    expect(extension.submitted).toEqual([])
    expect(extension.env.ORCA_PI_PREFILL).toBeUndefined()
  })

  it('submits the brief through pi.sendUserMessage when the launch asks it to', async () => {
    const extension = loadPrefillExtension({
      kind: 'pi',
      env: {
        ORCA_PANE_KEY: 'pane-1',
        ORCA_PI_PREFILL: '以 Swarm Coordinator 模式开始工作',
        ORCA_PI_PREFILL_SUBMIT: '1'
      }
    })

    await extension.sessionStart({ reason: 'startup' }, extension.ctx)

    // Why: the whole point of #54 — this path starts a turn, so no paste and no keypress.
    expect(extension.submitted).toEqual(['以 Swarm Coordinator 模式开始工作'])
    expect(extension.editorSeeds).toEqual([])
    // Why: both seeds are one-shot; a reload must not replay the turn.
    expect(extension.env.ORCA_PI_PREFILL).toBeUndefined()
    expect(extension.env.ORCA_PI_PREFILL_SUBMIT).toBeUndefined()
  })

  it('falls back to an editable seed when the installed pi has no sendUserMessage', async () => {
    const extension = loadPrefillExtension({
      kind: 'pi',
      withSendUserMessage: false,
      env: {
        ORCA_PANE_KEY: 'pane-1',
        ORCA_PI_PREFILL: 'Coordinator brief',
        ORCA_PI_PREFILL_SUBMIT: '1'
      }
    })

    await extension.sessionStart({ reason: 'startup' }, extension.ctx)

    expect(extension.submitted).toEqual([])
    expect(extension.editorSeeds).toEqual(['Coordinator brief'])
    expect(extension.env.ORCA_PI_PREFILL).toBeUndefined()
    expect(extension.env.ORCA_PI_PREFILL_SUBMIT).toBeUndefined()
  })

  it('keeps the seed until an editor exists, so a UI-less start is not consumed', async () => {
    const extension = loadPrefillExtension({
      kind: 'pi',
      env: { ORCA_PANE_KEY: 'pane-1', ORCA_PI_PREFILL: 'Coordinator brief' }
    })

    await extension.sessionStart({ reason: 'startup' }, {})
    expect(extension.env.ORCA_PI_PREFILL).toBe('Coordinator brief')

    await extension.sessionStart({ reason: 'startup' }, extension.ctx)
    expect(extension.editorSeeds).toEqual(['Coordinator brief'])
    expect(extension.env.ORCA_PI_PREFILL).toBeUndefined()
  })

  it('ignores the seeds outside a startup session or outside an Orca pane', async () => {
    const resumed = loadPrefillExtension({
      kind: 'pi',
      env: {
        ORCA_PANE_KEY: 'pane-1',
        ORCA_PI_PREFILL: 'Coordinator brief',
        ORCA_PI_PREFILL_SUBMIT: '1'
      }
    })
    await resumed.sessionStart({ reason: 'resume' }, resumed.ctx)
    expect(resumed.submitted).toEqual([])
    expect(resumed.env.ORCA_PI_PREFILL).toBe('Coordinator brief')

    const ownerless = loadPrefillExtension({
      kind: 'pi',
      env: { ORCA_PI_PREFILL: 'Coordinator brief', ORCA_PI_PREFILL_SUBMIT: '1' }
    })
    await ownerless.sessionStart({ reason: 'startup' }, ownerless.ctx)
    expect(ownerless.submitted).toEqual([])
    expect(ownerless.env.ORCA_PI_PREFILL).toBe('Coordinator brief')
  })
})
