import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_DEADLINE_MS, startRecording } from './recorder'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type FrameHandler = (frame: {
  data: string
  sessionId: number
  metadata?: { timestamp?: number }
}) => void

type ProcessCallback = (error: Error | null, stdout: string, stderr: string) => void

class FakeCdpSession {
  readonly sends: string[] = []
  detached = false
  startError: Error | null = null
  private handler: FrameHandler | null = null

  on(method: string, handler: FrameHandler): void {
    if (method === 'Page.screencastFrame') {
      this.handler = handler
    }
  }

  off(method: string, handler: FrameHandler): void {
    if (method === 'Page.screencastFrame' && this.handler === handler) {
      this.handler = null
    }
  }

  async send(method: string): Promise<void> {
    this.sends.push(method)
    if (method === 'Page.startScreencast' && this.startError) {
      throw this.startError
    }
  }

  async detach(): Promise<void> {
    this.detached = true
  }

  frame(timestamp: number, data = 'frame'): void {
    this.handler?.({
      data: Buffer.from(data).toString('base64'),
      sessionId: this.sends.length + 1,
      metadata: { timestamp }
    })
  }

  /** Chromium has delivered frames with no `metadata` member at all; this is that wire shape. */
  frameWithoutMetadata(data = 'frame'): void {
    this.handler?.({ data: Buffer.from(data).toString('base64'), sessionId: this.sends.length + 1 })
  }
}

const roots: string[] = []
const mockedExecFile = vi.mocked(execFile)

/** What the recorder reads back from the produced file: last decoded frame plus frame count. */
const PROBE_PROGRESS = 'frame=11\nout_time_us=733333\nout_time_ms=733333\nprogress=end\n'

function scratch(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-recorder-test-'))
  roots.push(root)
  return root
}

function fakePage(session: FakeCdpSession): Page {
  const page = { context: () => ({ newCDPSession: async () => session }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The recorder uses only this deliberately modelled Page surface.
  return page as unknown as Page
}

/** A protocol round-trip that never settles: the wedged `newCDPSession` R1 is about. */
function wedgedPage(): Page {
  const page = { context: () => ({ newCDPSession: () => new Promise<never>(() => undefined) }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The recorder uses only this deliberately modelled Page surface.
  return page as unknown as Page
}

function processCallback(args: unknown[]): ProcessCallback {
  const callback = args.at(-1)
  if (typeof callback !== 'function') {
    throw new Error('execFile callback missing')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The callback position is verified immediately above.
  return callback as ProcessCallback
}

function noEncoder(): void {
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    processCallback(args)(new Error(`missing ${String(args[0])}`), '', '')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
    return undefined as never
  })
}

/** Answers `which`, the encoder call, and the duration/frame probe that reads the produced file. */
function successfulEncoder(ffmpegPath: string, manifests: string[] = []): void {
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    const [executable, argv] = args
    const callback = processCallback(args)
    if (executable === 'which') {
      callback(null, `${ffmpegPath}\n`, '')
    } else if (executable === ffmpegPath && Array.isArray(argv) && argv.includes('-progress')) {
      callback(null, PROBE_PROGRESS, '')
    } else if (executable === ffmpegPath && Array.isArray(argv)) {
      const inputIndex = argv.indexOf('-i') + 1
      const inputPath = argv[inputIndex]
      const videoPath = argv.at(-1)
      if (typeof inputPath !== 'string') {
        throw new Error('ffmpeg input path missing')
      }
      if (typeof videoPath !== 'string') {
        throw new Error('ffmpeg output path missing')
      }
      manifests.push(readFileSync(inputPath, 'utf8'))
      writeFileSync(videoPath, 'video')
      callback(null, '', '')
    } else {
      callback(new Error(`unexpected executable ${String(executable)}`), '', '')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
    return undefined as never
  })
}

afterEach(() => {
  mockedExecFile.mockReset()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('CDP recorder', () => {
  it('writes timestamped frames and derives duration and largest gap from paint times', async () => {
    noEncoder()
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), {
      outDir: scratch(),
      scope: 'page-lifetime'
    })

    session.frame(10, 'first')
    session.frame(10.25, 'second')
    session.frame(11.75, 'third')
    const artifact = await recording.stop()

    expect(artifact).toMatchObject({
      videoPath: null,
      capturedFrameCount: 3,
      videoFrameCount: null,
      durationSec: 1.75,
      videoDurationSec: null,
      largestGapSec: 1.5,
      fps: 15,
      scope: 'page-lifetime',
      timedOut: false,
      encoder: { kind: 'none' }
    })
    expect(JSON.parse(readFileSync(path.join(recording.framesDir, 'timings.json'), 'utf8'))).toEqual([
      { file: 'frame-0000.jpg', ts: 10 },
      { file: 'frame-0001.jpg', ts: 10.25 },
      { file: 'frame-0002.jpg', ts: 11.75 }
    ])
    expect(existsSync(path.join(recording.framesDir, 'frame-0002.jpg'))).toBe(true)
  })

  it('keeps a frame that arrives without metadata instead of throwing out of the CDP listener', async () => {
    noEncoder()
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })

    session.frame(10, 'first')
    session.frame(10.25, 'second')
    expect(() => session.frameWithoutMetadata('third')).not.toThrow()
    const artifact = await recording.stop()

    const timings = JSON.parse(
      readFileSync(path.join(recording.framesDir, 'timings.json'), 'utf8')
    ) as { file: string; ts: number }[]
    expect(timings).toHaveLength(3)
    for (const timing of timings) {
      expect(Number.isFinite(timing.ts)).toBe(true)
    }
    // The fallback clock advances from the last real timestamp by the elapsed wall clock, so the
    // timeline stays monotonic and in the same domain as the CDP timestamps.
    expect(timings[2]!.ts).toBeGreaterThanOrEqual(10.25)
    expect(artifact.capturedFrameCount).toBe(3)
    expect(artifact.durationSec).toBeGreaterThanOrEqual(0.25)
    expect(artifact.durationSec).toBeLessThan(1)
    expect(artifact.encoder.kind).toBe('none')
    expect(artifact.encoder.kind === 'none' ? artifact.encoder.reason : '').not.toContain(
      'omitted a usable timestamp'
    )
  })

  it('prefers ORCA_FFMPEG_PATH without probing PATH or imageio_ffmpeg', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '/configured/ffmpeg')
    const outputRoot = scratch()
    const session = new FakeCdpSession()
    successfulEncoder('/configured/ffmpeg')
    const recording = await startRecording(fakePage(session), { outDir: outputRoot })
    session.frame(1)

    const artifact = await recording.stop()

    expect(artifact.encoder).toEqual({ kind: 'ffmpeg', path: '/configured/ffmpeg' })
    // One encode, one probe of the file it produced: no `which` and no python fallback.
    expect(mockedExecFile.mock.calls.map(([file]) => file)).toEqual([
      '/configured/ffmpeg',
      '/configured/ffmpeg'
    ])
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(artifact.videoFrameCount).toBe(11)
    expect(artifact.videoDurationSec).toBeCloseTo(0.733333, 6)
  })

  it('uses ffmpeg on PATH before asking python for imageio_ffmpeg', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '')
    const session = new FakeCdpSession()
    successfulEncoder('/path/ffmpeg')
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(1)

    const artifact = await recording.stop()

    expect(artifact.encoder).toEqual({ kind: 'ffmpeg', path: '/path/ffmpeg' })
    expect(mockedExecFile.mock.calls.map(([file]) => file)).toEqual([
      'which',
      '/path/ffmpeg',
      '/path/ffmpeg'
    ])
  })

  it('drives the concat encoder with each metadata timestamp gap and no stretched tail', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '/configured/ffmpeg')
    const manifests: string[] = []
    successfulEncoder('/configured/ffmpeg', manifests)
    const outputRoot = scratch()
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: outputRoot })
    session.frame(1)
    session.frame(1.4)
    session.frame(2.1)

    await recording.stop()

    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toContain('duration 0.400000')
    expect(manifests[0]).toContain('duration 0.700000')
    expect(manifests[0]?.match(/frame-0002\.jpg/gu)).toHaveLength(2)
    // F1: the repeated final frame carries its own duration. Without this line the concat demuxer
    // hands it the previous gap again and the file is `durationSec + 2 x lastGap` long.
    const lastLines = manifests[0]!.trimEnd().split('\n').slice(-2)
    expect(lastLines[0]).toBe('duration 0.000001')
    expect(lastLines[1]).toContain('frame-0002.jpg')
    // F12: the manifest is scratch input, never an artefact left in the recording directory.
    expect(readdirSync(outputRoot).sort()).toEqual(['frames', 'recording.mp4'])
  })

  it('falls back to python imageio_ffmpeg after the PATH probe fails', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '')
    const ffmpegPath = '/imageio/ffmpeg'
    mockedExecFile.mockImplementation((...args: unknown[]) => {
      const [executable, argv] = args
      const callback = processCallback(args)
      if (executable === 'which') {
        callback(new Error('not found'), '', '')
      } else if (executable === 'python3') {
        callback(null, `${ffmpegPath}\n`, '')
      } else if (executable === ffmpegPath && Array.isArray(argv) && argv.includes('-progress')) {
        callback(null, PROBE_PROGRESS, '')
      } else if (executable === ffmpegPath && Array.isArray(argv)) {
        const videoPath = argv.at(-1)
        if (typeof videoPath !== 'string') {
          throw new Error('ffmpeg output path missing')
        }
        writeFileSync(videoPath, 'video')
        callback(null, '', '')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
      return undefined as never
    })
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(1)

    const artifact = await recording.stop()

    expect(artifact.encoder).toEqual({ kind: 'ffmpeg', path: ffmpegPath })
    expect(mockedExecFile.mock.calls.map(([file]) => file)).toEqual([
      'which',
      'python3',
      ffmpegPath,
      ffmpegPath
    ])
  })

  it('keeps frames and succeeds with a kind none artifact when no encoder exists', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '')
    noEncoder()
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(4, 'only frame')

    const artifact = await recording.stop()

    expect(artifact.encoder).toMatchObject({
      kind: 'none',
      reason: expect.stringContaining('No ffmpeg encoder available')
    })
    expect(artifact.videoPath).toBeNull()
    expect(artifact.sha256).toBeNull()
    expect(artifact.videoDurationSec).toBeNull()
    expect(artifact.videoFrameCount).toBeNull()
    expect(artifact.timedOut).toBe(false)
    expect(existsSync(path.join(artifact.framesDir, 'frame-0000.jpg'))).toBe(true)
    expect(existsSync(path.join(artifact.framesDir, 'timings.json'))).toBe(true)
  })

  it('degrades within the deadline instead of blocking on a slow encoder', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '/configured/ffmpeg')
    // An encoder that never answers: the capture deadline, not the encoder, has to end the wait.
    mockedExecFile.mockImplementation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
      () => undefined as never
    )
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), {
      outDir: scratch(),
      deadlineMs: 150
    })
    session.frame(1)
    session.frame(1.2)

    const startedAt = Date.now()
    const artifact = await recording.stop()
    const elapsedMs = Date.now() - startedAt

    expect(artifact.timedOut).toBe(true)
    expect(artifact.videoPath).toBeNull()
    expect(artifact.capturedFrameCount).toBe(2)
    expect(artifact.encoder).toMatchObject({
      kind: 'none',
      reason: expect.stringContaining('capture deadline')
    })
    expect(elapsedMs).toBeLessThan(3_000)
  })

  it('settles with a degraded recording when CDP setup never answers', async () => {
    // R1: `newCDPSession`/`Page.startScreencast` used to be awaited before any race, so a wedged
    // protocol call left `startRecording()` unresolved for good and the spec died of a Playwright
    // timeout. Setup now races the same deadline as everything else.
    noEncoder()
    const startedAt = Date.now()
    const recording = await startRecording(wedgedPage(), { outDir: scratch(), deadlineMs: 150 })
    const setupElapsedMs = Date.now() - startedAt

    expect(recording.running).toBe(false)
    expect(setupElapsedMs).toBeLessThan(3_000)

    const artifact = await recording.stop()
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(artifact).toMatchObject({
      videoPath: null,
      capturedFrameCount: 0,
      videoFrameCount: null,
      timedOut: true,
      setupTimedOut: true,
      encoder: { kind: 'none', reason: expect.stringContaining('capture deadline') }
    })
    // The degraded frames tree is still a valid empty timeline, not a missing directory.
    expect(JSON.parse(readFileSync(path.join(artifact.framesDir, 'timings.json'), 'utf8'))).toEqual(
      []
    )
    // Repeated stop stays cheap and returns the same artifact.
    expect(await recording.stop()).toBe(artifact)
  })

  it('keeps the capture deadline short enough for a recording spec to derive its timeout', () => {
    // The integration spec is configured from this number; a ceiling above a minute would let an
    // encoder failure masquerade as a Playwright test timeout again.
    expect(CAPTURE_DEADLINE_MS).toBeLessThanOrEqual(30_000)
  })

  it('drops a frame file whose write failed so the file count matches the timeline', async () => {
    // R4: a failed write can leave a truncated JPEG behind. It has no timing, so the recording
    // spec's `frameFiles` count would go red although the artifact correctly says degraded.
    noEncoder()
    const outputRoot = scratch()
    mkdirSync(path.join(outputRoot, 'frames'), { recursive: true })
    // Frame 1's path already exists read-only, so its write fails with EACCES.
    writeFileSync(path.join(outputRoot, 'frames', 'frame-0001.jpg'), 'stale', { mode: 0o444 })
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: outputRoot })
    session.frame(1, 'first')
    session.frame(2, 'second')

    const artifact = await recording.stop()

    const frameFiles = readdirSync(path.join(outputRoot, 'frames')).filter((file) =>
      /^frame-\d{4}\.jpg$/u.test(file)
    )
    expect(frameFiles).toEqual(['frame-0000.jpg'])
    expect(artifact.capturedFrameCount).toBe(frameFiles.length)
    const timings = JSON.parse(readFileSync(path.join(artifact.framesDir, 'timings.json'), 'utf8'))
    expect(timings).toHaveLength(1)
    expect(artifact.encoder.kind).toBe('none')
    expect(artifact.encoder.kind === 'none' ? artifact.encoder.reason : '').toContain(
      'frame-0001.jpg write failed'
    )
  })

  it('clamps a backwards frame timeline instead of writing a negative duration', async () => {
    // R10: the deleted CLI rejected this case and its test was the only pin on it; the recorder
    // clamps it, so one unit case has to say so.
    vi.stubEnv('ORCA_FFMPEG_PATH', '/configured/ffmpeg')
    const manifests: string[] = []
    successfulEncoder('/configured/ffmpeg', manifests)
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(1)
    session.frame(0.5)
    session.frame(2)

    const artifact = await recording.stop()

    expect(manifests).toHaveLength(1)
    // The backwards step becomes a zero-duration frame, never a negative one.
    expect(manifests[0]).not.toMatch(/duration -/u)
    expect(manifests[0]?.match(/duration 0\.000000/gu)).toHaveLength(1)
    expect(manifests[0]).toContain('duration 1.500000')
    expect(artifact.durationSec).toBeGreaterThanOrEqual(0)
    expect(artifact.largestGapSec).toBeGreaterThanOrEqual(0)
  })

  it('truncates a discovery failure reason instead of shipping a python traceback', async () => {
    // R5: this path skipped `summarizeReason`, so a 368-character, 5-newline traceback reached
    // `artifact.encoder.reason` and `recordingMethod.degradedReason`.
    vi.stubEnv('ORCA_FFMPEG_PATH', '')
    const traceback = [
      'Traceback (most recent call last):',
      '  File "<string>", line 1, in <module>',
      "ModuleNotFoundError: No module named 'imageio_ffmpeg'",
      'noise '.repeat(200)
    ].join('\n')
    mockedExecFile.mockImplementation((...args: unknown[]) => {
      const callback = processCallback(args)
      callback(new Error(`Command failed: ${String(args[0])}\n${traceback}`), '', '')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
      return undefined as never
    })
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(1)

    const artifact = await recording.stop()

    expect(artifact.encoder.kind).toBe('none')
    const reason = artifact.encoder.kind === 'none' ? artifact.encoder.reason : ''
    expect(reason).toContain('No ffmpeg encoder available')
    expect(reason).not.toContain('\n')
    expect(reason.length).toBeLessThanOrEqual(401)
  })

  it('truncates an encoder failure reason to its first lines', async () => {
    vi.stubEnv('ORCA_FFMPEG_PATH', '/configured/ffmpeg')
    mockedExecFile.mockImplementation((...args: unknown[]) => {
      const callback = processCallback(args)
      callback(
        new Error(`ffmpeg exited with code 1\n${'[h264] noisy diagnostic '.repeat(400)}\nmore noise`),
        '',
        ''
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tests exercise callbacks only; no caller observes the ChildProcess handle.
      return undefined as never
    })
    const session = new FakeCdpSession()
    const recording = await startRecording(fakePage(session), { outDir: scratch() })
    session.frame(1)

    const artifact = await recording.stop()

    expect(artifact.encoder.kind).toBe('none')
    const reason = artifact.encoder.kind === 'none' ? artifact.encoder.reason : ''
    expect(reason).toContain('ffmpeg exited with code 1')
    expect(reason.length).toBeLessThanOrEqual(401)
    expect(reason).not.toContain('\n')
  })

  it('does not throw when CDP setup fails and returns the same artifact from repeated stop', async () => {
    const session = new FakeCdpSession()
    session.startError = new Error('CDP unavailable')
    const recording = await startRecording(fakePage(session), { outDir: scratch() })

    const first = await recording.stop()
    const second = await recording.stop()

    expect(recording.running).toBe(false)
    expect(second).toBe(first)
    expect(first).toMatchObject({
      videoPath: null,
      capturedFrameCount: 0,
      videoFrameCount: null,
      videoDurationSec: null,
      timedOut: false,
      encoder: { kind: 'none', reason: expect.stringContaining('CDP unavailable') }
    })
  })
})
