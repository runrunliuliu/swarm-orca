/**
 * The incidents module's outer boundary (B3).
 *
 * Ten upstream files are special: they are the places Orca's own upstream changes keep touching (PTY
 * exit wiring, the orchestration settlement chain, startup services, the structured agent-session
 * host). They may only reach the incidents module through `./integration`, so an internal rename or a
 * file move is a one-line change here instead of a conflict in every upstream re-import.
 *
 * Two failure modes this file exists to catch, both cheap to fix and expensive to discover late:
 *   1. someone re-introduces a deep `incidents/<internal>.ts` import in one of those ten files;
 *   2. `integration.ts` drifts — a symbol added, removed or renamed without the ten consumers being
 *      considered. The pinned list below is the contract; when an internal module renames a symbol,
 *      this test fails first, before an upstream file silently stops compiling.
 *
 * The source-text check is deliberate (the repo already has static import checks of this kind): an
 * import graph assertion here would only prove what the bundler already knows, while the real risk is
 * the NEXT edit adding a second, deeper path.
 */
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as integration from './integration'

/**
 * The ten files that must keep working across upstream re-imports, relative to `src/main`.
 *
 * Paths are pinned on purpose: if upstream moves or renames one of them, this suite fails and asks for
 * a deliberate decision instead of letting the boundary rot.
 */
const UPSTREAM_CONSUMERS = [
  'runtime/orca-runtime-on-pty-exit.ts',
  'runtime/orchestration/db/dispatch-context/dispatch-completion.ts',
  'runtime/orchestration/db/dispatch-context/worker-report-settlement.ts',
  'runtime/orchestration/db/federation/federation-relay-import.ts',
  'runtime/orchestration/db/legacy/legacy-lifecycle-operation.ts',
  'runtime/orchestration/lifecycle-reconciliation.ts',
  'runtime/rpc/methods/orchestration/messaging/send-methods.ts',
  'startup/main-process-ready-foundation.ts',
  'startup/main-process-runtime-service.ts',
  'native-chat/agent-session-wire/structured-agent-session-host-runtime-state.ts'
] as const

/** Every value the ten files use, in the order `integration.ts` groups them. */
const EXPECTED_VALUES = [
  'recordPtyExitIncident',
  'fallbackPtyIncarnationId',
  'decideMaintenanceAcceptance',
  'decideWorkerReportAcceptance',
  'evaluateAcceptanceForDispatch',
  'logAcceptanceBlocked',
  'scheduleIncidentShadowReconcile',
  'configureStallSamplerSource',
  'startStallSampler',
  'stallRowsFromStatusSnapshot',
  'observeToolErrorItem'
] as const

/** The one type-only export (`type AcceptanceDecision`). */
const EXPECTED_TYPE_ONLY = ['AcceptanceDecision'] as const

const EXPECTED_EXPORTS = [...EXPECTED_VALUES, ...EXPECTED_TYPE_ONLY].sort()

// `__dirname` works under both Vitest and the CommonJS tsc emit that build:cli type-checks against;
// `import.meta.dirname` does not (same reason as handler-group-manifest.test.ts).
const MAIN_DIR = join(__dirname, '..')

function readSource(relativeToMain: string): string {
  return readFileSync(join(MAIN_DIR, relativeToMain), 'utf8')
}

/** Every module specifier a file imports, static or dynamic. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const staticImport = /\bfrom\s+'([^']+)'/g
  const dynamicImport = /\bimport\(\s*'([^']+)'\s*\)/g
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

/** Resolve a specifier from a file (both relative to `src/main`) into a `src/main`-relative path. */
function resolveFrom(consumer: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(consumer), specifier))
}

/**
 * The export names `integration.ts` re-exports, parsed from `export { ... } from '...'` blocks.
 *
 * Parsed rather than imported because one of them is type-only: a runtime namespace cannot see it, and
 * losing it from the list would let a consumer's `import type` break only at compile time.
 */
function exportedNames(source: string): string[] {
  const names: string[] = []
  const block = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']+'/g
  for (const match of source.matchAll(block)) {
    for (const raw of match[1].split(',')) {
      const entry = raw.trim()
      if (entry.length === 0) {
        continue
      }
      // `type Foo` inside a braces block, or `Foo as Bar` — take the exported name.
      const withoutType = entry.startsWith('type ') ? entry.slice('type '.length).trim() : entry
      const exported = withoutType.includes(' as ')
        ? withoutType.split(' as ')[1].trim()
        : withoutType
      names.push(exported)
    }
  }
  return names.sort()
}

describe('incidents integration boundary', () => {
  it('is the only incidents entry point the ten upstream files import', () => {
    const leaks: string[] = []
    for (const consumer of UPSTREAM_CONSUMERS) {
      const expected = posix.relative(posix.dirname(consumer), 'incidents/integration')
      for (const specifier of importSpecifiers(readSource(consumer))) {
        if (!specifier.startsWith('.')) {
          continue
        }
        const resolved = resolveFrom(consumer, specifier)
        if (!resolved.startsWith('incidents/')) {
          continue
        }
        if (specifier !== expected) {
          leaks.push(`${consumer} imports ${specifier} (expected ${expected})`)
        }
      }
    }
    expect(leaks).toEqual([])
  })

  it('pins the exact export set of integration.ts', () => {
    const source = readFileSync(join(__dirname, 'integration.ts'), 'utf8')
    // No whole-module re-export: this file is a contract, not a mirror.
    expect(source).not.toMatch(/export\s+\*\s+from/)
    expect(exportedNames(source)).toEqual(EXPECTED_EXPORTS)
  })

  it('exposes every pinned value at runtime and nothing extra', () => {
    // Types are erased, so the runtime namespace must equal the value list exactly.
    expect(Object.keys(integration).sort()).toEqual([...EXPECTED_VALUES].sort())
    // Name each symbol explicitly rather than indexing the namespace: a removed export then fails as a
    // type error in this file, at the same place the list is pinned.
    expect(
      [
        integration.recordPtyExitIncident,
        integration.fallbackPtyIncarnationId,
        integration.decideMaintenanceAcceptance,
        integration.decideWorkerReportAcceptance,
        integration.evaluateAcceptanceForDispatch,
        integration.logAcceptanceBlocked,
        integration.scheduleIncidentShadowReconcile,
        integration.configureStallSamplerSource,
        integration.startStallSampler,
        integration.stallRowsFromStatusSnapshot,
        integration.observeToolErrorItem
      ].map((value) => typeof value)
    ).toEqual(EXPECTED_VALUES.map(() => 'function'))
  })

  it('lists exactly the ten upstream consumers, and every one exists', () => {
    expect(new Set(UPSTREAM_CONSUMERS).size).toBe(10)
    for (const consumer of UPSTREAM_CONSUMERS) {
      // Throws with the path in the message if upstream moved or renamed the file.
      expect(() => readSource(consumer), consumer).not.toThrow()
    }
  })
})
