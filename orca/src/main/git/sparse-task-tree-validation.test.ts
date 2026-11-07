import { describe, expect, it } from 'vitest'
import { SparseTaskValidationError } from './sparse-task-input-validation'
import {
  SPARSE_TASK_MAX_TREE_PROBE_BYTES,
  buildSparseTaskTreeProbeArgs,
  parseSparseTaskTreeListing,
  validateSparseTaskDirectoriesAgainstPinnedTree
} from './sparse-task-tree-validation'

const PINNED_SHA = 'a'.repeat(40)
const OBJECT_ID = 'b'.repeat(40)

type ListingEntry = { mode: string; type: string; objectId?: string; path: string }

function treeListing(entries: ListingEntry[]): string {
  return entries
    .map((entry) => `${entry.mode} ${entry.type} ${entry.objectId ?? OBJECT_ID}\t${entry.path}\0`)
    .join('')
}

function treeEntry(path: string): ListingEntry {
  return { mode: '040000', type: 'tree', path }
}

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
  expect(error.message).toContain(code)
  return error
}

describe('parseSparseTaskTreeListing', () => {
  it('parses NUL-separated ls-tree records', () => {
    const stdout = treeListing([
      { mode: '040000', type: 'tree', objectId: 'c'.repeat(40), path: 'cloud/src' },
      { mode: '120000', type: 'blob', objectId: 'd'.repeat(40), path: 'docs site' }
    ])
    expect(parseSparseTaskTreeListing(stdout)).toEqual([
      { mode: '040000', type: 'tree', objectId: 'c'.repeat(40), path: 'cloud/src' },
      { mode: '120000', type: 'blob', objectId: 'd'.repeat(40), path: 'docs site' }
    ])
  })

  it('accepts raw bytes so the caller can pass the runner buffer directly', () => {
    const stdout = new TextEncoder().encode(treeListing([treeEntry('swarm')]))
    expect(parseSparseTaskTreeListing(stdout)).toHaveLength(1)
  })

  it('treats empty output as an empty listing, not an error', () => {
    expect(parseSparseTaskTreeListing('')).toEqual([])
  })

  it.each([
    ['missing tab', `040000 tree ${OBJECT_ID}`],
    ['empty path', `040000 tree ${OBJECT_ID}\t`],
    ['unknown type', `040000 tag ${OBJECT_ID}\tswarm`],
    ['short mode', `0400 tree ${OBJECT_ID}\tswarm`],
    ['non-hex object id', '040000 tree not-an-oid\tswarm']
  ])('rejects a %s record', (_label, record) => {
    expectCode(() => parseSparseTaskTreeListing(`${record}\0`), 'sparse_task_tree_probe_invalid')
  })

  it('rejects duplicate paths instead of resolving one of them', () => {
    const stdout = treeListing([
      treeEntry('swarm'),
      { ...treeEntry('swarm'), objectId: 'e'.repeat(40) }
    ])
    expectCode(() => parseSparseTaskTreeListing(stdout), 'sparse_task_tree_probe_invalid')
  })

  it('rejects oversized probe output rather than truncating it', () => {
    const stdout = treeListing([treeEntry('x'.repeat(SPARSE_TASK_MAX_TREE_PROBE_BYTES + 1))])
    expectCode(() => parseSparseTaskTreeListing(stdout), 'sparse_task_tree_probe_invalid')
  })

  it('rejects non-UTF-8 probe output', () => {
    expectCode(
      () => parseSparseTaskTreeListing(new Uint8Array([0x30, 0x34, 0x30, 0x30, 0x30, 0x30, 0xff])),
      'sparse_task_tree_probe_invalid'
    )
  })
})

describe('validateSparseTaskDirectoriesAgainstPinnedTree', () => {
  it('accepts tree entries and reports them in request order', () => {
    const result = validateSparseTaskDirectoriesAgainstPinnedTree({
      pinnedSha: PINNED_SHA,
      requestedDirectories: ['cloud/src', 'swarm', 'cloud/src'],
      treeEntries: parseSparseTaskTreeListing(
        treeListing([
          treeEntry('swarm'),
          { mode: '040000', type: 'tree', objectId: 'f'.repeat(40), path: 'cloud/src' }
        ])
      )
    })
    expect(result.pinnedSha).toBe(PINNED_SHA)
    expect(result.directories).toEqual(['cloud/src', 'swarm'])
    expect(result.entries).toEqual([
      { path: 'cloud/src', mode: '040000', objectId: 'f'.repeat(40) },
      { path: 'swarm', mode: '040000', objectId: OBJECT_ID }
    ])
  })

  it('never widens the cone to ancestors of a requested path', () => {
    const result = validateSparseTaskDirectoriesAgainstPinnedTree({
      pinnedSha: PINNED_SHA,
      requestedDirectories: ['cloud/src/app'],
      treeEntries: parseSparseTaskTreeListing(treeListing([treeEntry('cloud/src/app')]))
    })
    expect(result.directories).toEqual(['cloud/src/app'])
  })

  it('rejects a path missing from the pinned tree', () => {
    const error = expectCode(
      () =>
        validateSparseTaskDirectoriesAgainstPinnedTree({
          pinnedSha: PINNED_SHA,
          requestedDirectories: ['swarm'],
          treeEntries: []
        }),
      'sparse_task_directory_missing'
    )
    expect(error.message).toContain('"swarm"')
  })

  it.each([
    ['a blob', '100644', 'blob', 'is a blob'],
    ['an executable blob', '100755', 'blob', 'is a blob'],
    ['a symlink', '120000', 'blob', 'is a symlink'],
    ['a gitlink', '160000', 'commit', 'is a gitlink']
  ])('rejects %s', (_label, mode, type, message) => {
    const error = expectCode(
      () =>
        validateSparseTaskDirectoriesAgainstPinnedTree({
          pinnedSha: PINNED_SHA,
          requestedDirectories: ['swarm'],
          treeEntries: parseSparseTaskTreeListing(treeListing([{ mode, type, path: 'swarm' }]))
        }),
      'sparse_task_directory_not_tree'
    )
    expect(error.message).toContain(message)
  })

  it('rejects a malformed request before resolving it against the tree', () => {
    expectCode(
      () =>
        validateSparseTaskDirectoriesAgainstPinnedTree({
          pinnedSha: PINNED_SHA,
          requestedDirectories: ['../escape'],
          treeEntries: parseSparseTaskTreeListing(treeListing([treeEntry('../escape')]))
        }),
      'sparse_task_directory_invalid'
    )
  })

  it('applies the selection limits before any tree resolution', () => {
    const tooMany = Array.from({ length: 129 }, (_, i) => `dir${i}`)
    expectCode(
      () =>
        validateSparseTaskDirectoriesAgainstPinnedTree({
          pinnedSha: PINNED_SHA,
          requestedDirectories: tooMany,
          treeEntries: []
        }),
      'sparse_task_directory_limit_exceeded'
    )
  })

  it.each([
    ['a branch name', 'main'],
    ['an abbreviated sha', 'a'.repeat(39)],
    ['an over-long sha', 'a'.repeat(41)],
    ['an empty string', '']
  ])('refuses %s as the pin', (_label, pinnedSha) => {
    expectCode(
      () =>
        validateSparseTaskDirectoriesAgainstPinnedTree({
          pinnedSha,
          requestedDirectories: ['swarm'],
          treeEntries: parseSparseTaskTreeListing(treeListing([treeEntry('swarm')]))
        }),
      'sparse_task_pinned_sha_invalid'
    )
  })

  it('accepts a sha256-length pin and normalizes case', () => {
    const sha256LengthPin = `${'ABCDEF'.repeat(10)}ABCD`
    const result = validateSparseTaskDirectoriesAgainstPinnedTree({
      pinnedSha: sha256LengthPin,
      requestedDirectories: ['swarm'],
      treeEntries: parseSparseTaskTreeListing(treeListing([treeEntry('swarm')]))
    })
    expect(result.pinnedSha).toBe(sha256LengthPin.toLowerCase())
  })
})

describe('buildSparseTaskTreeProbeArgs', () => {
  it('probes the pinned tree with literal, NUL-safe pathspecs', () => {
    expect(
      buildSparseTaskTreeProbeArgs({
        pinnedSha: PINNED_SHA,
        requestedDirectories: ['swarm', 'docs site', 'a*']
      })
    ).toEqual([
      'ls-tree',
      '-z',
      '--full-tree',
      PINNED_SHA,
      '--',
      ':(literal)swarm',
      ':(literal)docs site',
      ':(literal)a*'
    ])
  })

  it('refuses an empty request', () => {
    expectCode(
      () => buildSparseTaskTreeProbeArgs({ pinnedSha: PINNED_SHA, requestedDirectories: [] }),
      'sparse_task_directory_invalid'
    )
  })

  it('refuses a moving ref as the pin', () => {
    expectCode(
      () => buildSparseTaskTreeProbeArgs({ pinnedSha: 'HEAD', requestedDirectories: ['swarm'] }),
      'sparse_task_pinned_sha_invalid'
    )
  })
})
