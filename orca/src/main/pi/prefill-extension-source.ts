import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const ORCA_PI_PREFILL_EXTENSION_FILE = 'orca-prefill.ts'

// Why: prefill-without-submit needs an env-var the bundled `orca-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa).
type PrefillAgentKind = Exclude<PiAgentKind, 'prime-agent'>

const PREFILL_ENV_VAR_BY_KIND: Record<PrefillAgentKind, string> = {
  pi: 'ORCA_PI_PREFILL',
  omp: 'ORCA_OMP_PREFILL'
}

// Why: only pi declares a submit flag. Its extension can start a turn through
// `pi.sendUserMessage`, which is what a prompt with no argv slot needs; OMP has
// no measured equivalent yet, so it keeps the seed-only contract.
const PREFILL_SUBMIT_ENV_VAR_BY_KIND: Record<PrefillAgentKind, string | null> = {
  pi: 'ORCA_PI_PREFILL_SUBMIT',
  omp: null
}

export function getPiPrefillExtensionSource(kind: PrefillAgentKind): string {
  return ['export default function (pi) {', ...getPiPrefillHandlerSourceLines(kind), '}', ''].join(
    '\n'
  )
}

export function getPiPrefillHandlerSourceLines(
  kind: PrefillAgentKind,
  wrapInStatusOwner = false
): string[] {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  const submitVar = PREFILL_SUBMIT_ENV_VAR_BY_KIND[kind]
  const register = wrapInStatusOwner && kind === 'omp' ? 'onStatus' : 'pi.on'
  return [
    `  ${register}('session_start', async (event, ctx) => {`,
    '    if (!process.env.ORCA_PANE_KEY || ctx?.hasUI === false) return',
    ...(kind === 'pi' ? ["    if (event.reason !== 'startup') return"] : []),
    `    const prefill = process.env.${envVar}`,
    '    if (!prefill) return',
    ...(submitVar
      ? [
          `    if (process.env.${submitVar} === '1') {`,
          `      delete process.env.${submitVar}`,
          '      // Why: a submitted prompt (Swarm Coordinator brief) must start a turn, and',
          '      // sendUserMessage always does — setEditorText would only seed the box, which',
          '      // is the delivery that #54 showed never reaches pi at all.',
          "      if (typeof pi.sendUserMessage === 'function') {",
          `        delete process.env.${envVar}`,
          '        try {',
          '          pi.sendUserMessage(prefill)',
          '        } catch {}',
          '        return',
          '      }',
          '      // Why: an older pi without sendUserMessage keeps the editable seed instead of',
          '      // dropping the brief; one keypress is better than a silent no-op.',
          '    }'
        ]
      : []),
    "    if (typeof ctx?.ui?.setEditorText !== 'function') return",
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })'
  ]
}
