/**
 * End-to-end degradation test: the real recorder produces a degraded artifact (frames on disk, no
 * video) and the real writer publishes it. This is the F3 boundary the review attacked — with no
 * mp4, the manifest used to say `recordings: []` and `recordingMethod.capture: 'none'`, erasing a
 * capture that was actually attempted, and the frames it retained were never collected.
 *
 * No Electron and no encoder: the CDP session is a local fake that emits three timestamped frames,
 * and `PATH` is pointed at an empty directory so discovery finds neither `which` nor `python3`.
 * That is the same "no encoder available" path a host without ffmpeg takes.
 */
import type { Page } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeEvidencePackage } from './evidence-package'
import { startRecording } from './recorder'

type FrameHandler = (frame: { data: string; sessionId: number; metadata: { timestamp: number } }) => void

function fakeCdpPage(): { page: Page; emit: FrameHandler } {
  const handlers = new Map<string, FrameHandler>()
  const session = {
    on(event: string, handler: FrameHandler) {
      handlers.set(event, handler)
    },
    off(event: string) {
      handlers.delete(event)
    },
    async send() {},
    async detach() {}
  }
  const page = {
    context: () => ({ newCDPSession: async () => session })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startRecording only uses context().newCDPSession and the session's on/send/detach, which this fixture provides.
  return {
    page: page as unknown as Page,
    emit: (frame) => handlers.get('Page.screencastFrame')!(frame)
  }
}

let originalCwd = ''
let directory = ''

beforeEach(() => {
  originalCwd = process.cwd()
  directory = mkdtempSync(join(tmpdir(), 'evidence-degraded-test-'))
  process.chdir(directory)
  execFileSync('git', ['init', '-q'])
  execFileSync('git', ['config', 'user.name', 'Evidence Test'])
  execFileSync('git', ['config', 'user.email', 'evidence@example.invalid'])
  writeFileSync('.gitignore', 'pr-evidence/\n')
  writeFileSync('scenario.spec.ts', 'export const scenario = 1\n')
  execFileSync('git', ['add', '.gitignore', 'scenario.spec.ts'])
  execFileSync('git', ['commit', '-qm', 'fixture'])
  vi.stubEnv('ORCA_FFMPEG_PATH', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
})

describe('degraded recording through the package boundary', () => {
  it('publishes the attempted capture as degraded and collects its frames', async () => {
    const { page, emit } = fakeCdpPage()
    const recording = await startRecording(page, {
      outDir: join(directory, 'recording', 'clip'),
      scope: 'page-lifetime'
    })
    for (const [index, timestamp] of [100, 100.2, 100.8].entries()) {
      emit({
        data: Buffer.from(`frame-bytes-${index}`).toString('base64'),
        sessionId: index + 1,
        metadata: { timestamp }
      })
    }
    const originalPath = process.env.PATH
    const emptyPath = join(directory, 'empty-path')
    mkdirSync(emptyPath, { recursive: true })
    process.env.PATH = emptyPath
    const artifact = await recording.stop()
    process.env.PATH = originalPath

    expect(artifact.videoPath).toBeNull()
    expect(artifact.encoder.kind).toBe('none')
    expect(artifact.capturedFrameCount).toBe(3)
    expect(artifact.durationSec).toBeCloseTo(0.8, 6)

    writeFileSync('capture.png', 'image bytes')
    const result = await writeEvidencePackage({
      slug: 'degraded-recording',
      lane: 'B',
      issue: 67,
      command: 'playwright test scenario.spec.ts',
      project: 'electron-headless',
      notCaptured: [
        'No encoder was available on this host, so the package holds frames and timings, not a clip.',
        'The recording covers the page lifetime only; nothing before first paint is captured.'
      ],
      redaction: { applied: false, what: 'Synthetic frames only; nothing was redacted.' },
      artefacts: [{ file: 'capture.png', what: 'synthetic result' }],
      cases: [{ name: 'degraded capture', result: 'passed', note: 'capture is the subject' }],
      recordings: [{ ...artifact, tree: 'before' }]
    })
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))

    expect(manifest.recordingMethod).toMatchObject({
      capture: 'degraded',
      degraded: true,
      encoder: ['none'],
      scope: 'page-lifetime',
      counts: { captured: 0, degraded: 1 }
    })
    expect(manifest.recordingMethod.degradedReason).toContain('No ffmpeg encoder available')
    expect(manifest.recordings[0]).toMatchObject({
      tree: 'before',
      videoPath: null,
      file: null,
      sha256: null,
      degraded: true,
      capturedFrameCount: 3,
      durationSec: expect.closeTo(0.8, 6),
      fps: 15,
      encoder: { kind: 'none' },
      framesDir: 'before-frames'
    })
    expect(manifest.recordings[0].frames.map((frame: { path: string }) => frame.path)).toEqual([
      'before-frames/frame-0000.jpg',
      'before-frames/frame-0001.jpg',
      'before-frames/frame-0002.jpg',
      'before-frames/timings.json'
    ])
    // The excerpt quoted in the report comes from this executed manifest, not from prose.
    console.log(
      `[degraded-package] ${JSON.stringify(
        {
          recordingMethod: manifest.recordingMethod,
          recordings: [
            {
              tree: manifest.recordings[0].tree,
              videoPath: manifest.recordings[0].videoPath,
              degraded: manifest.recordings[0].degraded,
              encoder: manifest.recordings[0].encoder,
              capturedFrameCount: manifest.recordings[0].capturedFrameCount,
              durationSec: manifest.recordings[0].durationSec,
              framesDir: manifest.recordings[0].framesDir,
              frames: manifest.recordings[0].frames.map(
                (frame: { path: string; bytes: number; sha256: string }) => ({
                  path: frame.path,
                  bytes: frame.bytes,
                  sha256: `${frame.sha256.slice(0, 12)}…`
                })
              )
            }
          ]
        },
        null,
        2
      )}`
    )
  })
})
