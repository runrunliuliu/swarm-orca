import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The P1a shell renders a `view` prop and nothing else
 * (`p1a-ui-shell-plan.md` §1, §5 item 6). This is the assertion for that rule:
 * it reads every workbench source file and fails on a store, RPC, IPC, runtime
 * or Electron import, including the exact regression the plan's R18 invites —
 * reaching for `DashboardAgentRow`, which pulls `@/store` in through
 * `useAgentRowConversationName`.
 *
 * Why a source assertion instead of a bundler check: the renderer has no
 * restricted-import rule for these paths, and a module-graph test cannot tell a
 * type-only edge from a value import. Reading the specifiers is the honest,
 * runnable form of "the module dependency list contains no data path".
 */

const sourceDir = import.meta.dirname
const shellSources = [
  'TaskWorkbenchPanel.tsx',
  'TaskWorkbenchHeader.tsx',
  'TaskWorkbenchAgents.tsx',
  'TaskWorkbenchAgentRow.tsx',
  'TaskWorkbenchWorkspaces.tsx',
  'TaskWorkbenchSpend.tsx',
  'TaskWorkbenchDelivery.tsx',
  'task-workbench-view.ts',
  'task-workbench-layout.ts',
  'task-workbench-usage-status.ts',
  'task-workbench-row-projection.ts'
] as const

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

function forbiddenIn(fileName: string): string[] {
  const source = readFileSync(path.join(sourceDir, fileName), 'utf8')
  return importSpecifiers(source).filter((specifier) =>
    FORBIDDEN_SPECIFIERS.some((pattern) => pattern.test(specifier))
  )
}

describe('task workbench import boundary', () => {
  it.each(shellSources)('%s imports no store, RPC, IPC or Electron module', (fileName) => {
    expect(forbiddenIn(fileName)).toEqual([])
  })

  it('keeps the base renderer contained to the one overlay file', () => {
    const baseImporters = shellSources.filter((fileName) =>
      importSpecifiers(readFileSync(path.join(sourceDir, fileName), 'utf8')).some((specifier) =>
        specifier.endsWith('AgentKanbanCard')
      )
    )
    expect(baseImporters).toEqual(['TaskWorkbenchAgentRow.tsx'])
  })
})
