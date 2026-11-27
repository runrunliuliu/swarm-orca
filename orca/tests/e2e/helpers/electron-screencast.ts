import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { encodeVideo } from './sim-remote/screencast-encoder'
import type { RecordingArtifact, RecordingScope } from './sim-remote/recorder'

const OUTPUT_FPS = 15
const DEFAULT_INTERVAL_MS = 250
const DEFAULT_DEADLINE_MS = 60_000

type Frame = { file: string; ts: number }

/**
 * Electron-native frame capture for evidence runs.
 *
 * Why the loop lives in the main process: `Page.captureScreenshot` (CDP) and per-frame
 * `electronApp.evaluate` both queue behind the spec's own protocol traffic, so a 250 ms interval
 * produced 3–9 frames per scenario. `BrowserWindow.capturePage()` measured 30–70 ms, and starting
 * the timer inside main keeps it off the test's request queue.
 */
export async function startElectronRecording(
  electronApp: ElectronApplication,
  options: {
    outDir: string
    scope?: RecordingScope
    intervalMs?: number
    quality?: number
    deadlineMs?: number
  }
): Promise<{ stop(): Promise<RecordingArtifact> }> {
  const scope = options.scope ?? 'page-lifetime'
  const framesDir = path.join(options.outDir, 'frames')
  const intervalMs = Math.min(2_000, Math.max(50, options.intervalMs ?? DEFAULT_INTERVAL_MS))
  const quality = Math.min(100, Math.max(1, options.quality ?? 70))
  const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  await mkdir(framesDir, { recursive: true })
  await electronApp.evaluate(
    async ({ BrowserWindow }, args) => {
      // The evaluated main-process context has no dynamic-import callback; getBuiltinModule is
      // the supported way to reach Node builtins from it.
      const fs = process.getBuiltinModule('node:fs/promises')
      const nodePath = process.getBuiltinModule('node:path')
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) {
        throw new Error('no BrowserWindow to record')
      }
      await fs.mkdir(args.framesDir, { recursive: true })
      const frames: { file: string; ts: number }[] = []
      let index = 0
      let busy = false
      let stopped = false
      const timer = setInterval(() => {
        if (busy || stopped) {
          return
        }
        busy = true
        void (async () => {
          try {
            const image = await window.capturePage()
            const file = `frame-${String(index).padStart(4, '0')}.jpg`
            index += 1
            const ts = Date.now() / 1000
            await fs.writeFile(nodePath.join(args.framesDir, file), image.toJPEG(args.quality))
            frames.push({ file, ts })
          } catch {
            // A closed window ends the capture; the frames already on disk stay the artifact.
          } finally {
            busy = false
          }
        })()
      }, args.intervalMs)
      timer.unref?.()
      Reflect.set(window, '__orcaE2eRecording', {
        timer,
        frames,
        stop() {
          stopped = true
          clearInterval(timer)
        }
      })
    },
    { framesDir, intervalMs, quality }
  )

  return {
    async stop() {
      const captured = await electronApp.evaluate(
        async ({ BrowserWindow }, args) => {
          const window = BrowserWindow.getAllWindows()[0]
          const recording = window ? Reflect.get(window, '__orcaE2eRecording') : null
          if (!recording || typeof recording !== 'object') {
            return null
          }
          const stop = Reflect.get(recording, 'stop')
          if (typeof stop === 'function') {
            stop()
          }
          const frames = Reflect.get(recording, 'frames')
          // Let an in-flight capture finish writing before the timings snapshot is taken.
          await new Promise((resolve) => setTimeout(resolve, args.settleMs))
          return frames
        },
        { settleMs: Math.min(2_000, intervalMs * 2) }
      )
      const frames = asFrames(captured)
      await writeFile(path.join(framesDir, 'timings.json'), `${JSON.stringify(frames, null, 2)}\n`)
      const controller = new AbortController()
      const encoded = await encodeVideo(options.outDir, framesDir, frames, {
        env: { ...process.env },
        deadlineAt: deadlineAt + 25_000,
        signal: controller.signal
      })
      const durationSec = frames.length > 1 ? frames.at(-1)!.ts - frames[0]!.ts : 0
      const largestGapSec = frames
        .slice(1)
        .reduce((largest, frame, index) => Math.max(largest, frame.ts - frames[index]!.ts), 0)
      return {
        videoPath: encoded.videoPath,
        framesDir,
        capturedFrameCount: frames.length,
        videoFrameCount: encoded.videoFrameCount,
        durationSec,
        videoDurationSec: encoded.videoDurationSec,
        largestGapSec,
        fps: OUTPUT_FPS,
        encoder: encoded.encoder,
        scope,
        timedOut: false,
        setupTimedOut: false,
        sha256: encoded.sha256
      }
    }
  }
}

/** Validates the main-process payload instead of asserting its shape in the recorder. */
function asFrames(value: unknown): Frame[] {
  if (!Array.isArray(value)) {
    return []
  }
  const frames: Frame[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const file = Reflect.get(entry, 'file')
    const ts = Reflect.get(entry, 'ts')
    if (typeof file === 'string' && typeof ts === 'number' && Number.isFinite(ts)) {
      frames.push({ file, ts })
    }
  }
  return frames
}
