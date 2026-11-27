/**
 * Forced-paint pacing: a paint-paced screencast on a static page delivered 36 frames over 1.4 s
 * for the auto_evolve evidence run, which is not a recording. `pace: 'interval'` asks Chromium for
 * a screenshot on a timer instead. No Electron and no encoder here: the CDP session is a local
 * fake, and `PATH` points at an empty directory so `stop()` publishes the degraded artifact whose
 * frames are the thing under test.
 */
import type { Page } from '@stablyai/playwright-test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecording } from './recorder'

type SendCall = { method: string; params?: unknown }

function fakeCdpPage(): { page: Page; sends: SendCall[] } {
  const sends: SendCall[] = []
  const session = {
    on() {},
    off() {},
    async send(method: string, params?: unknown) {
      sends.push({ method, params })
      if (method === 'Page.captureScreenshot') {
        return { data: Buffer.from(`frame-${sends.length}`).toString('base64') }
      }
      return {}
    },
    async detach() {}
  }
  const page = { context: () => ({ newCDPSession: async () => session }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startRecording only uses context().newCDPSession and the session's on/off/send/detach, which this fixture provides.
  return { page: page as unknown as Page, sends }
}

let originalCwd = ''
let directory = ''
let originalPath: string | undefined

beforeEach(() => {
  originalCwd = process.cwd()
  directory = mkdtempSync(join(tmpdir(), 'recorder-interval-test-'))
  process.chdir(directory)
  originalPath = process.env.PATH
  process.env.PATH = join(directory, 'empty-path')
  mkdirSync(process.env.PATH, { recursive: true })
  vi.stubEnv('ORCA_FFMPEG_PATH', '')
})

afterEach(() => {
  vi.useRealTimers()
  process.env.PATH = originalPath
  vi.unstubAllEnvs()
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
})

describe('forced-paint recording', () => {
  it('asks Chromium for frames on the interval instead of waiting for a paint', async () => {
    vi.useFakeTimers()
    const { page, sends } = fakeCdpPage()
    const recording = await startRecording(page, {
      outDir: join(directory, 'clip'),
      scope: 'page-lifetime',
      pace: 'interval',
      intervalMs: 50
    })
    await vi.advanceTimersByTimeAsync(220)
    vi.useRealTimers()
    const artifact = await recording.stop()

    const captures = sends.filter((call) => call.method === 'Page.captureScreenshot')
    expect(sends.some((call) => call.method === 'Page.startScreencast')).toBe(false)
    expect(captures.length).toBeGreaterThanOrEqual(3)
    expect(artifact.capturedFrameCount).toBeGreaterThanOrEqual(3)
    expect(artifact.durationSec).toBeGreaterThan(0)
    // No encoder on the empty PATH: the frames must survive as the degraded artifact.
    expect(artifact.videoPath).toBeNull()
    expect(artifact.encoder.kind).toBe('none')
  })

  it('keeps paint pacing as the default', async () => {
    const { page, sends } = fakeCdpPage()
    const recording = await startRecording(page, {
      outDir: join(directory, 'paint-clip'),
      scope: 'page-lifetime'
    })
    expect(sends.some((call) => call.method === 'Page.startScreencast')).toBe(true)
    const artifact = await recording.stop()
    expect(artifact.capturedFrameCount).toBe(0)
  })
})
