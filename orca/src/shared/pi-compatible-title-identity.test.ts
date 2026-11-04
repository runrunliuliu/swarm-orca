import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, getAgentLabel } from './agent-detection'
import { normalizeCompatibleAgentTitleForOwner } from './agent-title-owner'

describe('Pi-compatible semantic title identity', () => {
  // The remote pane reported Pi - example_repo; native π/spinner forms come from Orca's title extension.
  it.each(['pi', 'omp'] as const)(
    'preserves %s identity through repeated owner rewrites',
    (owner) => {
      const label = owner === 'pi' ? 'Pi' : 'OMP'
      for (const [title, status] of [
        ['π - example_repo', 'idle'],
        ['π - session - example_repo', 'idle'],
        ['⠋ π - session - example_repo', 'working'],
        ['π: example_repo', 'idle'],
        ['π > example_repo', 'idle'],
        ['π ! example_repo', 'permission']
      ] as const) {
        const normalized = normalizeCompatibleAgentTitleForOwner(title, owner)
        expect(getAgentLabel(normalized)).toBe(label)
        expect(detectAgentStatusFromTitle(normalized)).toBe(status)
        expect(normalized).toBe(title.replace('π', label))
        expect(normalizeCompatibleAgentTitleForOwner(normalized, owner)).toBe(normalized)
      }
    }
  )

  it.each([
    ['Pi - example_repo', 'omp', 'OMP - example_repo'],
    ['OMP - example_repo', 'pi', 'Pi - example_repo'],
    ['zsh | Pi - session - example_repo', 'omp', 'zsh | OMP - session - example_repo'],
    ['⠋ OMP - session - example_repo', 'pi', '⠋ Pi - session - example_repo']
  ] as const)('re-owns %s without dropping the label', (title, owner, expected) => {
    expect(normalizeCompatibleAgentTitleForOwner(title, owner)).toBe(expected)
  })

  it.each([
    'pi - refactor the parser',
    'omp - deploy notes',
    'Pi-scratch',
    'OMP-harness',
    'Pi -not-a-delimiter',
    'pipeline - build'
  ])('does not invent an identity for %s', (title) => {
    expect(getAgentLabel(title)).toBeNull()
    expect(normalizeCompatibleAgentTitleForOwner(title, 'pi')).toBe(title)
  })
})
