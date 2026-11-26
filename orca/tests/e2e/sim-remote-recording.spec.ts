import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, stat, writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { CAPTURE_DEADLINE_MS, startRecording } from './helpers/sim-remote/recorder'
import { waitForSessionReady } from './helpers/store'

type VideoFacts = { durationSec: number; frameCount: number }

/**
 * The three numbers the spec's ceiling is made of, each one written down instead of implied by a
 * constant someone believed was generous.
 *
 * `PROBE_TIMEOUT_MS` is this spec's own post-capture probe; it is passed into `measureVideo` below
 * so the budget and the call cannot drift apart.
 *
 * `APP_ALLOWANCE_MS` is app boot plus the scenario, measured on the recorded instrument at
 * 21.9–25.3 s (reports/run4-w7-recorder-fix.md). It is deliberately larger than that measurement:
 * the ceiling has to survive the slow end of the host, and the lane guard fails if the allowance
 * ever drops below the measured boot time.
 */
const PROBE_TIMEOUT_MS = 10_000
const APP_ALLOWANCE_MS = 30_000

/**
 * Independent measurement of the produced file, deliberately duplicating the recorder's probe
 * instead of trusting the artefact: decode to the null muxer and read the last `out_time_us` and
 * `frame` progress values. Decoding (not stream copy) is what makes `out_time_us` the end of the
 * last frame rather than the last packet's presentation time. The timeout is the caller's, so the
 * spec's ceiling and this call are one budget rather than two.
 */
function measureVideo(ffmpegPath: string, videoPath: string, timeoutMs: number): Promise<VideoFacts> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        videoPath,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
        '-progress',
        'pipe:1',
        '-nostats'
      ],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        const durationMicros = [...stdout.matchAll(/^out_time_us=(\d+)$/gmu)].at(-1)?.[1]
        const frameCount = [...stdout.matchAll(/^frame=(\d+)$/gmu)].at(-1)?.[1]
        if (!durationMicros || !frameCount) {
          reject(new Error('ffmpeg progress omitted out_time_us or frame'))
          return
        }
        resolve({ durationSec: Number(durationMicros) / 1_000_000, frameCount: Number(frameCount) })
      }
    )
  })
}

async function explicitEncoderAvailable(): Promise<boolean | null> {
  const configured = process.env.ORCA_FFMPEG_PATH?.trim()
  if (!configured) {
    return null
  }
  return access(configured, constants.X_OK).then(
    () => true,
    () => false
  )
}

test.describe('remote simulation recording @sim-recording', () => {
  // Why derive the ceiling instead of writing one: `stop()` is bounded by the recorder's capture
  // deadline, so the spec's budget is the deadline *plus* the app work before it and the probe
  // after it. The old `+ 30_000` was a floor, not a derivation: boot alone measured 21.9–25.3 s, so
  // 25 s + 30 s left nothing for the probe and a slow host timed out while `stop()` was still
  // inside its own deadline. Each addend is now a named constant that explains itself, and the
  // lane guard (`config/scripts/pr-e2e-recorded-lane.test.mjs`) asserts this exact sum.
  test.describe.configure({ timeout: CAPTURE_DEADLINE_MS + APP_ALLOWANCE_MS + PROBE_TIMEOUT_MS })

  // Opt-in lane, registered in `config/scripts/pr-e2e-source-routing.mjs` as `OPT_IN_E2E_LANES`
  // id `recording.sim-remote`: run with `ORCA_SIM_RECORDING=1`, manually, on a change to the
  // recorder/encoder and before publishing a recording as evidence. Without the literal `1` the
  // whole describe is skipped before an app launches, so the default lane pays nothing for the
  // fact that a real run spends one encoder pass. The recorded-lane guard
  // (`config/scripts/pr-e2e-recorded-lane.test.mjs`) reads this gate and the registration
  // together, so deleting either fails rather than silently re-pricing the default lane.
  test.skip(
    process.env.ORCA_SIM_RECORDING !== '1',
    'Recorded lane: set ORCA_SIM_RECORDING=1 to run (OPT_IN_E2E_LANES recording.sim-remote).'
  )

  test('records real renderer paints and degrades without an encoder', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const configuredEncoderAvailable = await explicitEncoderAvailable()
    const recording = await startRecording(orcaPage, {
      outDir: testInfo.outputPath('sim-remote-recording'),
      scope: 'caller-scoped'
    })

    await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    const search = dialog.getByRole('combobox')
    for (const value of ['w', 'wo', 'wor', 'work', 'workt', 'worktr', 'worktre', 'worktree']) {
      await search.fill(value)
      await expect(search).toHaveValue(value)
      await orcaPage.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
    }

    const artifact = await recording.stop()
    const frameFiles = (await readdir(artifact.framesDir)).filter((file) =>
      /^frame-\d{4}\.jpg$/u.test(file)
    )

    expect(artifact.timedOut).toBe(false)
    expect(artifact.setupTimedOut).toBe(false)
    expect(artifact.capturedFrameCount).toBeGreaterThan(3)
    expect(artifact.durationSec).toBeGreaterThan(0)
    expect(artifact.largestGapSec).toBeGreaterThanOrEqual(0)
    expect(artifact.scope).toBe('caller-scoped')
    expect(frameFiles).toHaveLength(artifact.capturedFrameCount)
    if (configuredEncoderAvailable !== null) {
      expect(artifact.encoder.kind).toBe(configuredEncoderAvailable ? 'ffmpeg' : 'none')
    }

    if (artifact.encoder.kind === 'ffmpeg') {
      expect(artifact.videoPath).not.toBeNull()
      const videoPath = artifact.videoPath!
      expect((await stat(videoPath)).size).toBeGreaterThan(0)

      // The file's own duration, measured here, must be the timeline the manifest states.
      const measured = await measureVideo(artifact.encoder.path, videoPath, PROBE_TIMEOUT_MS)
      expect(artifact.videoDurationSec).not.toBeNull()
      expect(artifact.videoFrameCount).toBe(measured.frameCount)
      // Why this tolerance: the encoder rounds the timeline up to its next output frame and the
      // repeated final frame costs one frame, so two frames at `fps` bound the difference. A tail
      // gap can additionally be repeated by the concat demuxer, which is why `largestGapSec` is in
      // the bound; before the F1 fix the difference was `2 x lastGap` and this failed.
      expect(Math.abs(measured.durationSec - artifact.durationSec)).toBeLessThanOrEqual(
        2 * artifact.largestGapSec + 2 / artifact.fps
      )
      // And the artefact's own measurement must be that same file, not an assumption.
      expect(Math.abs(measured.durationSec - artifact.videoDurationSec!)).toBeLessThanOrEqual(
        2 / artifact.fps
      )
      console.log(
        `[sim-recording] capturedFrameCount=${artifact.capturedFrameCount} videoFrameCount=${
          artifact.videoFrameCount
        } durationSec=${artifact.durationSec.toFixed(4)} videoDurationSec=${measured.durationSec.toFixed(
          4
        )} artifactVideoDurationSec=${artifact.videoDurationSec!.toFixed(
          4
        )} largestGapSec=${artifact.largestGapSec.toFixed(4)} fps=${artifact.fps}`
      )
      // The numbers are the evidence: keep them next to the clip so a reader does not have to
      // re-probe the file to learn what the recorder claimed.
      await writeFile(
        testInfo.outputPath('recording-summary.json'),
        `${JSON.stringify(
          {
            capturedFrameCount: artifact.capturedFrameCount,
            videoFrameCount: artifact.videoFrameCount,
            durationSec: artifact.durationSec,
            videoDurationSec: artifact.videoDurationSec,
            measuredDurationSec: measured.durationSec,
            measuredVideoFrameCount: measured.frameCount,
            largestGapSec: artifact.largestGapSec,
            fps: artifact.fps,
            timedOut: artifact.timedOut,
            setupTimedOut: artifact.setupTimedOut,
            toleranceSec: 2 * artifact.largestGapSec + 2 / artifact.fps,
            measuredDifferenceSec: Math.abs(measured.durationSec - artifact.durationSec)
          },
          null,
          2
        )}\n`
      )
    } else {
      expect(artifact.encoder.kind).toBe('none')
      expect(artifact.videoPath).toBeNull()
      expect(artifact.videoDurationSec).toBeNull()
      expect(artifact.videoFrameCount).toBeNull()
      // Degradation is a published outcome, not a silent one: keep the reason with the frames.
      await writeFile(
        testInfo.outputPath('recording-summary.json'),
        `${JSON.stringify(
          {
            capturedFrameCount: artifact.capturedFrameCount,
            videoFrameCount: artifact.videoFrameCount,
            durationSec: artifact.durationSec,
            videoDurationSec: artifact.videoDurationSec,
            largestGapSec: artifact.largestGapSec,
            fps: artifact.fps,
            timedOut: artifact.timedOut,
            setupTimedOut: artifact.setupTimedOut,
            encoder: artifact.encoder
          },
          null,
          2
        )}\n`
      )
    }
  })
})
