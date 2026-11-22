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
  const lines = [`  ${register}('session_start', async (event, ctx) => {`]
  if (submitVar) {
    // Why: a submitted prompt has no renderer paste fallback, so every case where the turn
    // cannot be started (resumed session, stripped pane key, old pi, a throwing send) still
    // leaves the brief as an editable seed instead of dropping it.
    lines.push(
      `    const submit = process.env.${submitVar} === '1'`,
      '    if (ctx?.hasUI === false) return',
      '    if (!process.env.ORCA_PANE_KEY && !submit) return',
      ...(kind === 'pi' ? ["    if (event.reason !== 'startup' && !submit) return"] : []),
      `    const prefill = process.env.${envVar}`,
      '    if (!prefill) return',
      '    if (submit) {',
      `      delete process.env.${submitVar}`,
      "      if (event.reason === 'startup' && process.env.ORCA_PANE_KEY && typeof pi.sendUserMessage === 'function') {",
      '        try {',
      '          pi.sendUserMessage(prefill)',
      `          delete process.env.${envVar}`,
      '          return',
      '        } catch {}',
      '      }',
      '    }'
    )
  } else {
    lines.push(
      '    if (!process.env.ORCA_PANE_KEY || ctx?.hasUI === false) return',
      ...(kind === 'pi' ? ["    if (event.reason !== 'startup') return"] : []),
      `    const prefill = process.env.${envVar}`,
      '    if (!prefill) return'
    )
  }
  lines.push(
    "    if (typeof ctx?.ui?.setEditorText !== 'function') return",
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })'
  )
  return lines
}
