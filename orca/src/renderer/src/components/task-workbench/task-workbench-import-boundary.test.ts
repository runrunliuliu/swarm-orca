import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The P1a shell renders a `view` prop and nothing else (p1a-ui-shell-plan.md §1,
 * §5 item 6). P1b moves the store read out of the shell and into
 * `hooks/use-task-workbench-view.ts` (the tab and its data hook live outside
 * `components/task-workbench/`; the shell keeps receiving `view`). This file
 * asserts both halves of that move:
 *
 * - every shell source and every pure `lib/task-workbench/` selector imports no
 *   store, RPC, IPC, runtime or Electron module — including the exact regression
 *   the plan's R18 invites (`DashboardAgentRow`, which pulls `@/store` in
 *   through `useAgentRowConversationName`);
 * - the one permitted store reader exists *outside* the shell source set and
 *   actually imports `@/store`. That positive assertion is stronger than the
 *   previous negative-only check: it pins where the data edge lives instead of
 *   merely forbidding one inside the shell.
 *
 * Why a source assertion instead of a bundler check: the renderer has no
 * restricted-import rule for these paths, and a module-graph test cannot tell a
 * type-only edge from a value import. Reading the specifiers is the honest,
 * runnable form of "the module dependency list contains no data path".
 *
 * One sanctioned edge (§7.11.4's bounded exception): `TaskWorkbenchDelivery.tsx`
 * value-imports `@/lib/task-workbench/task-workbench-deliver-launch`, and that
 * module is the store edge — it reads the live tab model and starts a tab. The
 * exception is exactly one file and one module, so it is asserted below rather
 * than left to weaken the claim: the fact row is the only shell importer, and
 * the confirmation panel imports neither the launcher nor `@/store`.
 */

const sourceDir = import.meta.dirname
const libDir = path.resolve(sourceDir, '../../lib/task-workbench')
const hookPath = path.resolve(sourceDir, '../../hooks/use-task-workbench-view.ts')
const LAUNCHER_SPECIFIER = '@/lib/task-workbench/task-workbench-deliver-launch'

type SourceFile = { dir: string; file: string }

const storeFreeSources: SourceFile[] = [
  { dir: sourceDir, file: 'TaskWorkbenchPanel.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchAgents.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchAgentRow.tsx' },
  { dir: sourceDir, file: 'task-workbench-agent-row-dot.tsx' },
  { dir: sourceDir, file: 'task-workbench-section-heading.tsx' },
  { dir: sourceDir, file: 'task-workbench-pending-action.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchWorkspaces.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchFacts.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchHistory.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchSpend.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchDelivery.tsx' },
  { dir: sourceDir, file: 'task-workbench-view.ts' },
  { dir: sourceDir, file: 'task-workbench-layout.ts' },
  { dir: sourceDir, file: 'task-workbench-usage-status.ts' },
  { dir: sourceDir, file: 'task-workbench-row-projection.ts' },
  // §7.11's delivery entry: the state/action projection and the DELIVER marker
  // are read by both hosts, so both stay data-free for the same reason.
  { dir: sourceDir, file: 'task-workbench-deliver-state.ts' },
  { dir: sourceDir, file: 'task-workbench-deliver-session.ts' },
  // §7.11's confirmation panel: props in, callbacks out. Both entries render the
  // same component, so it must never reach for the store to decide anything.
  { dir: sourceDir, file: 'task-workbench-deliver-confirm.tsx' },
  // P1b's frozen contract and pure selectors. They are the hook's inputs and
  // must stay data-free for the same reason the shell is.
  { dir: libDir, file: 'task-workbench-selector-types.ts' },
  { dir: libDir, file: 'task-workbench-identity.ts' },
  { dir: libDir, file: 'task-workbench-usage.ts' },
  { dir: libDir, file: 'task-workbench-join.ts' },
  { dir: libDir, file: 'task-workbench-history-merge.ts' },
  // P3 thin slice (issue #27): the list-row activity selector is pure too —
  // the list hook below is the only place that reads the store for it.
  { dir: libDir, file: 'task-workbench-row-activity.ts' },
  { dir: libDir, file: 'task-workbench-workspace-branch.ts' }
]

/** Value imports that would make the shell read live data. Type imports are
 *  allowed for shapes only, and the rules below still apply to them by name. */
const FORBIDDEN_SPECIFIERS = [
  /^@\/store(\/|$)/,
  /^@\/rpc(\/|$)/,
  /^@\/runtime(\/|$)/,
  /^@\/ipc(\/|$)/,
  /(^|\/)store(\/|$)/,
  /(^|\/)rpc(\/|$)/,
  /^electron$/,
  /(^|\/)DashboardAgentRow$/
]

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    // import x from 'y' / import type { T } from 'y' / export type { T } from 'y'
    /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]/g,
    // import 'y'
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    // await import('y') / require('y')
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

/** Value imports only: `import type` is erased at build time, so it carries no
 *  runtime edge into the store. Used for the one sanctioned launcher edge.
 *  `[^'"]` (not `[^'"\n]`) so a multi-line import block is seen as one edge. */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function readSource({ dir, file }: SourceFile): string {
  return readFileSync(path.join(dir, file), 'utf8')
}

function forbiddenIn(sourceFile: SourceFile): string[] {
  return importSpecifiers(readSource(sourceFile)).filter((specifier) =>
    FORBIDDEN_SPECIFIERS.some((pattern) => pattern.test(specifier))
  )
}

describe('task workbench import boundary', () => {
  it.each(storeFreeSources)('$file imports no store, RPC, IPC or Electron module', (sourceFile) => {
    expect(forbiddenIn(sourceFile)).toEqual([])
  })

  it('renders agent rows itself instead of borrowing the board card', () => {
    // README §7.4.2: the board's body + footer card inside this section was the
    // card-in-a-card this rework removed, and it dragged the board's 80px token
    // column along. Reintroducing it here would restore both, so the absence is
    // the assertion — the flat row is the workbench's own file.
    const baseImporters = storeFreeSources
      .filter((sourceFile) =>
        importSpecifiers(readSource(sourceFile)).some((specifier) =>
          specifier.endsWith('AgentKanbanCard')
        )
      )
      .map((sourceFile) => sourceFile.file)
    expect(baseImporters).toEqual([])
  })

  it('keeps §7.11.4’s exception to one file: only the fact row reaches the launcher', () => {
    // Value imports only: `import type` is erased at build time and carries no
    // runtime edge. The confirmation panel imports the integration-mode type
    // from the launcher — a shape, not a store read.
    const importers = storeFreeSources
      .filter((sourceFile) =>
        valueImportSpecifiers(readSource(sourceFile)).some(
          (specifier) => specifier === LAUNCHER_SPECIFIER
        )
      )
      .map((sourceFile) => sourceFile.file)
    expect(importers).toEqual(['TaskWorkbenchDelivery.tsx'])

    // The confirmation panel is props in / callbacks out: it must not reach the
    // launcher's values (a second store edge) nor `@/store` in any form.
    const confirmSource = readSource({ dir: sourceDir, file: 'task-workbench-deliver-confirm.tsx' })
    expect(valueImportSpecifiers(confirmSource)).not.toContain(LAUNCHER_SPECIFIER)
    expect(
      importSpecifiers(confirmSource).filter((specifier) => /^@\/store(\/|$)/.test(specifier))
    ).toEqual([])
  })

  it('keeps the one store reader in the hook, outside the shell source set', () => {
    const shellPaths = storeFreeSources
      .filter((sourceFile) => sourceFile.dir === sourceDir)
      .map((sourceFile) => path.join(sourceFile.dir, sourceFile.file))
    expect(shellPaths).not.toContain(hookPath)

    // readFileSync throws when the hook is missing: existence is part of the contract.
    expect(importSpecifiers(readFileSync(hookPath, 'utf8'))).toContain('@/store')
  })
})
