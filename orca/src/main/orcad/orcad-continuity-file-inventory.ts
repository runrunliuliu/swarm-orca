import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { continuityFileIdentity } from './orcad-continuity-file-identity'

export const ContinuityInventoryScope = z
  .object({
    monitorStateRoot: z.string().min(1),
    continuationStateRoot: z.string().min(1),
    files: z.array(z.string().min(1)).min(1).max(256)
  })
  .strict()
export type ContinuityInventoryScope = z.infer<typeof ContinuityInventoryScope>

const limits = {
  entries: 10_000,
  depth: 32,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024
}

function refuse(reason: string): never {
  throw new Error(`orcad_continuity_inventory_refused: ${reason}`)
}

function canonicalPath(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    refuse('canonical nonsymlink path required')
  }
  return path
}

function within(path: string, root: string) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function fileVersion(info: ReturnType<typeof privateStat>) {
  return [
    info.dev,
    info.ino,
    info.uid,
    info.mode,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs
  ]
    .map(String)
    .join(':')
}

function privateStat(path: string, directory: boolean) {
  canonicalPath(path)
  const identity = continuityFileIdentity(path, directory)
  const info = lstatSync(path, { bigint: true })
  if (
    !(directory ? info.isDirectory() : info.isFile()) ||
    (!directory && info.nlink !== 1n) ||
    String(info.dev) !== identity.device ||
    String(info.ino) !== identity.inode ||
    (info.mode & 0o077n) !== 0n ||
    String(info.uid) !== String(process.getuid?.())
  ) {
    refuse('unaliased regular file or directory required')
  }
  return info
}

function readFilePin(path: string, remaining: number) {
  const before = privateStat(path, false)
  if (before.size > BigInt(limits.fileBytes) || before.size > BigInt(remaining)) {
    refuse('file or total byte limit exceeded')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (fileVersion(fstatSync(fd, { bigint: true })) !== fileVersion(before)) {
      refuse('file changed before read')
    }
    const sizeBytes = Number(before.size)
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(Math.min(sizeBytes, 64 * 1024))
    let offset = 0
    while (offset < sizeBytes) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset)
      if (count === 0) {
        refuse('file truncated during read')
      }
      hash.update(buffer.subarray(0, count))
      offset += count
    }
    if (
      fileVersion(fstatSync(fd, { bigint: true })) !== fileVersion(before) ||
      fileVersion(privateStat(path, false)) !== fileVersion(before)
    ) {
      refuse('file changed during read')
    }
    return {
      path,
      kind: 'file' as const,
      device: String(before.dev),
      inode: String(before.ino),
      version: fileVersion(before),
      sizeBytes,
      fileSha256: hash.digest('hex')
    }
  } finally {
    closeSync(fd)
  }
}

/** Source observations only: callers must separately establish scope authority and writer exclusion. */
export function continuityFileInventory(input: ContinuityInventoryScope) {
  const scope = ContinuityInventoryScope.parse(input)
  const roots = [scope.monitorStateRoot, scope.continuationStateRoot].map(canonicalPath)
  const files = scope.files.map(canonicalPath).sort()
  if (
    within(roots[0], roots[1]) ||
    within(roots[1], roots[0]) ||
    new Set(files).size !== files.length
  ) {
    refuse('overlapping state roots or duplicate file paths')
  }
  const normalizedScope = { ...scope, files }
  const directories: {
    path: string
    kind: 'directory'
    device: string
    inode: string
    mode: string
  }[] = []
  const entries: ReturnType<typeof readFilePin>[] = []
  const directoryVersions = new Map<string, string>()
  let totalBytes = 0
  function countEntry() {
    if (directories.length + entries.length >= limits.entries) {
      refuse('entry limit exceeded')
    }
  }
  function readFile(path: string) {
    countEntry()
    const entry = readFilePin(path, limits.totalBytes - totalBytes)
    totalBytes += entry.sizeBytes
    entries.push(entry)
  }
  function walk(path: string, depth: number) {
    if (depth > limits.depth) {
      refuse('directory depth limit exceeded')
    }
    countEntry()
    const before = privateStat(path, true)
    directoryVersions.set(path, fileVersion(before))
    directories.push({
      path,
      kind: 'directory',
      device: String(before.dev),
      inode: String(before.ino),
      mode: String(before.mode)
    })
    const names = readdirSync(path).sort()
    if (names.length > limits.entries - directories.length - entries.length) {
      refuse('entry limit exceeded')
    }
    for (const name of names) {
      const child = join(path, name)
      if (lstatSync(child).isDirectory()) {
        walk(child, depth + 1)
      } else {
        readFile(child)
      }
    }
    if (
      fileVersion(privateStat(path, true)) !== fileVersion(before) ||
      hashCanonical(readdirSync(path).sort()) !== hashCanonical(names)
    ) {
      refuse('directory changed during read')
    }
  }
  roots.forEach((root) => walk(root, 0))
  for (const file of files) {
    if (!roots.some((root) => within(file, root))) {
      readFile(file)
    } else if (!entries.some((entry) => entry.path === file)) {
      refuse('explicit reference is not a regular file')
    }
  }
  for (const entry of entries) {
    if (fileVersion(privateStat(entry.path, false)) !== entry.version) {
      refuse('file changed during inventory')
    }
  }
  for (const [path, version] of directoryVersions) {
    if (fileVersion(privateStat(path, true)) !== version) {
      refuse('directory changed during inventory')
    }
  }
  const inventory = {
    schemaVersion: 1 as const,
    scope: normalizedScope,
    directories,
    files: entries
  }
  return {
    inventory,
    inventoryCanonicalSha256: hashCanonical(inventory),
    executionAuthorized: false as const
  }
}
