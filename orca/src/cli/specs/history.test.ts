import { describe, expect, it } from 'vitest'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { formatGroupHelp } from '../help'
import { COMMAND_SPECS } from './index'
import { HISTORY_COMMAND_SPECS } from './history'

const spec = HISTORY_COMMAND_SPECS[0]!

describe('history backfill discovery', () => {
  it('is registered with the specs index and no sibling shadows it', () => {
    expect(COMMAND_SPECS).toContain(spec)
    expect(spec.path).toEqual(['history', 'backfill'])
    expect(
      COMMAND_SPECS.filter((entry) => entry.path.join(' ') === 'history backfill')
    ).toHaveLength(1)
  })

  it.each([
    { argv: ['history', 'backfill', '--task', 'repo-1#53'] },
    { argv: ['--task', 'repo-1#53', 'history', 'backfill'] },
    { argv: ['--task=repo-1#53', 'history', 'backfill'] },
    { argv: ['history', '--json', 'backfill', '--task', 'repo-1#53'] }
  ])('parses $argv', ({ argv }) => {
    const parsed = parseArgs(argv)
    expect(parsed.commandPath).toEqual(['history', 'backfill'])
    expect(parsed.flags.get('task')).toBe('repo-1#53')
    expect(() => validateCommandAndFlags(HISTORY_COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('rejects a flag the command does not declare', () => {
    const parsed = parseArgs(['history', 'backfill', '--task', 'repo-1#53', '--apply'])
    expect(() => validateCommandAndFlags(HISTORY_COMMAND_SPECS, parsed)).toThrow(/--apply/)
  })

  it('documents the offline precondition, the accepted repo forms and the repeat rule', () => {
    expect(spec.usage).toBe('orca history backfill --task <repo>#<number> [--json]')
    const notes = (spec.notes ?? []).join('\n')
    expect(notes).toContain('repo id')
    expect(notes).toContain('checkout path')
    expect(notes).toContain('Orca must be stopped')
    expect(notes).toContain('never automatic')
    expect(notes).toContain('writes nothing at all')
    // R3: the note must separate "re-run" (a no-op: nothing is selected) from a
    // re-observation (which is where the window union applies).
    expect(notes).toContain('re-running is a no-op')
    expect(notes).toContain('does not even scan')
    expect(notes).toContain('re-observation')
    expect(notes).not.toContain('Re-running after more evidence exists only advances')
    // R1: the help states the load-trim refusal instead of promising a write.
    expect(notes).toContain('the discard is reported and nothing is written')
    // The help must not promise a usage figure this command cannot measure.
    expect(notes).toContain('tokens stay unknown')
    expect(spec.group).toBe('maintenance')
    expect(spec.examples).toContain('orca history backfill --task repo-1#53 --json')
  })
})

describe('history task discovery and positional parsing', () => {
  const taskSpec = HISTORY_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'history task')!

  it('is registered with the specs index and is the only history task spec', () => {
    expect(COMMAND_SPECS).toContain(taskSpec)
    expect(taskSpec.path).toEqual(['history', 'task'])
    expect(COMMAND_SPECS.filter((entry) => entry.path.join(' ') === 'history task')).toHaveLength(1)
    expect(taskSpec.group).toBe('maintenance')
    expect(taskSpec.positionalArgs).toEqual(['task'])
  })

  it.each([
    { argv: ['history', 'task', 'repo-1#53'] },
    { argv: ['--json', 'history', 'task', 'repo-1#53'] },
    { argv: ['history', '--json', 'task', 'repo-1#53'] },
    { argv: ['history', 'task', 'id:repo-1#7'] },
    { argv: ['history', 'task', 'path:/repos/app#31'] },
    // The number is taken from the last `#`, so a checkout path may contain one.
    { argv: ['history', 'task', '/repos/a#b#9'] }
  ])('parses $argv and leaves the value in --task', ({ argv }) => {
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
    expect(parsed.commandPath).toEqual(['history', 'task'])
    expect(parsed.flags.get('task')).toBe(argv.at(-1))
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('rejects a flag the command does not declare', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['history', 'task', 'repo-1#53', '--apply'])
    )
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).toThrow(/--apply/)
  })

  it('documents that this is a read-only export, not a backfill', () => {
    expect(taskSpec.usage).toBe('orca history task <repo>#<number> [--json]')
    const notes = (taskSpec.notes ?? []).join('\n')
    expect(notes).toContain('Read-only export')
    expect(notes).toContain('writes nothing')
    expect(notes).toContain('no runtime RPC')
    expect(notes).toContain('repo id')
    expect(notes).toContain('checkout path')
    expect(notes).toContain('never `0` or `$0`')
    expect(notes).toContain('trace` is one of `archived`, `deleted`, or `none`')
    expect(notes).toContain('transcript content is never read or printed')
    expect(notes).toContain('use `orca history backfill`')
    expect(taskSpec.examples).toContain('orca history task repo-1#53 --json')
  })
})

describe('history group help', () => {
  it('lists task next to backfill and says which one is read-only', () => {
    const help = formatGroupHelp(COMMAND_SPECS, ['history'])
    expect(help).toContain('task')
    expect(help).toContain('backfill')
    expect(help).toContain('read-only')
    expect(help).toContain('Backfill agent runs')
  })
})
