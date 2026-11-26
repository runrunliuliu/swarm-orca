/**
 * Best-effort CDP recording for hidden E2E pages: X11 grabs are black because the app paints
 * offscreen. Frames appear only when the page paints, so timestamp duration and largest gap say
 * what span was observed and which seconds have no picture; output fps is only a playback convenience.
 *
 * Two numbers describe two different objects and must not be confused: `durationSec` is the span
 * between the first and last captured paint, `videoDurationSec` is measured from the produced file.
 * They agree to within one output frame plus the encoder's own rounding, and the integration spec
 * asserts that relationship instead of a fixed tolerance.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CDPSession, Page } from '@stablyai/playwright-test'
import {
  encodeVideo,
  errorMessage,
  summarizeReason,
  type RecordingEncoder,
  type ScreencastTiming
} from './screencast-encoder'

export type { RecordingEncoder } from './screencast-encoder'

export type RecordingScope = 'page-lifetime' | 'caller-scoped'

export type RecordingArtifact = {
  videoPath: string | null
  framesDir: string
  /** Frames the CDP screencast delivered and the recorder wrote to disk. */
  capturedFrameCount: number
  /** Frames the encoded file really holds, measured from the file; null without a file or probe. */
  videoFrameCount: number | null
  /** Span between the first and last captured frame timestamp. */
  durationSec: number
  /** Duration of the produced file, measured from the file; null without a file or probe. */
  videoDurationSec: number | null
  largestGapSec: number
  fps: number
  encoder: RecordingEncoder
  scope: RecordingScope
  /** True when the capture deadline fired before the encoder finished; the artefact is degraded. */
  timedOut: boolean
  /**
   * True when the capture deadline fired while the CDP session was still being set up, so no
   * frame was ever accepted. Kept beside `timedOut` because the two say different things: the
   * encoder never got a chance, and the degraded reason is the setup step that wedged.
   */
  setupTimedOut: boolean
  sha256: string | null
}

export type Recording = {
  stop(): Promise<RecordingArtifact>
  readonly framesDir: string
  readonly running: boolean
}

type RecordingArgs = {
  outDir?: string
  quality?: number
  scope?: RecordingScope
  /** Shortens CAPTURE_DEADLINE_MS for a caller with a smaller budget; never extends past it. */
  deadlineMs?: number
}
type Timing = ScreencastTiming
/** Wire data, not a contract: Chromium has been observed to omit `metadata` entirely. */
type ScreencastFrame = { data: string; sessionId: number; metadata?: { timestamp?: number } }

const OUTPUT_FPS = 15
const DEFAULT_QUALITY = 70
/**
 * The whole capture is bounded, not just the encoder call: CDP setup, discovery, encode, duration
 * probe and the two file writes all race this deadline. A spec that records must derive its own
 * timeout from this constant, so a slow encoder costs a degraded artefact rather than a red test.
 */
export const CAPTURE_DEADLINE_MS = 25_000

function timingFields(timings: Timing[]): Pick<RecordingArtifact, 'durationSec' | 'largestGapSec'> {
  if (timings.length < 2) {
    return { durationSec: 0, largestGapSec: 0 }
  }
  const first = timings[0]!
  const last = timings.at(-1)!
  let largestGapSec = 0
  for (let index = 1; index < timings.length; index += 1) {
    largestGapSec = Math.max(largestGapSec, timings[index]!.ts - timings[index - 1]!.ts)
  }
  return { durationSec: Math.max(0, last.ts - first.ts), largestGapSec: Math.max(0, largestGapSec) }
}

export async function startRecording(page: Page, args: RecordingArgs = {}): Promise<Recording> {
  const scope = args.scope ?? 'caller-scoped'
  const captureErrors: string[] = []
  const outputRoot = args.outDir
    ? path.resolve(args.outDir)
    : await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-recording-')).catch((error) => {
        captureErrors.push(`output directory creation failed (${errorMessage(error)})`)
        return path.join(os.tmpdir(), `orca-e2e-recording-unavailable-${Date.now()}`)
      })
  const framesDir = path.join(outputRoot, 'frames')
  const deadlineMs =
    Number.isFinite(args.deadlineMs) && (args.deadlineMs ?? 0) > 0
      ? Math.min(args.deadlineMs!, CAPTURE_DEADLINE_MS)
      : CAPTURE_DEADLINE_MS
  const deadlineAt = Date.now() + deadlineMs
  const abortController = new AbortController()
  const timings: Timing[] = []
  let session: CDPSession | null = null
  let acceptingFrames = false
  let nextFrameIndex = 0
  let pendingWrites = Promise.resolve()
  let stopPromise: Promise<RecordingArtifact> | null = null
  let deadlineTimer: NodeJS.Timeout | undefined
  let deadlineFired = false
  let lastTimestampSec: number | null = null
  let lastTimestampWallClockMs = 0

  const recordFailure = (label: string, error: unknown): void => {
    captureErrors.push(`${label} (${errorMessage(error)})`)
  }

  const dropSession = async (activeSession: CDPSession): Promise<void> => {
    try {
      activeSession.off('Page.screencastFrame', onFrame)
    } catch (error) {
      recordFailure('CDP listener removal failed', error)
    }
    await activeSession.detach().catch((error) => recordFailure('CDP detach failed', error))
  }

  const acknowledge = async (activeSession: CDPSession, sessionId: number): Promise<void> => {
    try {
      await activeSession.send('Page.screencastFrameAck', { sessionId })
    } catch (error) {
      recordFailure('CDP frame acknowledgment failed', error)
    }
  }

  /**
   * A frame may arrive without `metadata` (wire data, not a types contract). Dropping the timeline
   * would lose the picture, and throwing here would surface as a test failure from inside
   * Playwright's protocol dispatch, so advance the last known timestamp by the elapsed wall clock.
   */
  const frameTimestamp = (frame: ScreencastFrame): number | null => {
    const raw = frame.metadata?.timestamp
    const wallClockMs = Date.now()
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      lastTimestampSec = raw
      lastTimestampWallClockMs = wallClockMs
      return raw
    }
    if (lastTimestampSec === null) {
      lastTimestampSec = 0
      lastTimestampWallClockMs = wallClockMs
      return 0
    }
    const advanced = lastTimestampSec + Math.max(0, wallClockMs - lastTimestampWallClockMs) / 1000
    lastTimestampSec = advanced
    lastTimestampWallClockMs = wallClockMs
    return Number.isFinite(advanced) ? advanced : null
  }

  const onFrame = (frame: ScreencastFrame | null | undefined): void => {
    const activeSession = session
    if (!activeSession || !frame) {
      return
    }
    const sessionId = Number.isFinite(frame.sessionId) ? frame.sessionId : null
    if (!acceptingFrames) {
      if (sessionId !== null) {
        pendingWrites = pendingWrites.then(() => acknowledge(activeSession, sessionId))
      }
      return
    }
    const timestamp = frameTimestamp(frame)
    if (timestamp === null) {
      captureErrors.push('CDP frame omitted a usable timestamp')
      acceptingFrames = false
      if (sessionId !== null) {
        pendingWrites = pendingWrites.then(() => acknowledge(activeSession, sessionId))
      }
      return
    }
    const file = `frame-${String(nextFrameIndex).padStart(4, '0')}.jpg`
    nextFrameIndex += 1
    pendingWrites = pendingWrites
      .then(async () => {
        await writeFile(path.join(framesDir, file), Buffer.from(frame.data, 'base64'))
        timings.push({ file, ts: timestamp })
      })
      .catch(async (error: unknown) => {
        recordFailure(`frame ${file} write failed`, error)
        // A failed write can leave a truncated JPEG behind; a file with no timing is one the
        // spec's frame-count assertion cannot account for. Drop the bytes with the timing.
        await rm(path.join(framesDir, file), { force: true }).catch(() => undefined)
      })
      .finally(async () => {
        if (sessionId !== null) {
          await acknowledge(activeSession, sessionId)
        }
        if (captureErrors.length > 0) {
          acceptingFrames = false
        }
      })
  }

  const fallbackArtifact = (
    reason: string,
    timedOut = false,
    setupExpired = false
  ): RecordingArtifact => ({
    videoPath: null,
    framesDir,
    capturedFrameCount: timings.length,
    videoFrameCount: null,
    ...timingFields(timings),
    videoDurationSec: null,
    fps: OUTPUT_FPS,
    encoder: { kind: 'none', reason: summarizeReason(reason) },
    scope,
    timedOut,
    setupTimedOut: setupExpired,
    sha256: null
  })

  const deadlineArtifact = (): RecordingArtifact =>
    fallbackArtifact(`capture deadline of ${deadlineMs} ms exceeded before the recording was finished`, true)

  const writeTimings = (): Promise<void> =>
    writeFile(path.join(framesDir, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`)

  const finalize = async (): Promise<RecordingArtifact> => {
    acceptingFrames = false
    if (session) {
      try {
        await session.send('Page.stopScreencast')
      } catch (error) {
        recordFailure('CDP screencast stop failed', error)
      }
    }
    // The listener is removed after the pending writes, so a frame that arrives in between is
    // acknowledged (no write, no lost session) rather than dropped by the compositor.
    await pendingWrites
    if (session) {
      await dropSession(session)
    }
    try {
      await writeTimings()
    } catch (error) {
      recordFailure('timings.json write failed', error)
    }

    if (captureErrors.length > 0) {
      return fallbackArtifact(captureErrors.join('; '), abortController.signal.aborted)
    }
    const encoded = await encodeVideo(outputRoot, framesDir, timings, {
      env: { ...process.env },
      deadlineAt,
      signal: abortController.signal
    })
    return {
      videoPath: encoded.videoPath,
      framesDir,
      capturedFrameCount: timings.length,
      videoFrameCount: encoded.videoFrameCount,
      ...timingFields(timings),
      videoDurationSec: encoded.videoDurationSec,
      fps: OUTPUT_FPS,
      encoder: encoded.encoder,
      scope,
      timedOut: abortController.signal.aborted,
      setupTimedOut: false,
      sha256: encoded.sha256
    }
  }

  /** Resolves at the capture deadline and cancels whatever the encoder work is still waiting on. */
  const deadlineReached = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineFired = true
      acceptingFrames = false
      abortController.abort()
      // `finalize()` is abandoned by the race, so leave the frames that did arrive with their
      // timings on disk instead of the empty `[]` written at setup.
      void pendingWrites.then(writeTimings).catch(() => undefined)
      resolve('deadline')
    }, deadlineMs)
    deadlineTimer.unref()
  })

  const setup = async (): Promise<void> => {
    try {
      await mkdir(framesDir, { recursive: true })
      await writeFile(path.join(framesDir, 'timings.json'), '[]\n')
      session = await page.context().newCDPSession(page)
      session.on('Page.screencastFrame', onFrame)
      const quality = Number.isFinite(args.quality)
        ? Math.round(Math.min(100, Math.max(0, args.quality ?? DEFAULT_QUALITY)))
        : DEFAULT_QUALITY
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        everyNthFrame: 1
      })
      if (deadlineFired) {
        // The caller already holds a degraded artifact for this capture; a session that finally
        // answered after the deadline must not start collecting frames nobody will read.
        acceptingFrames = false
        void dropSession(session)
        return
      }
      acceptingFrames = true
    } catch (error) {
      recordFailure('recording setup failed', error)
      acceptingFrames = false
      if (session) {
        await dropSession(session)
      }
    }
  }

  /**
   * The setup block races the deadline like everything else. `newCDPSession` and
   * `Page.startScreencast` are protocol round-trips, and a wedged one used to leave
   * `startRecording()` unresolved for good — the timer fired with nobody listening and the spec
   * died of a Playwright timeout instead of publishing a degraded artifact. On expiry the caller
   * gets a recording whose frames directory exists, whose artifact says `setupTimedOut`, and whose
   * `stop()` resolves immediately.
   */
  let setupTimeoutArtifact: RecordingArtifact | null = null
  const ready = setup().then(
    () => 'ready' as const,
    () => 'ready' as const
  )
  const setupOutcome = await Promise.race([ready, deadlineReached])
  if (setupOutcome === 'deadline') {
    acceptingFrames = false
    // The deadline already scheduled a timeline write; wait for it so the frames directory is
    // coherent (an empty `timings.json`, not a half-truncated one) the moment this resolves.
    await pendingWrites.then(writeTimings).catch(() => undefined)
    setupTimeoutArtifact = fallbackArtifact(
      `recording setup did not finish inside the ${deadlineMs} ms capture deadline`,
      true,
      true
    )
  }

  const recording: Recording = {
    framesDir,
    get running() {
      return acceptingFrames
    },
    stop() {
      if (!stopPromise) {
        const pending = setupTimeoutArtifact
          ? Promise.resolve(setupTimeoutArtifact)
          : Promise.race([finalize(), deadlineReached.then(() => deadlineArtifact())]).catch(
              (error) => fallbackArtifact(`recording finalization failed (${errorMessage(error)})`)
            )
        stopPromise = pending.finally(() => {
          if (deadlineTimer) {
            clearTimeout(deadlineTimer)
          }
        })
      }
      return stopPromise
    }
  }
  return recording
}
