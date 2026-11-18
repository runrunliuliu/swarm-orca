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
 */

const sourceDir = import.meta.dirname
const libDir = path.resolve(sourceDir, '../../lib/task-workbench')
const hookPath = path.resolve(sourceDir, '../../hooks/use-task-workbench-view.ts')

type SourceFile = { dir: string; file: string }

const storeFreeSources: SourceFile[] = [
  { dir: sourceDir, file: 'TaskWorkbenchPanel.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchAgents.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchAgentRow.tsx' },
  { dir: sourceDir, file: 'task-workbench-agent-row-dot.tsx' },
  { dir: sourceDir, file: 'task-workbench-section-heading.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchWorkspaces.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchFacts.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchSpend.tsx' },
  { dir: sourceDir, file: 'TaskWorkbenchDelivery.tsx' },
  { dir: sourceDir, file: 'task-workbench-view.ts' },
  { dir: sourceDir, file: 'task-workbench-layout.ts' },
  { dir: sourceDir, file: 'task-workbench-usage-status.ts' },
  { dir: sourceDir, file: 'task-workbench-row-projection.ts' },
  // P1b's frozen contract and pure selectors. They are the hook's inputs and
  // must stay data-free for the same reason the shell is.
  { dir: libDir, file: 'task-workbench-selector-types.ts' },
  { dir: libDir, file: 'task-workbench-identity.ts' },
  { dir: libDir, file: 'task-workbench-usage.ts' },
  { dir: libDir, file: 'task-workbench-join.ts' }
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

  it('keeps the one store reader in the hook, outside the shell source set', () => {
    const shellPaths = storeFreeSources
      .filter((sourceFile) => sourceFile.dir === sourceDir)
      .map((sourceFile) => path.join(sourceFile.dir, sourceFile.file))
    expect(shellPaths).not.toContain(hookPath)

    // readFileSync throws when the hook is missing: existence is part of the contract.
    expect(importSpecifiers(readFileSync(hookPath, 'utf8'))).toContain('@/store')
  })
})
