/**
 * Recording entries for `writeEvidencePackage`: naming, copying, and the derived method. A
 * degraded entry (`videoPath: null` + `encoder.kind` + a retained `framesDir`) is published as
 * degraded with its frames collected into the package, instead of collapsing to `recordings: []`
 * and a sentence claiming no recording was supplied.
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  errorMessage,
  hashFile,
  walkFiles,
  type HashedFile
} from './evidence-package-provenance'

export type EvidenceRecordingEncoder = { kind: string; path?: string; reason?: string }

/**
 * One recording as the caller observed it. The recorder's own `RecordingArtifact` fits this shape,
 * so a caller can hand over the artifact unchanged. `videoPath: null` plus a retained `framesDir`
 * and `encoder.kind` is a degradation, not an absence, and the pacing/encoder/scope fields are
 * carried into the manifest instead of being retyped (or omitted) by the writer.
 */
export type EvidenceRecording = {
  /** Which tree or run the clip records (`before`, `after`, …); also names its package folder. */
  tree?: string
  videoPath?: string | null
  framesDir?: string | null
  /** `capturedFrameCount` is the recorder's capture count; `frameCount` is the older name for the
   * same fact, and `videoFrameCount` counts frames in the encoded file. */
  frameCount?: number
  capturedFrameCount?: number
  videoFrameCount?: number | null
  durationSec?: number
  videoDurationSec?: number | null
  largestGapSec?: number
  fps?: number
  encoder?: EvidenceRecordingEncoder
  scope?: string
  sha256?: string | null
  [key: string]: unknown
}

export type PackagedRecording = EvidenceRecording & {
  videoPath: string | null
  framesDir: string | null
  frames: HashedFile[]
  file: string | null
  bytes: number | null
  sha256: string | null
  degraded: boolean
  encoder: EvidenceRecordingEncoder
}

export function validateRecordings(recordings: EvidenceRecording[]): void {
  for (const [index, entry] of recordings.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`recordings[${index}] must be an object`)
    }
    if (!entry.encoder || typeof entry.encoder.kind !== 'string') {
      throw new Error(
        `recordings[${index}] must carry encoder.kind; without it the manifest cannot say whether the capture degraded`
      )
    }
    const hasVideo = typeof entry.videoPath === 'string' && entry.videoPath.length > 0
    const hasFrames = typeof entry.framesDir === 'string' && entry.framesDir.length > 0
    if (!hasVideo && !hasFrames) {
      throw new Error(
        `recordings[${index}] has neither videoPath nor framesDir; a failed capture has to retain its frames to be published as degraded`
      )
    }
  }
}

/** The caller's explicit scope wins; otherwise every entry must declare the same one. */
export function resolveRecordingScope(
  explicit: string | undefined,
  recordings: EvidenceRecording[]
): string | null {
  const declared = explicit?.trim()
  if (declared) {
    return declared
  }
  const scopes = [
    ...new Set(
      recordings
        .map((entry) => entry.scope)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    )
  ]
  return scopes.length === 1 ? scopes[0]! : null
}

export function recordingName(entry: EvidenceRecording, index: number, used: Set<string>): string {
  const declared =
    typeof entry.tree === 'string' && entry.tree.trim().length > 0
      ? entry.tree
      : `recording-${index + 1}`
  const base = declared
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  let name = base.length > 0 ? base : `recording-${index + 1}`
  let suffix = 2
  while (used.has(name)) {
    name = `${base}-${suffix}`
    suffix += 1
  }
  used.add(name)
  return name
}

/**
 * Copies one recording into the package. A video is copied and hashed; a degraded entry has its
 * `framesDir` tree copied and every retained file hashed, so the frames that prove the attempt
 * travel with the manifest instead of being left next to it. Neither a missing video nor a missing
 * frames tree throws: degradation is the outcome this path exists to publish.
 */
export async function collectRecording(
  stage: string,
  entry: EvidenceRecording,
  name: string,
  artefactsBySource: Map<string, HashedFile>
): Promise<PackagedRecording> {
  const encoder: EvidenceRecordingEncoder =
    entry.encoder && typeof entry.encoder.kind === 'string'
      ? entry.encoder
      : { kind: 'none', reason: 'caller supplied no encoder field' }
  const sourceFrames =
    typeof entry.framesDir === 'string' && entry.framesDir.length > 0
      ? resolve(entry.framesDir)
      : null
  const frames: HashedFile[] = []
  let framesDir: string | null = null
  let framesError: string | null = null
  if (sourceFrames) {
    framesDir = `${name}-frames`
    try {
      for (const file of await walkFiles(sourceFrames)) {
        const destination = join(stage, framesDir, file)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(join(sourceFrames, file), destination)
        frames.push({ path: `${framesDir}/${file}`, ...(await hashFile(destination)) })
      }
    } catch (error) {
      framesError = errorMessage(error)
    }
  }

  let file: string | null = null
  let bytes: number | null = null
  let digest: string | null = null
  let videoError: string | null = null
  const sourceVideo =
    typeof entry.videoPath === 'string' && entry.videoPath.length > 0
      ? resolve(entry.videoPath)
      : null
  if (sourceVideo) {
    const alreadyCopied = artefactsBySource.get(sourceVideo)
    if (alreadyCopied) {
      file = alreadyCopied.path
      bytes = alreadyCopied.bytes
      digest = alreadyCopied.sha256
    } else {
      try {
        const packaged = `${name}.mp4`
        const destination = join(stage, packaged)
        await copyFile(sourceVideo, destination)
        const hashed = await hashFile(destination)
        file = packaged
        bytes = hashed.bytes
        digest = hashed.sha256
      } catch (error) {
        videoError = errorMessage(error)
      }
    }
  }

  return {
    ...entry,
    videoPath: file,
    ...(framesError === null ? {} : { framesError }),
    ...(videoError === null ? {} : { videoError }),
    framesDir,
    frames,
    file,
    bytes,
    sha256: digest,
    degraded: file === null,
    encoder
  }
}

/**
 * Recording method, derived from the entries rather than asserted: a run whose encoder was absent
 * or failed is published as degraded with the reason, and the scope is the caller's (or the one
 * every artifact declares). An empty list says "none supplied", not "nothing was captured".
 */
export function describeRecordingMethod(recordings: PackagedRecording[], scope: string | null) {
  if (recordings.length === 0) {
    return {
      capture: 'none',
      degraded: false,
      encoder: [],
      pacing: null,
      scope: null,
      reason: 'No recording was supplied; a capture that was expected belongs in notCaptured',
      counts: { captured: 0, degraded: 0 }
    }
  }
  const degraded = recordings.filter((entry) => entry.degraded)
  const reasons = degraded
    .map((entry) => entry.encoder.reason?.trim())
    .filter((reason): reason is string => Boolean(reason))
  return {
    capture:
      degraded.length === recordings.length
        ? 'degraded'
        : 'CDP Page.startScreencast on the Electron page',
    degraded: degraded.length > 0,
    encoder: [...new Set(recordings.map((entry) => entry.encoder.kind))],
    pacing: 'concat demuxer durations from each frame metadata timestamp',
    scope,
    ...(degraded.length === 0
      ? {}
      : {
          degradedReason:
            reasons.join('; ') || 'no video artefact was produced for the recording',
          degradedRecordings: degraded.map((entry) => entry.tree ?? null)
        }),
    counts: { captured: recordings.length - degraded.length, degraded: degraded.length }
  }
}
