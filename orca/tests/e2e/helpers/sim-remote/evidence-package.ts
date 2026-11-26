/**
 * Evidence package writer: one hashed `pr-evidence/<slug>/manifest.json` over the bytes that were
 * actually captured.
 *
 * The responsibility boundary is explicit. The writer derives what it can observe (repository and
 * build identity, dirty-input hashes and the shipped patch, copied-artefact and frame hashes, the
 * cases it was told about, retries only when someone declared them). Everything a caller claims —
 * `notCaptured`, `redaction`, every `what`, the case statuses — stays a claim: a hash makes it
 * stable, not true.
 */
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import {
  archiveSpec,
  canonicalJson,
  git,
  hashFile,
  readBuildIdentity,
  readDirty,
  readSpecs,
  sha256,
  type HashedFile
} from './evidence-package-provenance'
import {
  collectRecording,
  describeRecordingMethod,
  recordingName,
  resolveRecordingScope,
  validateRecordings,
  type EvidenceRecording,
  type PackagedRecording
} from './evidence-package-recordings'

export type {
  EvidenceRecording,
  EvidenceRecordingEncoder,
  PackagedRecording
} from './evidence-package-recordings'

/**
 * Playwright's test status set. `cases[].result` is an enum, not free text: the manifest derives
 * `skipped` from it, so a sentence such as `PASSED (capture ran …)` used to read as observed while
 * `skipped` stayed empty by accident. The sentence belongs in `note`.
 */
export const CASE_RESULTS = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'] as const
export type CaseResult = (typeof CASE_RESULTS)[number]

export type EvidenceCase = {
  name?: string
  result: CaseResult
  /** Free text for what the status cannot say; it is never parsed into a derived field. */
  note?: string
  [key: string]: unknown
}

export type EvidenceRun = {
  /** Playwright's configured retry count for this run, when the runner reports it. */
  retries?: number
  [key: string]: unknown
}

export type EvidencePackageSpec = {
  slug: string
  lane: 'A' | 'B' | 'C'
  issue?: number
  command: string
  project: string
  notCaptured: string[]
  redaction: { applied: boolean; what: string }
  /**
   * Playwright's configured retries. Omitted or `null` is published as unknown: "nobody reported
   * retries" is not the same claim as "this run was not retried".
   */
  retries?: number | null
  /**
   * What the recording covers, in the caller's words. Defaults to the scope every recording entry
   * declares (the recorder's own `scope`); required once a recording is supplied, because the
   * fixed sentence this used to be was a coverage claim the writer invented.
   */
  recordingScope?: string
  /**
   * The shipped copy of a spec the command names but the tree no longer holds. The writer copies
   * it into the package and records its real name and hash beside `command`.
   */
  specArchive?: { file: string; what?: string }
}

type EvidencePackageArgs = EvidencePackageSpec & {
  artefacts: { file: string; what: string }[]
  cases?: EvidenceCase[]
  runs?: EvidenceRun[]
  recordings?: EvidenceRecording[]
}

function skippedCases(cases: EvidenceCase[]): EvidenceCase[] {
  return cases.filter((testCase) => testCase.result === 'skipped')
}

/**
 * Playwright's configured retry count, or `null` when nobody reported one. The maximum of the
 * runs' own `retries` is only used when every run declares it; a single attempt is not evidence
 * that retries were configured to zero.
 */
function deriveRetries(args: EvidencePackageArgs): number | null {
  if (typeof args.retries === 'number') {
    return args.retries
  }
  const declared = (args.runs ?? []).map((run) =>
    typeof run?.retries === 'number' ? run.retries : null
  )
  if (declared.length > 0 && declared.every((value): value is number => value !== null)) {
    return Math.max(...declared)
  }
  return null
}

function validateCases(cases: EvidenceCase[]): void {
  for (const [index, testCase] of cases.entries()) {
    if (!testCase || typeof testCase !== 'object') {
      throw new Error(`cases[${index}] must be an object`)
    }
    if (!(CASE_RESULTS as readonly string[]).includes(testCase.result)) {
      throw new Error(
        `cases[${index}].result must be one of ${CASE_RESULTS.join(', ')}; put the sentence in cases[${index}].note`
      )
    }
    if (testCase.note !== undefined && typeof testCase.note !== 'string') {
      throw new Error(`cases[${index}].note must be a string when supplied`)
    }
  }
}

function validateArgs(args: EvidencePackageArgs): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(args.slug)) {
    throw new Error('Evidence slug must be a lowercase path-safe name')
  }
  if (args.notCaptured.length === 0 || args.notCaptured.some((entry) => entry.trim().length === 0)) {
    throw new Error('notCaptured must contain at least one explicit limitation')
  }
  if (!args.redaction || typeof args.redaction.applied !== 'boolean') {
    throw new Error('redaction.applied must be a boolean')
  }
  if (typeof args.redaction.what !== 'string' || args.redaction.what.trim().length === 0) {
    throw new Error('redaction.what must say what was, or was not, redacted')
  }
  if (
    args.retries !== undefined &&
    args.retries !== null &&
    (!Number.isInteger(args.retries) || args.retries < 0)
  ) {
    throw new Error('retries must be a non-negative integer or null when unknown')
  }
  validateCases(args.cases ?? [])
  const recordings = args.recordings ?? []
  validateRecordings(recordings)
  const names = args.artefacts.map((artefact) => basename(artefact.file))
  if (new Set(names).size !== names.length) {
    throw new Error('Evidence artefact basenames must be unique')
  }
  const shipsRecording =
    recordings.length > 0 ||
    args.artefacts.some((artefact) => extname(artefact.file).toLowerCase() === '.mp4')
  if (shipsRecording && !resolveRecordingScope(args.recordingScope, recordings)) {
    throw new Error(
      'recordingScope must state what the recording covers when a recording is supplied'
    )
  }
}

export async function writeEvidencePackage(
  args: EvidencePackageArgs
): Promise<{ dir: string; manifestPath: string; manifestSha256: string }> {
  validateArgs(args)
  const cwd = process.cwd()
  const evidenceRoot = resolve(cwd, 'pr-evidence')
  const dir = resolve(evidenceRoot, args.slug)
  await mkdir(evidenceRoot, { recursive: true })
  const stage = await mkdtemp(join(evidenceRoot, `.${args.slug}-stage-`))
  try {
    const artefacts: (HashedFile & { what: string })[] = []
    const artefactsBySource = new Map<string, HashedFile>()
    for (const artefact of args.artefacts) {
      const path = basename(artefact.file)
      const destination = join(stage, path)
      await copyFile(resolve(artefact.file), destination)
      const copied = { path, ...(await hashFile(destination)), what: artefact.what }
      artefacts.push(copied)
      artefactsBySource.set(resolve(artefact.file), copied)
    }

    const specInput = {
      slug: args.slug,
      lane: args.lane,
      issue: args.issue,
      command: args.command,
      project: args.project,
      notCaptured: args.notCaptured,
      redaction: args.redaction,
      cases: args.cases ?? [],
      runs: args.runs ?? [],
      recordings: args.recordings ?? [],
      artefacts: artefacts.map(({ path, sha256: digest, what }) => ({ path, sha256: digest, what }))
    }
    const { specs, missing } = await readSpecs(cwd, args.command)
    const specSha256 =
      specs.length === 1
        ? specs[0]!.sha256
        : sha256(canonicalJson(specs.length > 0 ? specs : specInput))
    const topLevel = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const repoSha = (await git(topLevel, ['rev-parse', 'HEAD'])).trim()
    const cases = args.cases ?? []
    const usedNames = new Set<string>()
    const packagedRecordings: PackagedRecording[] = []
    for (const [index, entry] of (args.recordings ?? []).entries()) {
      packagedRecordings.push(
        await collectRecording(stage, entry, recordingName(entry, index, usedNames), artefactsBySource)
      )
    }
    if (packagedRecordings.length === 0) {
      // Backwards-compatible shape: an mp4 handed over as a plain artefact becomes a recording
      // entry, with the encoder honestly marked unknown instead of assumed.
      for (const artefact of artefacts) {
        if (extname(artefact.path).toLowerCase() !== '.mp4') {
          continue
        }
        const name = recordingName({}, usedNames.size, usedNames)
        packagedRecordings.push({
          videoPath: artefact.path,
          framesDir: null,
          frames: [],
          file: artefact.path,
          bytes: artefact.bytes,
          sha256: artefact.sha256,
          degraded: false,
          encoder: {
            kind: 'unknown',
            reason: 'mp4 supplied as an artefact without a recording entry; encoder and pacing unknown'
          },
          scope: resolveRecordingScope(args.recordingScope, args.recordings ?? []) ?? undefined,
          tree: name
        })
      }
    }
    const screenshots = artefacts
      .filter((artefact) =>
        ['.png', '.jpg', '.jpeg', '.gif'].includes(extname(artefact.path).toLowerCase())
      )
      .map((artefact) => ({
        file: artefact.path,
        sha256: artefact.sha256,
        bytes: artefact.bytes,
        what: artefact.what
      }))
    const dirty = await readDirty(topLevel, specSha256, artefacts)
    await writeFile(join(stage, 'dirty.patch'), dirty.patchBytes)
    const specArchive = args.specArchive ? await archiveSpec(stage, cwd, args.specArchive) : null
    const manifest = {
      slug: args.slug,
      ...(args.issue === undefined ? {} : { issue: args.issue }),
      repoSha,
      dirty: {
        tracked: dirty.tracked,
        untracked: dirty.untracked,
        patch: { path: 'dirty.patch', ...dirty.patch },
        // Kept beside `patch` so a reader that only follows `patchSha256` still lands on the
        // shipped diff rather than a hash of bytes that were never copied.
        patchSha256: dirty.patch.sha256,
        artefacts: dirty.artefacts,
        specSha256: dirty.specSha256
      },
      build: await readBuildIdentity(cwd, repoSha, specSha256),
      command: args.command,
      lane: args.lane,
      project: args.project,
      cwd,
      platform: {
        os: platform(),
        release: release(),
        arch: arch(),
        node: process.version,
        shell: process.env.SHELL ?? process.env.ComSpec ?? null,
        viewport: process.env.ORCA_EVIDENCE_VIEWPORT ?? null
      },
      specs,
      specsMissing: missing,
      ...(specArchive === null ? {} : { specArchive }),
      cases,
      runs: args.runs ?? [],
      skipped: skippedCases(cases),
      retries: deriveRetries(args),
      screenshots,
      recordings: packagedRecordings,
      recordingMethod: describeRecordingMethod(
        packagedRecordings,
        resolveRecordingScope(args.recordingScope, args.recordings ?? [])
      ),
      notCaptured: args.notCaptured,
      redaction: args.redaction,
      artefacts
    }
    const manifestPath = join(stage, 'manifest.json')
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(manifestPath, manifestBytes)
    await rm(dir, { recursive: true, force: true })
    await rename(stage, dir)
    return {
      dir,
      manifestPath: join(dir, 'manifest.json'),
      manifestSha256: sha256(manifestBytes)
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
