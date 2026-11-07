// Why (M2): a requested sparse directory is only valid when the pinned commit tree holds a real
// tree entry at that path. This module is pure: the caller runs one bounded `ls-tree` read and
// hands the raw output here, so every rejection happens before a worktree is created.

import {
  SPARSE_TASK_MAX_DIRECTORY_COUNT,
  SparseTaskValidationError,
  parseSparseTaskDirectories
} from './sparse-task-input-validation'

/** Bounded probe output. 128 selections cannot legitimately produce more than a few KiB. */
export const SPARSE_TASK_MAX_TREE_PROBE_BYTES = 64 * 1024
export const SPARSE_TASK_MAX_TREE_PROBE_ENTRIES = SPARSE_TASK_MAX_DIRECTORY_COUNT * 4

export type SparseTaskTreeEntry = {
  /** Six octal digits, e.g. `040000`, `100644`, `120000`, `160000`. */
  mode: string
  /** `tree` | `blob` | `commit` as reported by `ls-tree`. */
  type: string
  objectId: string
  path: string
}

export type SparseTaskTreeDirectoryEntry = {
  path: string
  mode: string
  objectId: string
}

export type SparseTaskDirectoryTreeCheck = {
  pinnedSha: string
  /** Strictly parsed request cone, first-occurrence order, deduplicated. */
  directories: string[]
  /** Resolved tree entries, in `directories` order — evidence for the M1 receipt. */
  entries: SparseTaskTreeDirectoryEntry[]
}

const FULL_COMMIT_SHA_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
const TREE_HEADER_PATTERN = /^(\d{6}) (tree|blob|commit) ([0-9a-f]{4,64})$/
const utf8Encoder = new TextEncoder()
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

/** M0 pins a full commit SHA; a ref or abbreviated id would move under us, so refuse it here.
 *  Returned lowercase, matching what Git prints, so later HEAD comparisons are byte-equal. */
export function assertSparseTaskPinnedSha(pinnedSha: string): string {
  if (!FULL_COMMIT_SHA_PATTERN.test(pinnedSha)) {
    throw new SparseTaskValidationError(
      'sparse_task_pinned_sha_invalid',
      `Expected a full commit SHA, got ${JSON.stringify(pinnedSha.slice(0, 80))}.`
    )
  }
  return pinnedSha.toLowerCase()
}

/**
 * `git ls-tree -z --full-tree <pinnedSha> -- :(literal)<path>…`
 *
 * `--full-tree` because the read may run from a subdirectory; `-z` because Git otherwise
 * C-quotes paths and we would compare against the wrong string; `:(literal)` because a directory
 * named `a*` must not be matched by the pathspec as a glob. Nothing here is executed by this
 * module — wiring passes the argv to the existing host-aware Git runner.
 */
export function buildSparseTaskTreeProbeArgs(input: {
  pinnedSha: string
  requestedDirectories: readonly string[]
}): string[] {
  const pinnedSha = assertSparseTaskPinnedSha(input.pinnedSha)
  const directories = parseSparseTaskDirectories(input.requestedDirectories)
  return [
    'ls-tree',
    '-z',
    '--full-tree',
    pinnedSha,
    '--',
    ...directories.map((directory) => `:(literal)${directory}`)
  ]
}

function listingBytes(stdout: string | Uint8Array): Uint8Array {
  return typeof stdout === 'string' ? utf8Encoder.encode(stdout) : stdout
}

/** Parses NUL-separated `ls-tree -z` output. Anything unexpected is a malformed probe, not an
 *  empty tree: failing closed keeps a truncated read from looking like "all paths missing". */
export function parseSparseTaskTreeListing(stdout: string | Uint8Array): SparseTaskTreeEntry[] {
  const bytes = listingBytes(stdout)
  if (bytes.byteLength > SPARSE_TASK_MAX_TREE_PROBE_BYTES) {
    throw new SparseTaskValidationError(
      'sparse_task_tree_probe_invalid',
      `Tree probe output is ${bytes.byteLength} bytes; at most ${SPARSE_TASK_MAX_TREE_PROBE_BYTES} allowed.`
    )
  }
  let text: string
  try {
    text = strictUtf8Decoder.decode(bytes)
  } catch {
    throw new SparseTaskValidationError(
      'sparse_task_tree_probe_invalid',
      'Tree probe output is not valid UTF-8.'
    )
  }
  const entries: SparseTaskTreeEntry[] = []
  const seenPaths = new Set<string>()
  for (const record of text.split('\0')) {
    if (record.length === 0) {
      continue
    }
    const tabIndex = record.indexOf('\t')
    const header = tabIndex === -1 ? '' : record.slice(0, tabIndex)
    const path = tabIndex === -1 ? '' : record.slice(tabIndex + 1)
    const headerMatch = TREE_HEADER_PATTERN.exec(header)
    if (!headerMatch || path.length === 0) {
      throw new SparseTaskValidationError(
        'sparse_task_tree_probe_invalid',
        `Unparsable tree probe record: ${JSON.stringify(record.slice(0, 160))}`
      )
    }
    if (seenPaths.has(path)) {
      throw new SparseTaskValidationError(
        'sparse_task_tree_probe_invalid',
        `Tree probe returned ${JSON.stringify(path)} twice.`
      )
    }
    seenPaths.add(path)
    entries.push({ mode: headerMatch[1], type: headerMatch[2], objectId: headerMatch[3], path })
    if (entries.length > SPARSE_TASK_MAX_TREE_PROBE_ENTRIES) {
      throw new SparseTaskValidationError(
        'sparse_task_tree_probe_invalid',
        `Tree probe returned more than ${SPARSE_TASK_MAX_TREE_PROBE_ENTRIES} entries.`
      )
    }
  }
  return entries
}

function treeEntryRejection(entry: SparseTaskTreeEntry): string | undefined {
  if (entry.mode === '160000' || entry.type === 'commit') {
    return 'is a gitlink (submodule) in the pinned tree'
  }
  if (entry.mode === '120000') {
    return 'is a symlink in the pinned tree'
  }
  if (entry.type === 'blob') {
    return 'is a blob (file) in the pinned tree, not a directory'
  }
  if (entry.mode === '040000' && entry.type === 'tree') {
    return undefined
  }
  return `has an unsupported pinned-tree entry (mode ${entry.mode}, type ${entry.type})`
}

/**
 * Resolves every requested directory against the pinned tree read. Accepts tree entries only;
 * a missing path, blob, symlink or gitlink fails the whole request. Ancestor directories are
 * never added — a cone is exactly what was requested or the request fails.
 */
export function validateSparseTaskDirectoriesAgainstPinnedTree(input: {
  pinnedSha: string
  requestedDirectories: readonly string[]
  treeEntries: readonly SparseTaskTreeEntry[]
}): SparseTaskDirectoryTreeCheck {
  const pinnedSha = assertSparseTaskPinnedSha(input.pinnedSha)
  const directories = parseSparseTaskDirectories(input.requestedDirectories)
  const entriesByPath = new Map<string, SparseTaskTreeEntry>()
  for (const entry of input.treeEntries) {
    if (entriesByPath.has(entry.path)) {
      throw new SparseTaskValidationError(
        'sparse_task_tree_probe_invalid',
        `Tree probe returned ${JSON.stringify(entry.path)} twice.`
      )
    }
    entriesByPath.set(entry.path, entry)
  }
  const entries: SparseTaskTreeDirectoryEntry[] = []
  for (const directory of directories) {
    const entry = entriesByPath.get(directory)
    if (!entry) {
      throw new SparseTaskValidationError(
        'sparse_task_directory_missing',
        `${JSON.stringify(directory)} does not exist in pinned commit ${pinnedSha}.`
      )
    }
    const rejection = treeEntryRejection(entry)
    if (rejection) {
      throw new SparseTaskValidationError(
        'sparse_task_directory_not_tree',
        `${JSON.stringify(directory)} ${rejection}.`
      )
    }
    entries.push({ path: entry.path, mode: entry.mode, objectId: entry.objectId })
  }
  return { pinnedSha, directories, entries }
}
