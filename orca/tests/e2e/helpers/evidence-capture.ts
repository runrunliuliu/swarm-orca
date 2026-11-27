import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { mkdir, rm } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import {
  startRecording,
  type Recording,
  type RecordingArtifact
} from './sim-remote/recorder'
import { writeEvidencePackage } from './sim-remote/evidence-package'
import { startElectronRecording } from './electron-screencast'

export function evidenceCaptureEnabled(): boolean {
  return process.env.ORCA_CAPTURE_EVIDENCE === '1'
}

export type EvidenceCaptureResult = {
  screenshotPath?: string
  recording?: RecordingArtifact
  /**
   * Why a requested artefact was not produced. Absent when the call did everything it was asked
   * to do; a caller that ignores it is the reason a silent failure used to look like a written
   * screenshot. A degraded recording is not a skip — it arrives as `recording` and says so in
   * `encoder.kind`.
   */
  skipped?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function capturePath(name: string): { outputDir: string; screenshotPath: string; recordingDir: string } {
  const outputDir = resolve(process.cwd(), 'pr-evidence')
  const screenshotPath = resolve(outputDir, name)
  const relativePath = relative(outputDir, screenshotPath)
  if (!name || relativePath.startsWith('..') || relativePath === '' || relativePath.includes('/../')) {
    throw new Error('Evidence capture name must stay inside pr-evidence')
  }
  const extension = extname(name)
  const stem = basename(name, extension)
  return { outputDir, screenshotPath, recordingDir: resolve(outputDir, `${stem}-recording`) }
}

export async function captureEvidence(args: {
  page: Page
  name: string
  locator?: Locator
  record?: boolean
}): Promise<EvidenceCaptureResult> {
  if (!evidenceCaptureEnabled()) {
    return {}
  }

  const skipped: string[] = []
  let paths: ReturnType<typeof capturePath>
  try {
    paths = capturePath(args.name)
    await mkdir(paths.outputDir, { recursive: true })
  } catch (error) {
    return { skipped: `evidence capture skipped: ${errorMessage(error)}` }
  }

  let recording: Recording | undefined
  if (args.record) {
    try {
      recording = await startRecording(args.page, {
        outDir: paths.recordingDir,
        scope: 'caller-scoped'
      })
    } catch (error) {
      skipped.push(`recording did not start (${errorMessage(error)})`)
      recording = undefined
    }
  }

  let screenshotPath: string | undefined
  try {
    await (args.locator
      ? args.locator.screenshot({ path: paths.screenshotPath })
      : args.page.screenshot({ path: paths.screenshotPath }))
    screenshotPath = paths.screenshotPath
  } catch (error) {
    skipped.push(`screenshot was not written (${errorMessage(error)})`)
    screenshotPath = undefined
  }

  let artifact: RecordingArtifact | undefined
  if (recording) {
    try {
      artifact = await recording.stop()
    } catch (error) {
      skipped.push(`recording did not finalize (${errorMessage(error)})`)
      artifact = undefined
    }
  }
  return {
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(artifact ? { recording: artifact } : {}),
    ...(skipped.length > 0 ? { skipped: skipped.join('; ') } : {})
  }
}

export type ScenarioEvidence = {
  /** False when `ORCA_CAPTURE_EVIDENCE=1` is absent; every method is then an inert no-op. */
  enabled: boolean
  capture(name: string, what: string): Promise<void>
  /** Writes `pr-evidence/<slug>/manifest.json`; returns null when capture is disabled. */
  finish(args: {
    slug: string
    issue: number
    command: string
    notCaptured: string[]
    note?: string
  }): Promise<{ dir: string; manifestPath: string } | null>
  /** Stops the recording without publishing a package; for a failed scenario's `finally`. */
  abort(): Promise<void>
}

/**
 * Page-lifetime evidence for one scenario: screenshots as the spec reaches each state, one
 * forced-paint recording for the whole span, and the standard hashed manifest at the end.
 *
 * Why forced paint: a paint-paced screencast on a mostly static app yielded 36 frames over 1.4 s,
 * which is not a recording. `pace: 'interval'` asks Chromium for a frame every 250 ms, so the clip
 * covers the scenario's wall-clock span without depending on a mapped X window.
 */
export async function startScenarioEvidence(args: {
  page: Page
  electronApp: ElectronApplication
  slug: string
  intervalMs?: number
}): Promise<ScenarioEvidence> {
  if (!evidenceCaptureEnabled()) {
    return {
      enabled: false,
      capture: async () => undefined,
      finish: async () => null,
      abort: async () => undefined
    }
  }
  const recordingDir = resolve(
    process.cwd(),
    'pr-evidence',
    `.recording-${args.slug}-${Date.now()}`
  )
  // Opt-in: measured on a software-rendered headless Electron window, capturePage() stalls while
  // the test drives worktree creation, so a default clip would be a 4-frame slideshow. A real-time
  // clip still needs a mapped window and an external X11 grab (see the evidence doc).
  const recording =
    process.env.ORCA_E2E_EVIDENCE_RECORDING === '1'
      ? await startElectronRecording(args.electronApp, {
          outDir: recordingDir,
          scope: 'page-lifetime',
          intervalMs: args.intervalMs ?? 250
        })
      : null
  const artefacts: { file: string; what: string }[] = []
  let finished = false
  return {
    enabled: true,
    async capture(name, what) {
      const capture = await captureEvidence({ page: args.page, name })
      if (!capture.screenshotPath) {
        throw new Error(`evidence capture skipped: ${capture.skipped ?? 'no screenshot'}`)
      }
      artefacts.push({ file: capture.screenshotPath, what })
    },
    async finish(finishArgs) {
      finished = true
      const artifact = recording ? await recording.stop() : null
      try {
        return await writeEvidencePackage({
          slug: finishArgs.slug,
          lane: 'B',
          issue: finishArgs.issue,
          command: finishArgs.command,
          project: 'orca',
          notCaptured: finishArgs.notCaptured,
          redaction: {
            applied: false,
            what: 'nothing was redacted; the package is local evidence and may contain paths'
          },
          artefacts,
          recordings: artifact ? [artifact] : [],
          ...(artifact
            ? { recordingScope: 'the scenario page lifetime (forced-paint frames every 250 ms)' }
            : {}),
          cases: [
            {
              name: finishArgs.slug,
              result: 'passed',
              ...(finishArgs.note ? { note: finishArgs.note } : {})
            }
          ]
        }).then((written) => ({ dir: written.dir, manifestPath: written.manifestPath }))
      } finally {
        await rm(recordingDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    async abort() {
      if (finished) {
        return
      }
      finished = true
      await recording?.stop().catch(() => undefined)
      await rm(recordingDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
