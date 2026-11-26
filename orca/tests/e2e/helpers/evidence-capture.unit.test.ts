import type { Page } from '@stablyai/playwright-test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureEvidence, evidenceCaptureEnabled } from './evidence-capture'

let originalCwd = ''
let directory = ''

beforeEach(() => {
  originalCwd = process.cwd()
  directory = mkdtempSync(join(tmpdir(), 'evidence-capture-test-'))
  process.chdir(directory)
})

afterEach(() => {
  vi.unstubAllEnvs()
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
})

function fakePage(): { page: Page; screenshot: ReturnType<typeof vi.fn> } {
  const screenshot = vi.fn(async ({ path }: { path: string }) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'screenshot')
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captureEvidence only uses these Page members in this pure unit fixture.
  const page = { screenshot, context: () => { throw new Error('No CDP in unit fixture') } } as unknown as Page
  return { page, screenshot }
}

describe('captureEvidence', () => {
  it('is disabled unless ORCA_CAPTURE_EVIDENCE is exactly 1', async () => {
    vi.stubEnv('ORCA_CAPTURE_EVIDENCE', 'true')
    const { page, screenshot } = fakePage()

    expect(evidenceCaptureEnabled()).toBe(false)
    await expect(captureEvidence({ page, name: 'disabled.png', record: true })).resolves.toEqual({})
    expect(screenshot).not.toHaveBeenCalled()
  })

  it('captures an enabled screenshot through the shared output convention', async () => {
    vi.stubEnv('ORCA_CAPTURE_EVIDENCE', '1')
    const { page, screenshot } = fakePage()
    const result = await captureEvidence({ page, name: '01-scenario-enabled.png' })

    expect(result.screenshotPath).toBe(join(directory, 'pr-evidence', '01-scenario-enabled.png'))
    expect(result.skipped).toBeUndefined()
    expect(screenshot).toHaveBeenCalledOnce()
  })

  it('returns a skipped reason for a name that would escape pr-evidence', async () => {
    // Why a reason and not `{}`: an invalid name used to look exactly like a successful no-op, so
    // the author believed evidence existed while nothing was written (review F10).
    vi.stubEnv('ORCA_CAPTURE_EVIDENCE', '1')
    const { page, screenshot } = fakePage()
    const result = await captureEvidence({ page, name: '../escape.png' })

    expect(result.skipped).toContain('Evidence capture name must stay inside pr-evidence')
    expect(result.screenshotPath).toBeUndefined()
    expect(screenshot).not.toHaveBeenCalled()
  })

  it('returns a skipped reason when the screenshot cannot be written', async () => {
    vi.stubEnv('ORCA_CAPTURE_EVIDENCE', '1')
    const screenshot = vi.fn(async () => {
      throw new Error('EPERM: operation not permitted')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captureEvidence only uses these Page members in this pure unit fixture.
    const page = { screenshot, context: () => { throw new Error('No CDP in unit fixture') } } as unknown as Page
    const result = await captureEvidence({ page, name: '03-failed.png' })

    expect(result.screenshotPath).toBeUndefined()
    expect(result.skipped).toContain('screenshot was not written')
    expect(result.skipped).toContain('EPERM')
  })

  it('returns a degraded recording artifact instead of throwing when CDP is unavailable', async () => {
    vi.stubEnv('ORCA_CAPTURE_EVIDENCE', '1')
    const { page } = fakePage()
    const result = await captureEvidence({ page, name: '02-scenario-recording.png', record: true })

    expect(result.screenshotPath).toBeDefined()
    expect(result.recording).toMatchObject({
      videoPath: null,
      capturedFrameCount: 0,
      encoder: { kind: 'none' },
      scope: 'caller-scoped'
    })
  })
})
