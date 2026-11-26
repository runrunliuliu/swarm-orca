/**
 * Provenance readers for `writeEvidencePackage`: the dirty-input identity, the command's specs and
 * build bytes. Split out of the writer only to stay inside the file-length budget; every reader is
 * shared and no state lives here.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type HashedFile = { path: string; bytes: number; sha256: string }

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function hashFile(file: string): Promise<Omit<HashedFile, 'path'>> {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    stream.once('error', reject)
    stream.once('end', resolvePromise)
  })
  return { bytes, sha256: hash.digest('hex') }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

async function hashWorktreePath(root: string, file: string): Promise<string | null> {
  const fullPath = resolve(root, file)
  try {
    const details = await lstat(fullPath)
    if (details.isSymbolicLink()) {
      return sha256(await readlink(fullPath))
    }
    if (!details.isFile()) {
      return null
    }
    return (await hashFile(fullPath)).sha256
  } catch {
    return null
  }
}

/**
 * Dirty-input identity. `git status`/`git diff` run from the repository top level and every path is
 * resolved against it, because a subdirectory `cwd` used to leave every `sha256` null (the printed
 * paths are repository-relative while the old code resolved them against `cwd`). The staged and
 * unstaged patch is returned with its bytes so the caller can ship it: a hash over a diff nobody
 * can open does not let a reader reproduce the inputs.
 */
export async function readDirty(topLevel: string, specSha256: string, artefacts: HashedFile[]) {
  const raw = await git(topLevel, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const tokens = raw.split('\0')
  const tracked: { file: string; status: string; sha256: string | null }[] = []
  const untracked: { file: string; sha256: string | null }[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      continue
    }
    const status = token.slice(0, 2)
    const file = token.slice(3)
    const entry = { file, sha256: await hashWorktreePath(topLevel, file) }
    if (status === '??') {
      untracked.push(entry)
    } else {
      tracked.push({ ...entry, status })
    }
    if (status.includes('R') || status.includes('C')) {
      index += 1
    }
  }

  const [unstagedPatch, stagedPatch] = await Promise.all([
    git(topLevel, ['diff', '--binary', '--no-ext-diff', '--']),
    git(topLevel, ['diff', '--cached', '--binary', '--no-ext-diff', '--'])
  ])
  const patchBytes = Buffer.from(`${stagedPatch}\n${unstagedPatch}`, 'utf8')
  return {
    tracked,
    untracked,
    patch: { bytes: patchBytes.length, sha256: sha256(patchBytes) },
    patchBytes,
    artefacts,
    specSha256
  }
}

function commandSpecPaths(command: string): string[] {
  const paths = new Set<string>()
  const matches = command.matchAll(
    /(?:^|\s)(?:"([^"]+\.spec\.ts)"|'([^']+\.spec\.ts)'|([^\s]+\.spec\.ts))/g
  )
  for (const match of matches) {
    const file = match[1] ?? match[2] ?? match[3]
    if (file) {
      paths.add(file)
    }
  }
  return [...paths].sort()
}

/**
 * Command-referenced specs, split into the ones on disk and the ones it names but cannot produce.
 * A missing spec used to be swallowed, so a manifest could show `specs: []` next to a `command`
 * that no longer runs; the caller can now ship the archived copy (`specArchive`) and the gap is
 * recorded as `specsMissing`.
 */
export async function readSpecs(cwd: string, command: string) {
  const specs: HashedFile[] = []
  const missing: string[] = []
  for (const file of commandSpecPaths(command)) {
    const fullPath = isAbsolute(file) ? file : resolve(cwd, file)
    try {
      specs.push({ path: relative(cwd, fullPath), ...(await hashFile(fullPath)) })
    } catch {
      missing.push(file)
    }
  }
  return { specs, missing }
}

export async function archiveSpec(
  stage: string,
  cwd: string,
  archive: { file: string; what?: string }
): Promise<HashedFile & { source: string; what?: string }> {
  const source = isAbsolute(archive.file) ? archive.file : resolve(cwd, archive.file)
  const path = `specs/${basename(source)}`
  const destination = join(stage, path)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  return {
    path,
    source: archive.file,
    ...(await hashFile(destination)),
    ...(archive.what === undefined ? {} : { what: archive.what })
  }
}

export async function walkFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, fullPath)))
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath))
    }
  }
  return files
}

export async function readBuildIdentity(cwd: string, repoSha: string, specSha256: string) {
  const buildRoot = resolve(cwd, 'out')
  try {
    if (!(await stat(buildRoot)).isDirectory()) {
      throw new Error('not a directory')
    }
  } catch {
    return {
      path: null,
      files: [],
      fingerprint: null,
      boundSourceSnapshot: { repoSha, specSha256 }
    }
  }

  const files: HashedFile[] = []
  for (const file of await walkFiles(buildRoot)) {
    files.push({ path: file, ...(await hashFile(join(buildRoot, file))) })
  }
  return {
    path: relative(cwd, buildRoot),
    files,
    fingerprint: sha256(canonicalJson(files)),
    boundSourceSnapshot: { repoSha, specSha256 }
  }
}
