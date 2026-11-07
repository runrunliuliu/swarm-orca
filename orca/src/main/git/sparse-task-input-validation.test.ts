import { describe, expect, it } from 'vitest'
import {
  SPARSE_TASK_MAX_DIRECTORY_COUNT,
  SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES,
  SPARSE_TASK_MAX_REQUIRED_PATH_COUNT,
  SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES,
  SparseTaskValidationError,
  parseSparseTaskDirectories,
  parseSparseTaskRequiredPaths,
  sparseTaskUtf8ByteLength
} from './sparse-task-input-validation'

function thrownBy(run: () => unknown): SparseTaskValidationError {
  try {
    run()
  } catch (error) {
    if (error instanceof SparseTaskValidationError) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to throw')
}

function expectCode(run: () => unknown, code: string): SparseTaskValidationError {
  const error = thrownBy(run)
  expect(error.code).toBe(code)
  // Why: the create error channel may only carry `message` (M0), so the code must be in it.
  expect(error.message).toContain(code)
  return error
}

describe('parseSparseTaskDirectories', () => {
  it('keeps request order and preserves interior spaces, unicode, dots and hyphens', () => {
    expect(
      parseSparseTaskDirectories(['cloud/src', 'docs site', '文档', '.github', 'a-b_c'])
    ).toEqual(['cloud/src', 'docs site', '文档', '.github', 'a-b_c'])
  })

  it('normalizes separators and dedupes by first occurrence only', () => {
    expect(parseSparseTaskDirectories(['b', 'a\\b', 'a/b', 'b', 'c'])).toEqual(['b', 'a/b', 'c'])
  })

  it.each([
    ['empty entry', ''],
    ['whitespace only', '   '],
    ['leading space', ' swarm'],
    ['trailing space', 'swarm '],
    ['dot', '.'],
    ['dot prefix segment', './swarm'],
    ['inner dot segment', 'swarm/./orca'],
    ['parent segment', '..'],
    ['trailing parent segment', 'swarm/..'],
    ['inner parent segment', 'swarm/../orca'],
    ['absolute posix', '/swarm'],
    ['absolute unc', '\\\\server\\share'],
    ['windows drive', 'C:/swarm'],
    ['windows drive-relative', 'c:swarm'],
    ['nul', 'swarm\u0000orca'],
    ['control character', 'swarm\u0001orca'],
    ['newline', 'swarm\norca'],
    ['tab', 'swarm\torca'],
    ['empty segment', 'swarm//orca'],
    ['trailing separator', 'swarm/'],
    ['escape after normalization', 'swarm\\..\\orca']
  ])('rejects %s', (_label, entry) => {
    expectCode(() => parseSparseTaskDirectories([entry]), 'sparse_task_directory_invalid')
  })

  it('rejects non-string entries from an untyped payload', () => {
    const input: string[] = ['swarm']
    // @ts-expect-error -- an untyped wire payload can carry a non-string member.
    input.push(42)
    expectCode(() => parseSparseTaskDirectories(input), 'sparse_task_directory_invalid')
  })

  it('requires at least one directory', () => {
    expectCode(() => parseSparseTaskDirectories([]), 'sparse_task_directory_invalid')
  })

  it('accepts exactly the directory count limit and rejects one more', () => {
    const atLimit = Array.from({ length: SPARSE_TASK_MAX_DIRECTORY_COUNT }, (_, i) => `dir${i}`)
    expect(parseSparseTaskDirectories(atLimit)).toHaveLength(SPARSE_TASK_MAX_DIRECTORY_COUNT)
    expectCode(
      () => parseSparseTaskDirectories([...atLimit, 'dir-extra']),
      'sparse_task_directory_limit_exceeded'
    )
  })

  it('applies the count limit before deduplication', () => {
    const repeated = Array.from({ length: SPARSE_TASK_MAX_DIRECTORY_COUNT + 1 }, () => 'swarm')
    expectCode(() => parseSparseTaskDirectories(repeated), 'sparse_task_directory_limit_exceeded')
  })

  it('accepts exactly the UTF-8 byte limit and rejects one byte more', () => {
    const atLimit = 'x'.repeat(SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES)
    expect(parseSparseTaskDirectories([atLimit])).toEqual([atLimit])
    expectCode(
      () => parseSparseTaskDirectories([`${atLimit}y`]),
      'sparse_task_directory_limit_exceeded'
    )
  })

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const wide = '文'.repeat(SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES / 3 + 1)
    expect(sparseTaskUtf8ByteLength(wide)).toBeGreaterThan(SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES)
    expectCode(() => parseSparseTaskDirectories([wide]), 'sparse_task_directory_limit_exceeded')
  })

  it('sums the byte limit across directories even when the count is small', () => {
    const entry = 'y'.repeat(SPARSE_TASK_MAX_DIRECTORY_UTF8_BYTES / 2 + 1)
    expectCode(
      () => parseSparseTaskDirectories([entry, `${entry}z`]),
      'sparse_task_directory_limit_exceeded'
    )
  })
})

describe('parseSparseTaskRequiredPaths', () => {
  it('accepts an empty declaration', () => {
    expect(parseSparseTaskRequiredPaths([])).toEqual([])
  })

  it('accepts instruction, skill and build-config paths in request order', () => {
    expect(
      parseSparseTaskRequiredPaths([
        'AGENTS.md',
        '.agents/skills/swarm-orchestration/SKILL.md',
        'package.json',
        'AGENTS.md'
      ])
    ).toEqual(['AGENTS.md', '.agents/skills/swarm-orchestration/SKILL.md', 'package.json'])
  })

  it.each([
    ['empty entry', ''],
    ['dot', '.'],
    ['parent segment', '../AGENTS.md'],
    ['absolute', '/AGENTS.md'],
    ['windows drive', 'C:AGENTS.md'],
    ['control character', 'AGENTS\u0007.md'],
    ['trailing separator', 'swarm/']
  ])('rejects %s', (_label, entry) => {
    expectCode(() => parseSparseTaskRequiredPaths([entry]), 'sparse_task_required_path_invalid')
  })

  it('enforces the count limit', () => {
    const atLimit = Array.from({ length: SPARSE_TASK_MAX_REQUIRED_PATH_COUNT }, (_, i) => `f${i}`)
    expect(parseSparseTaskRequiredPaths(atLimit)).toHaveLength(SPARSE_TASK_MAX_REQUIRED_PATH_COUNT)
    expectCode(
      () => parseSparseTaskRequiredPaths([...atLimit, 'f-extra']),
      'sparse_task_required_path_invalid'
    )
  })

  it('enforces the UTF-8 byte limit', () => {
    const atLimit = 'r'.repeat(SPARSE_TASK_MAX_REQUIRED_PATH_UTF8_BYTES)
    expect(parseSparseTaskRequiredPaths([atLimit])).toEqual([atLimit])
    expectCode(
      () => parseSparseTaskRequiredPaths([`${atLimit}r`]),
      'sparse_task_required_path_invalid'
    )
  })
})
