import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { excludeDraftsFromCounts, isDraftExcludedFromCounts } from './task-draft-count-exclusion'

describe('task draft count exclusion', () => {
  it.each([
    [{}, false],
    [{ taskDraft: false }, false],
    [{ taskDraft: true }, true]
  ])('returns the exclusion decision for %o', (workspace, expected) => {
    expect(isDraftExcludedFromCounts(workspace)).toBe(expected)
  })

  it('removes only task drafts and preserves the remaining items', () => {
    const normal = { id: 'normal', taskDraft: false }
    const legacy = { id: 'legacy' }
    const draft = { id: 'draft', taskDraft: true }

    expect(excludeDraftsFromCounts([normal, draft, legacy])).toEqual([normal, legacy])
  })
})

describe('task draft count exclusion call sites', () => {
  it('keeps direct taskDraft property access inside the selector module', () => {
    const callSites = [
      'src/renderer/src/components/sidebar/worktree-list/grouping/host-labels.ts',
      'src/renderer/src/components/sidebar/host-section-rows.ts',
      'src/renderer/src/components/sidebar/smart-sort.ts',
      'src/renderer/src/components/dashboard/dashboard-snapshot-workspaces.ts'
    ]
    const offendingLines: string[] = []

    for (const file of callSites) {
      const lines = readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/\.taskDraft\b/.test(line)) {
          offendingLines.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      })
    }

    expect(
      offendingLines,
      `Direct taskDraft access must use task-draft-count-exclusion:\n${offendingLines.join('\n')}`
    ).toEqual([])
  })
})
