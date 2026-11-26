import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writeEvidencePackage,
  type EvidenceCase,
  type EvidenceRecording
} from './evidence-package'

let originalCwd = ''
let directory = ''

beforeEach(() => {
  originalCwd = process.cwd()
  directory = mkdtempSync(join(tmpdir(), 'evidence-package-test-'))
  process.chdir(directory)
  execFileSync('git', ['init', '-q'])
  execFileSync('git', ['config', 'user.name', 'Evidence Test'])
  execFileSync('git', ['config', 'user.email', 'evidence@example.invalid'])
  // `**/pr-evidence/` keeps the writer's own staging directory out of `dirty` when a test runs
  // from a subdirectory.
  writeFileSync('.gitignore', 'pr-evidence/\n**/pr-evidence/\n')
  mkdirSync('out/main', { recursive: true })
  writeFileSync('out/main/index.js', 'built bytes')
  writeFileSync('scenario.spec.ts', 'export const scenario = 1\n')
  execFileSync('git', ['add', '.gitignore', 'out/main/index.js', 'scenario.spec.ts'])
  execFileSync('git', ['commit', '-qm', 'fixture'])
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
})

function packageArgs() {
  writeFileSync('capture.png', 'image bytes')
  return {
    slug: 'unit-evidence',
    lane: 'B' as const,
    issue: 67,
    command: 'playwright test scenario.spec.ts --project=electron-headless',
    project: 'electron-headless',
    notCaptured: ['No real remote host was used.'],
    redaction: { applied: false, what: 'Synthetic fixture only; nothing was redacted.' },
    artefacts: [{ file: 'capture.png', what: 'synthetic result' }],
    cases: [{ name: 'scenario', result: 'passed' as const }],
    runs: [{ attempt: 1, result: 'passed' }]
  }
}

function writeFrames(): string {
  const framesDir = join(directory, 'recording', 'frames')
  mkdirSync(framesDir, { recursive: true })
  writeFileSync(join(framesDir, 'frame-0000.jpg'), 'frame zero')
  writeFileSync(join(framesDir, 'frame-0001.jpg'), 'frame one')
  writeFileSync(
    join(framesDir, 'timings.json'),
    `${JSON.stringify([
      { file: 'frame-0000.jpg', ts: 1 },
      { file: 'frame-0001.jpg', ts: 1.4 }
    ])}\n`
  )
  return framesDir
}

function readManifest(manifestPath: string) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

describe('writeEvidencePackage', () => {
  it('refuses an empty notCaptured before writing a package', async () => {
    const args = packageArgs()
    await expect(writeEvidencePackage({ ...args, notCaptured: [] })).rejects.toThrow(
      'notCaptured must contain at least one explicit limitation'
    )
    expect(() => readFileSync('pr-evidence/unit-evidence/manifest.json')).toThrow()
  })

  it('derives contract fields and hashes copied artefacts and build bytes', async () => {
    writeFileSync('scenario.spec.ts', 'export const scenario = 2\n')
    const result = await writeEvidencePackage(packageArgs())
    const manifest = readManifest(result.manifestPath)

    expect(manifest).toMatchObject({
      lane: 'B',
      project: 'electron-headless',
      cases: [{ name: 'scenario', result: 'passed' }],
      skipped: [],
      notCaptured: ['No real remote host was used.'],
      redaction: { applied: false }
    })
    expect(manifest.repoSha).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.dirty.tracked).toEqual([
      expect.objectContaining({ file: 'scenario.spec.ts', status: ' M' })
    ])
    expect(manifest.dirty.specSha256).toBe(manifest.specs[0].sha256)
    expect(manifest.build.files).toEqual([
      expect.objectContaining({ path: 'main/index.js', sha256: expect.any(String) })
    ])
    expect(manifest.artefacts).toEqual([
      expect.objectContaining({ path: 'capture.png', sha256: expect.any(String) })
    ])
    expect(manifest.screenshots).toHaveLength(1)
  })

  it('rewrites the same slug deterministically without appending', async () => {
    const args = packageArgs()
    const first = await writeEvidencePackage(args)
    const firstBytes = readFileSync(first.manifestPath, 'utf8')
    const second = await writeEvidencePackage(args)

    expect(second.manifestSha256).toBe(first.manifestSha256)
    expect(readFileSync(second.manifestPath, 'utf8')).toBe(firstBytes)
    expect(JSON.parse(firstBytes).artefacts).toHaveLength(1)
  })

  it('publishes a degraded recording and collects its retained frames', async () => {
    const framesDir = writeFrames()
    const result = await writeEvidencePackage({
      ...packageArgs(),
      recordings: [
        {
          tree: 'before',
          videoPath: null,
          framesDir,
          capturedFrameCount: 2,
          videoFrameCount: null,
          durationSec: 0.4,
          videoDurationSec: null,
          largestGapSec: 0.4,
          fps: 15,
          encoder: {
            kind: 'none',
            reason: 'No ffmpeg encoder available: ffmpeg was not found on PATH'
          },
          scope: 'page-lifetime',
          sha256: null,
          timedOut: false
        }
      ],
      recordingScope: 'page lifetime; first paint to teardown'
    })
    const manifest = readManifest(result.manifestPath)

    expect(manifest.recordings).toHaveLength(1)
    expect(manifest.recordings[0]).toMatchObject({
      tree: 'before',
      videoPath: null,
      file: null,
      sha256: null,
      degraded: true,
      capturedFrameCount: 2,
      videoFrameCount: null,
      durationSec: 0.4,
      videoDurationSec: null,
      largestGapSec: 0.4,
      fps: 15,
      encoder: { kind: 'none' },
      framesDir: 'before-frames',
      timedOut: false
    })
    expect(manifest.recordings[0].frames).toEqual([
      expect.objectContaining({ path: 'before-frames/frame-0000.jpg' }),
      expect.objectContaining({ path: 'before-frames/frame-0001.jpg' }),
      expect.objectContaining({ path: 'before-frames/timings.json' })
    ])
    const copiedHashes = manifest.recordings[0].frames.map((frame: { path: string; sha256: string }) => {
      const bytes = readFileSync(join(result.dir, frame.path))
      expect(frame.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      return frame.path
    })
    expect(copiedHashes).toHaveLength(3)
    expect(manifest.recordingMethod).toMatchObject({
      capture: 'degraded',
      degraded: true,
      encoder: ['none'],
      scope: 'page lifetime; first paint to teardown',
      counts: { captured: 0, degraded: 1 }
    })
    expect(manifest.recordingMethod.degradedReason).toContain('No ffmpeg encoder available')
  })

  it('carries a captured recording pacing, encoder and scope into the manifest', async () => {
    mkdirSync(join(directory, 'clips'), { recursive: true })
    writeFileSync(join(directory, 'clips', 'recording.mp4'), 'mp4 bytes')
    const result = await writeEvidencePackage({
      ...packageArgs(),
      recordings: [
        {
          tree: 'after',
          videoPath: join(directory, 'clips', 'recording.mp4'),
          capturedFrameCount: 32,
          videoFrameCount: 11,
          durationSec: 0.6404,
          videoDurationSec: 0.7334,
          largestGapSec: 0.047,
          fps: 15,
          encoder: { kind: 'ffmpeg', path: '/usr/bin/ffmpeg' },
          scope: 'page-lifetime',
          timedOut: false
        }
      ]
    })
    const manifest = readManifest(result.manifestPath)

    expect(manifest.recordings[0]).toMatchObject({
      tree: 'after',
      videoPath: 'after.mp4',
      file: 'after.mp4',
      bytes: 9,
      sha256: createHash('sha256').update('mp4 bytes').digest('hex'),
      degraded: false,
      capturedFrameCount: 32,
      videoFrameCount: 11,
      durationSec: 0.6404,
      videoDurationSec: 0.7334,
      largestGapSec: 0.047,
      fps: 15,
      encoder: { kind: 'ffmpeg' },
      framesDir: null
    })
    expect(existsSync(join(result.dir, 'after.mp4'))).toBe(true)
    // The scope came from the artifact the caller declared, not from a sentence the writer made up.
    expect(manifest.recordingMethod).toMatchObject({
      capture: 'CDP Page.startScreencast on the Electron page',
      degraded: false,
      encoder: ['ffmpeg'],
      scope: 'page-lifetime',
      counts: { captured: 1, degraded: 0 }
    })
  })

  it('records retries as unknown unless the caller or every run declares them', async () => {
    const unknown = readManifest((await writeEvidencePackage(packageArgs())).manifestPath)
    expect(unknown.retries).toBeNull()

    const declared = readManifest(
      (await writeEvidencePackage({ ...packageArgs(), retries: 2 })).manifestPath
    )
    expect(declared.retries).toBe(2)

    const fromRuns = readManifest(
      (
        await writeEvidencePackage({
          ...packageArgs(),
          runs: [
            { attempt: 1, retries: 1 },
            { attempt: 2, retries: 1 }
          ]
        })
      ).manifestPath
    )
    expect(fromRuns.retries).toBe(1)
  })

  it('rejects a free-text case result and derives skipped from the enum', async () => {
    const freeText = { name: 'scenario', result: 'PASSED (capture ran; asserts nothing)' }
    await expect(
      writeEvidencePackage({ ...packageArgs(), cases: [freeText as unknown as EvidenceCase] })
    ).rejects.toThrow('cases[0].result must be one of')
    expect(existsSync(join(directory, 'pr-evidence', 'unit-evidence', 'manifest.json'))).toBe(false)

    const result = await writeEvidencePackage({
      ...packageArgs(),
      cases: [{ name: 'permission', result: 'skipped', note: 'needs a second account' }]
    })
    const manifest = readManifest(result.manifestPath)
    expect(manifest.skipped).toEqual([
      { name: 'permission', result: 'skipped', note: 'needs a second account' }
    ])
  })

  it('rejects a redaction that does not say what was redacted', async () => {
    await expect(
      writeEvidencePackage({ ...packageArgs(), redaction: { applied: false, what: '   ' } })
    ).rejects.toThrow('redaction.what must say what was, or was not, redacted')
  })

  it('requires a scope once a recording is supplied', async () => {
    const framesDir = writeFrames()
    const recording = {
      videoPath: null,
      framesDir,
      encoder: { kind: 'none', reason: 'no encoder' }
    } as EvidenceRecording
    await expect(
      writeEvidencePackage({ ...packageArgs(), recordings: [recording] })
    ).rejects.toThrow('recordingScope must state what the recording covers')
  })

  it('hashes dirty inputs from the repository root when the caller runs in a subdirectory', async () => {
    const args = packageArgs()
    mkdirSync('nested', { recursive: true })
    process.chdir(join(directory, 'nested'))
    // A tracked file changed at the repository root, and the command (correctly) names it relative
    // to this subdirectory. The old reader resolved `git status` output against `cwd`, so every
    // hash came out null and the manifest admitted the gap in prose instead of fixing it.
    writeFileSync(join(directory, 'scenario.spec.ts'), 'export const scenario = 2\n')
    const result = await writeEvidencePackage({
      ...args,
      slug: 'subdir-evidence',
      command: 'playwright test ../scenario.spec.ts --project=electron-headless',
      artefacts: [{ file: join(directory, 'capture.png'), what: 'synthetic result' }]
    })
    const manifest = readManifest(result.manifestPath)

    expect(manifest.dirty.tracked).toEqual([
      expect.objectContaining({
        file: 'scenario.spec.ts',
        status: ' M',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    ])
    expect(manifest.dirty.untracked).toEqual([
      expect.objectContaining({
        file: 'capture.png',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    ])
  })

  it('ships the patch it hashes and records the archived spec beside the command', async () => {
    writeFileSync('capture-instrument-issue-67-record.spec.ts', 'export const archived = 1\n')
    writeFileSync('scenario.spec.ts', 'export const scenario = 2\n')
    const result = await writeEvidencePackage({
      ...packageArgs(),
      command: 'playwright test tests/e2e/capture-issue-67-record.spec.ts',
      specArchive: {
        file: 'capture-instrument-issue-67-record.spec.ts',
        what: 'archived temporary instrument'
      }
    })
    const manifest = readManifest(result.manifestPath)

    expect(manifest.specsMissing).toEqual(['tests/e2e/capture-issue-67-record.spec.ts'])
    expect(manifest.specArchive).toMatchObject({
      path: 'specs/capture-instrument-issue-67-record.spec.ts',
      source: 'capture-instrument-issue-67-record.spec.ts',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      what: 'archived temporary instrument'
    })
    expect(readFileSync(join(result.dir, manifest.specArchive.path), 'utf8')).toBe(
      'export const archived = 1\n'
    )

    // `patchSha256` used to name a diff nobody could open. It is now the hash of the shipped bytes.
    const patch = readFileSync(join(result.dir, 'dirty.patch'))
    expect(manifest.dirty.patch).toEqual({
      path: 'dirty.patch',
      bytes: patch.length,
      sha256: createHash('sha256').update(patch).digest('hex')
    })
    expect(manifest.dirty.patchSha256).toBe(manifest.dirty.patch.sha256)
    expect(patch.toString('utf8')).toContain('scenario.spec.ts')
  })
})
