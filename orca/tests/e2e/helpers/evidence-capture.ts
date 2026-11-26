import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import {
  startRecording,
  type Recording,
  type RecordingArtifact
} from './sim-remote/recorder'

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
