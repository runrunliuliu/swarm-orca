/**
 * The single screencast encoder: discovery, the concat manifest, the ffmpeg call, and the
 * measurement of what the file actually contains.
 *
 * Why it is one module: the recorder used to share this job with `config/scripts/encode-screencast.mjs`,
 * which probed discovery differently and rejected backwards timelines the recorder clamped. That CLI
 * had no caller but its own test, so it was deleted rather than reconnected — a second implementation
 * cannot be kept honest by two test suites, and its `spawnSync` call could not be cancelled by the
 * recorder's capture deadline.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type RecordingEncoder = { kind: 'ffmpeg'; path: string } | { kind: 'none'; reason: string }

export type ScreencastTiming = { file: string; ts: number }

export type EncoderOutcome = {
  encoder: RecordingEncoder
  videoPath: string | null
  sha256: string | null
  videoDurationSec: number | null
  videoFrameCount: number | null
}

export type VideoFacts = { durationSec: number; frameCount: number }

type ExecOptions = { env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal }

const OUTPUT_FPS = 15
const PROBE_TIMEOUT_MS = 3_000
const ENCODE_TIMEOUT_MS = 15_000
const REASON_MAX_LINES = 2
const REASON_MAX_CHARS = 400

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * A failed ffmpeg hands its whole stderr to `error.message` (8 KB observed). A manifest carries the
 * reason as prose, so keep the first lines and drop the rest.
 */
export function summarizeReason(text: string): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, REASON_MAX_LINES)
  const summary = lines.join(' | ')
  return summary.length > REASON_MAX_CHARS ? `${summary.slice(0, REASON_MAX_CHARS)}…` : summary
}

export function runFile(executable: string, args: string[], options: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        env: options.env,
        maxBuffer: 1024 * 1024,
        timeout: options.timeout,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {})
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

function firstOutputLine(output: string): string | null {
  return output.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null
}

/** Milliseconds a step may still use: the per-step cap, never more than the capture deadline leaves. */
export function remainingBudgetMs(deadlineAt: number, stepCapMs: number): number {
  return Math.max(1, Math.min(stepCapMs, deadlineAt - Date.now()))
}

export async function discoverEncoder(
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
  signal: AbortSignal
): Promise<RecordingEncoder> {
  const configured = env.ORCA_FFMPEG_PATH?.trim()
  if (configured) {
    return { kind: 'ffmpeg', path: configured }
  }

  const failures = ['ORCA_FFMPEG_PATH is unset']
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const found = firstOutputLine(
      await runFile(locator, ['ffmpeg'], {
        env,
        timeout: remainingBudgetMs(deadlineAt, PROBE_TIMEOUT_MS),
        signal
      })
    )
    if (found) {
      return { kind: 'ffmpeg', path: found }
    }
    failures.push('ffmpeg was not found on PATH')
  } catch (error) {
    failures.push(`PATH probe failed (${errorMessage(error)})`)
  }

  try {
    const found = firstOutputLine(
      await runFile(
        'python3',
        ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
        { env, timeout: remainingBudgetMs(deadlineAt, PROBE_TIMEOUT_MS), signal }
      )
    )
    if (found) {
      return { kind: 'ffmpeg', path: found }
    }
    failures.push('imageio_ffmpeg returned no executable')
  } catch (error) {
    failures.push(`imageio_ffmpeg probe failed (${errorMessage(error)})`)
  }

  // Summarized like every other degraded reason: a `python3` that prints a traceback used to put
  // five newlines and a 368-character stack into the manifest and `recordingMethod.degradedReason`.
  return {
    kind: 'none',
    reason: summarizeReason(`No ffmpeg encoder available: ${failures.join('; ')}`)
  }
}

function concatPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replaceAll("'", "'\\''")
}

/**
 * One `file` line per frame carrying the gap to the next frame, then a final repeat so the last
 * image survives long enough to be encoded. The repeat needs its own `duration`: without it the
 * concat demuxer hands the previous gap to the repeated frame as well, and the file comes out
 * `durationSec + 2 × lastGap` long (measured 9.53 s for a 3.5 s span before this line existed).
 * With it the file is `durationSec` plus the one output frame the repeat has to occupy.
 */
export function concatManifest(framesDir: string, timings: ScreencastTiming[]): string {
  const lines = ['ffconcat version 1.0']
  for (const [index, timing] of timings.entries()) {
    lines.push(`file '${concatPath(path.join(framesDir, timing.file))}'`)
    const next = timings[index + 1]
    if (next) {
      lines.push(`duration ${Math.max(0, next.ts - timing.ts).toFixed(6)}`)
    }
  }
  if (timings.length > 1) {
    lines.push('duration 0.000001')
    lines.push(`file '${concatPath(path.join(framesDir, timings.at(-1)!.file))}'`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Measure the produced file instead of assuming the manifest was honoured: decode it to the null
 * muxer and read the last `out_time_us`/`frame` progress values. Decoding (not stream copy) is what
 * makes `out_time_us` the end of the last frame rather than the last packet's presentation time.
 */
export async function probeVideoFacts(
  videoPath: string,
  executable: string,
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
  signal: AbortSignal
): Promise<VideoFacts | null> {
  try {
    const progress = await runFile(
      executable,
      [
        '-v', 'error', '-i', videoPath, '-map', '0:v:0', '-f', 'null', '-',
        '-progress', 'pipe:1', '-nostats'
      ],
      { env, timeout: remainingBudgetMs(deadlineAt, PROBE_TIMEOUT_MS), signal }
    )
    const durations = [...progress.matchAll(/^out_time_us=(\d+)$/gmu)].map((match) => Number(match[1]))
    const frames = [...progress.matchAll(/^frame=(\d+)$/gmu)].map((match) => Number(match[1]))
    const durationMicros = durations.at(-1)
    const frameCount = frames.at(-1)
    if (durationMicros === undefined || frameCount === undefined) {
      return null
    }
    return { durationSec: durationMicros / 1_000_000, frameCount }
  } catch {
    return null
  }
}

const noVideo = (encoder: RecordingEncoder): EncoderOutcome => ({
  encoder,
  videoPath: null,
  sha256: null,
  videoDurationSec: null,
  videoFrameCount: null
})

export async function encodeVideo(
  outputRoot: string,
  framesDir: string,
  timings: ScreencastTiming[],
  options: { env: NodeJS.ProcessEnv; deadlineAt: number; signal: AbortSignal }
): Promise<EncoderOutcome> {
  if (timings.length === 0) {
    return noVideo({ kind: 'none', reason: 'No timestamped screencast frames were captured' })
  }

  const encoder = await discoverEncoder(options.env, options.deadlineAt, options.signal)
  if (encoder.kind === 'none') {
    return noVideo(encoder)
  }

  const videoPath = path.join(outputRoot, 'recording.mp4')
  // The concat manifest is scratch input for one ffmpeg call: keep it out of the recording
  // directory so an evidence folder holds only the artefact and the frames that produced it.
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'orca-screencast-')).catch(() => null)
  if (!workDir) {
    return noVideo({ kind: 'none', reason: 'ffmpeg encoding skipped: no temporary directory available' })
  }
  try {
    const inputPath = path.join(workDir, 'timings.ffconcat')
    await writeFile(inputPath, concatManifest(framesDir, timings))
    const outputArgs = [
      '-vf', `fps=${OUTPUT_FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath
    ]
    await runFile(encoder.path, ['-y', '-f', 'concat', '-safe', '0', '-i', inputPath, ...outputArgs], {
      env: options.env,
      timeout: remainingBudgetMs(options.deadlineAt, ENCODE_TIMEOUT_MS),
      signal: options.signal
    })
    const hash = createHash('sha256').update(await readFile(videoPath)).digest('hex')
    const facts = await probeVideoFacts(videoPath, encoder.path, options.env, options.deadlineAt, options.signal)
    return {
      encoder,
      videoPath,
      sha256: hash,
      videoDurationSec: facts?.durationSec ?? null,
      videoFrameCount: facts?.frameCount ?? null
    }
  } catch (error) {
    return noVideo({
      kind: 'none',
      reason: summarizeReason(`ffmpeg encoding via ${encoder.path} failed (${errorMessage(error)})`)
    })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
