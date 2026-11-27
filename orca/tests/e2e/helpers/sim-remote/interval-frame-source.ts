import type { CDPSession } from '@stablyai/playwright-test'

export const MIN_INTERVAL_MS = 50
export const MAX_INTERVAL_MS = 2_000
export const DEFAULT_INTERVAL_MS = 250

export type IntervalFrame = {
  data: string
  sessionId: number
  metadata: { timestamp: number }
}

export type IntervalFrameSource = {
  start(): void
  stop(): void
  waitForIdle(): Promise<void>
}

/**
 * Forced-paint frame source: asks Chromium for a screenshot every `intervalMs` instead of waiting
 * for the compositor to paint. Synthetic frames carry a wall-clock timestamp and no screencast
 * session to acknowledge, so the recorder's existing write/timing path handles them unchanged.
 */
export function createIntervalFrameSource(args: {
  enabled: boolean
  intervalMs: number
  quality: number
  session: () => CDPSession | null
  accepting: () => boolean
  onFrame: (frame: IntervalFrame) => void
  onFailure: (label: string, error: unknown) => void
}): IntervalFrameSource {
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> | null = null

  const capture = (): void => {
    const active = args.session()
    if (!args.accepting() || inFlight || !active) {
      return
    }
    // A send can outlive the page; keep the promise so finalize waits instead of recording a
    // late "page closed" rejection as a capture failure.
    inFlight = active
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: args.quality,
        fromSurface: false,
        captureBeyondViewport: false
      })
      .then((shot: unknown) => {
        const data = typeof shot === 'object' && shot !== null ? Reflect.get(shot, 'data') : null
        if (typeof data !== 'string' || data.length === 0) {
          throw new Error('Page.captureScreenshot returned no data')
        }
        args.onFrame({ data, sessionId: Number.NaN, metadata: { timestamp: Date.now() / 1000 } })
      })
      .catch((error: unknown) => args.onFailure('forced-paint screenshot failed', error))
      .finally(() => {
        inFlight = null
      })
  }

  return {
    start() {
      if (!args.enabled || timer) {
        return
      }
      const active = args.session()
      if (active) {
        // A hidden window refreshes its surface lazily; bringing the page forward keeps a capture
        // in the tens of milliseconds rather than seconds.
        void active
          .send('Page.bringToFront')
          .catch((error: unknown) => args.onFailure('Page.bringToFront failed', error))
      }
      timer = setInterval(capture, args.intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    async waitForIdle() {
      await inFlight?.catch(() => undefined)
    }
  }
}

export type RecordingPacing = {
  pace: 'paint' | 'interval'
  quality: number
  source: IntervalFrameSource
}

const DEFAULT_QUALITY = 70

/**
 * Resolves the pacing knobs once so the recorder only has to say which mode it got. Kept here
 * (with the interval source) because the resolver is the only caller of the clamping rules.
 */
export function resolveRecordingPacing(
  args: { pace?: 'paint' | 'interval'; intervalMs?: number; quality?: number },
  deps: {
    session: () => CDPSession | null
    accepting: () => boolean
    onFrame: (frame: IntervalFrame) => void
    onFailure: (label: string, error: unknown) => void
  }
): RecordingPacing {
  const pace = args.pace ?? 'paint'
  const intervalMs = Number.isFinite(args.intervalMs)
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, args.intervalMs ?? DEFAULT_INTERVAL_MS))
    : DEFAULT_INTERVAL_MS
  const quality = Number.isFinite(args.quality)
    ? Math.round(Math.min(100, Math.max(0, args.quality ?? DEFAULT_QUALITY)))
    : DEFAULT_QUALITY
  return {
    pace,
    quality,
    source: createIntervalFrameSource({
      enabled: pace === 'interval',
      intervalMs,
      quality,
      ...deps
    })
  }
}

/** Stops the paint-paced screencast; interval pacing never started one. */
export async function stopPaintScreencast(
  session: CDPSession | null,
  pace: 'paint' | 'interval',
  onFailure: (label: string, error: unknown) => void
): Promise<void> {
  if (!session || pace !== 'paint') {
    return
  }
  try {
    await session.send('Page.stopScreencast')
  } catch (error) {
    onFailure('CDP screencast stop failed', error)
  }
}
