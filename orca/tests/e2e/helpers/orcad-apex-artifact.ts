import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync
} from 'node:fs'
import path from 'node:path'

/**
 * The read-only side of the apex helper: fingerprint the artifact an e2e case copies, copy it, and
 * prove afterwards that nothing wrote into the original.
 *
 * Why this exists at all: `ORCA_BUILD_POINTER_PATH` only moves the pointer. Publishing still rewrites
 * the install root's own `.orca-build.json` and `.orca-cli-argv`
 * (`src/main/cli/build-pointer.ts:209-210`), so launching a production artifact in place stamps the
 * test's `publishedAt`/publisher pid into a directory the test only means to read.
 */

/** One file of the source artifact whose bytes must not change during a case. */
export type ApexSourceFileWitness = {
  /** Path relative to the artifact root. */
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly sha256: string
}

/**
 * Fingerprint of the artifact the host copies: the directory it resolves to, the pointer link if the
 * caller named one (so a `/opt/orca/current`-style path is witnessed as a link too), and key bytes.
 */
export type ApexSourceWitness = {
  /** The path the caller configured, kept verbatim so the symlink is part of the evidence. */
  readonly configuredPath: string
  readonly dir: string
  readonly link: { readonly target: string; readonly mtimeMs: number; readonly ino: number } | null
  readonly files: readonly ApexSourceFileWitness[]
}

/** What `copyApexArtifact` produced; reported as evidence so a report can name the launched tree. */
export type ApexArtifactCopy = {
  readonly dir: string
  readonly fileCount: number
  readonly byteCount: number
}

/** Test seam: the unit test replaces the copier to avoid moving a real 130 MB artifact per case. */
export type ApexArtifactCopier = (request: {
  sourceDir: string
  destinationDir: string
}) => ApexArtifactCopy

/**
 * Files whose bytes the test must not change. `orcad.js` alone is not enough: publishing rewrites
 * `.orca-build.json` / `.orca-cli-argv` in the install root, which is exactly what went unnoticed
 * before, so the provenance files are witnesses too.
 */
const SOURCE_WITNESS_FILES = [
  '.orca-build.json',
  '.orca-cli-argv',
  '.version',
  '.build-target',
  'package.json',
  'orcad.js',
  'cli/index.cjs',
  'bun-runtime'
] as const

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function countTree(dir: string): { fileCount: number; byteCount: number } {
  let fileCount = 0
  let byteCount = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = countTree(fullPath)
      fileCount += nested.fileCount
      byteCount += nested.byteCount
    } else {
      fileCount += 1
      byteCount += statSync(fullPath).size
    }
  }
  return { fileCount, byteCount }
}

/** Fingerprint the artifact (and the pointer link, when one was named) before the host starts. */
export function witnessApexSource(configuredPath: string): ApexSourceWitness {
  const configured = path.resolve(configuredPath)
  const linkStats = lstatSync(configured)
  const link = linkStats.isSymbolicLink()
    ? { target: readlinkSync(configured), mtimeMs: linkStats.mtimeMs, ino: linkStats.ino }
    : null
  const dir = realpathSync(configured)
  const files = SOURCE_WITNESS_FILES.flatMap((name) => {
    const filePath = path.join(dir, name)
    if (!existsSync(filePath)) {
      return []
    }
    const stats = statSync(filePath)
    return [{ path: name, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256File(filePath) }]
  })
  return { configuredPath: configured, dir, link, files }
}

/**
 * Re-read the artifact and fail when anything the host only reads has changed. Called from
 * `dispose()`; also usable as evidence right after a case.
 */
export function assertApexSourceUnchanged(expected: ApexSourceWitness): ApexSourceWitness {
  const actual = witnessApexSource(expected.configuredPath)
  const problems: string[] = []
  if (actual.dir !== expected.dir) {
    problems.push(`artifact root moved: ${expected.dir} -> ${actual.dir}`)
  }
  if (JSON.stringify(actual.link) !== JSON.stringify(expected.link)) {
    problems.push(
      `build pointer link changed: ${JSON.stringify(expected.link)} -> ${JSON.stringify(actual.link)}`
    )
  }
  for (const file of expected.files) {
    const now = actual.files.find((candidate) => candidate.path === file.path)
    if (!now) {
      problems.push(`${file.path} disappeared`)
      continue
    }
    if (now.size !== file.size || now.mtimeMs !== file.mtimeMs || now.sha256 !== file.sha256) {
      problems.push(
        `${file.path} changed: ${JSON.stringify(file)} -> ${JSON.stringify(now)} (publishing writes install-root metadata at startup)`
      )
    }
  }
  for (const file of actual.files) {
    if (!expected.files.some((candidate) => candidate.path === file.path)) {
      problems.push(`${file.path} appeared`)
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `the e2e host wrote into the artifact it only reads (${expected.dir}):\n${problems.join('\n')}`
    )
  }
  return actual
}

/**
 * Copy the whole artifact so the child's install root is ours. `dereference` turns any link in the
 * artifact into a real file, and the inode check rejects a copy that is secretly a hardlink.
 */
export function copyApexArtifact(request: {
  sourceDir: string
  destinationDir: string
}): ApexArtifactCopy {
  const { sourceDir, destinationDir } = request
  mkdirSync(destinationDir, { recursive: true })
  cpSync(sourceDir, destinationDir, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    force: true
  })
  for (const name of ['orcad.js', 'bun-runtime', 'cli/index.cjs']) {
    const source = statSync(path.join(sourceDir, name), { throwIfNoEntry: false })
    const copied = statSync(path.join(destinationDir, name), { throwIfNoEntry: false })
    if (!source?.isFile() || !copied?.isFile()) {
      throw new Error(`apex copy lost ${name}: ${sourceDir} -> ${destinationDir}`)
    }
    if (source.dev === copied.dev && source.ino === copied.ino) {
      throw new Error(
        `apex copy of ${name} shares an inode with the source: that is a link, not a copy of ${sourceDir}`
      )
    }
  }
  return { dir: destinationDir, ...countTree(destinationDir) }
}
