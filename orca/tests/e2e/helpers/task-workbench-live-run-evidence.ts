/**
 * Evidence capture shared by the issue #68 specs: the apex isolation witness, the apex build excerpt,
 * one recording per interaction, and a task-page screenshot.
 *
 * Why separate from `task-workbench-live-run-fixture.ts`: these functions write files and drive the
 * CDP recorder, while that module only reads the runtime's record. The split also keeps each helper
 * inside the 300 computed-line budget `.oxlintrc.json` gives a `.ts` file.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { OrcadApexHost } from './orcad-apex-host'
import { startRecording, type RecordingArtifact } from './sim-remote/recorder'

/**
 * One recording per act of the story the issue asks for, each spanning a real interaction.
 *
 * Why not one page-lifetime recording: a CDP screencast frame is emitted on a new composite, so an
 * idle page (a terminal pane waiting on an RPC answer) delivers nothing. Measured on this scenario, a
 * single recording held 77 frames but spanned only 3.26 s of a 20 s journey, i.e. it would have
 * claimed to cover the close while showing only the first paint. A segment around each interaction
 * starts its own capture, so every segment contains the frames of the act it names; the evidence
 * notes which segment is which, and their frame counts and durations are reported with the run.
 */
export async function recordSegment<T>(
  page: Page,
  evidenceDir: string | undefined,
  name: string,
  artifacts: RecordingArtifact[],
  act: () => Promise<T>
): Promise<T> {
  if (!evidenceDir) {
    return act()
  }
  mkdirSync(evidenceDir, { recursive: true })
  const recording = await startRecording(page, {
    outDir: path.join(evidenceDir, 'w15-real-tui-close', name),
    scope: 'caller-scoped'
  })
  try {
    return await act()
  } finally {
    const artifact = await recording.stop().catch(() => null)
    if (artifact) {
      artifacts.push(artifact)
      if (artifact.videoPath) {
        copyFileSync(artifact.videoPath, path.join(evidenceDir, `w15-seg-${name}.mp4`))
      }
    }
  }
}

export function writeApexIsolationEvidence(host: OrcadApexHost): void {
  const evidence = process.env.ORCA_E2E_EVIDENCE_DIR
  if (!evidence) {
    return
  }
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    path.join(evidence, 'apex-isolation.json'),
    JSON.stringify(
      {
        launchedApexDir: host.apexDir,
        sourceApexDir: host.sourceApexDir,
        apexCopy: host.apexCopy,
        sourceWitness: host.sourceWitness
      },
      null,
      2
    )
  )
}

/**
 * Excerpt of the apex build under test: a pre-fix artifact (red) vs a build of the fixed tree. The
 * bundle read is the host's private copy, so `apexDir` is never the artifact the test only reads;
 * `sourceApexDir` + `sourceWitness` record which bytes were copied, and `dispose()` re-checks them.
 */
export function apexBuildEvidence(host: OrcadApexHost): string {
  const bundle = path.join(host.apexDir, 'orcad.js')
  const callSites = execFileSync('grep', ['-o', 'recordTaskRecordLiveRun(', bundle], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean).length
  return JSON.stringify(
    {
      apexDir: host.apexDir,
      sourceApexDir: host.sourceApexDir,
      apexCopy: host.apexCopy,
      sourceWitness: host.sourceWitness,
      // One hit is the Store method's own definition; a fixed artifact also has the adapter's call.
      recordTaskRecordLiveRunMatches: callSites,
      readiness: host.readiness
    },
    null,
    2
  )
}

export async function capturePanelScreenshot(
  page: Page,
  evidenceDir: string | undefined,
  name: string
): Promise<void> {
  if (!evidenceDir) {
    return
  }
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: false })
}
