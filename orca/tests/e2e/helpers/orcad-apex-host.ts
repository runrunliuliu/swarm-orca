import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import {
  assertApexSourceUnchanged,
  copyApexArtifact,
  witnessApexSource,
  type ApexArtifactCopier,
  type ApexArtifactCopy,
  type ApexSourceWitness
} from './orcad-apex-artifact'
import {
  awaitApexReadiness,
  spawnApexChild,
  terminateApexChild,
  type ApexChildSpawn,
  type ApexReadiness,
  type LaunchedApex
} from './orcad-apex-child'
import { readApexDaemonPidRecords, reclaimApexDaemons } from './orcad-apex-daemon'

export { readOrcadHookEndpoint, waitForOrcadHookEndpoint } from './orcad-apex-hook-endpoint'
export type {
  ApexArtifactCopier,
  ApexArtifactCopy,
  ApexSourceFileWitness,
  ApexSourceWitness
} from './orcad-apex-artifact'
export type { ApexChildSpawn } from './orcad-apex-child'

/**
 * A **real headless `orcad` apex** (`out/orcad/orcad.js` under the bundled bun runtime), started on
 * an isolated profile from a **private copy of the artifact** for one e2e case.
 *
 * Why this exists beside `headless-paired-runtime-host.ts`: that helper starts the *Electron* app in
 * `--serve` mode, i.e. `out/main/index.js`, which assembles the desktop observers. Issue #68 is about
 * the headless composition root having no live-run writer at all, so a test built on the Electron
 * host is structurally green whatever the fix does. Only the `orcad` entry can answer it.
 *
 * Isolation. The machine running these tests may also serve a production runtime and hold a
 * machine-wide build pointer; neither is this test's to touch, so the host is kept inside a temp
 * root and launches the copy, never the artifact it reads:
 * - `ORCA_USER_DATA` → a fresh temp dir, so no profile is read or written;
 * - `HOME` → a fresh temp dir, so agent-hook installers and `~/.local/bin` dispatchers stay local;
 * - `ORCA_BUILD_POINTER_PATH` → a temp file, because `orcad-entry.ts` publishes the machine-wide
 *   `/opt/orca/current` pointer on Linux unless `shared/build-pointer.ts:110` is redirected;
 * - `--port 0`, so the kernel picks a free port instead of colliding with a listener that may
 *   already exist on this host.
 *
 * Why the artifact is copied rather than launched in place: the pointer only moves *where the pointer
 * lives*. Publishing still rewrites the install root's own `.orca-build.json` and `.orca-cli-argv`
 * (`src/main/cli/build-pointer.ts:209-210`), so launching a production artifact in place would stamp
 * this test's `publishedAt`/publisher pid into a directory the test only means to read. The copy is a
 * real recursive copy — never a symlink or hardlink, checked by inode — and `dispose()` refuses to
 * report a clean run when the source artifact's key files or pointer link changed.
 */
export type OrcadApexHost = {
  /** Directory the apex actually runs from: the private copy, never the source artifact. */
  readonly apexDir: string
  /** Canonical artifact root the copy was taken from; the test must not write it. */
  readonly sourceApexDir: string
  readonly apexCopy: ApexArtifactCopy
  /** Fingerprint taken before the copy; `verifySourceUntouched` re-reads it. */
  readonly sourceWitness: ApexSourceWitness
  readonly bunRuntimePath: string
  readonly orcadEntryPath: string
  /** `/orca_server_ready` line decoded: the pairing offer a desktop client would consume. */
  readonly offer: { pairingUrl: string; webClientUrl?: string }
  /** The **latest** readiness line: a `restart()` replaces it. */
  readonly readiness: Record<string, unknown>
  readonly userDataDir: string
  readonly homeDir: string
  readonly buildPointerPath: string
  readonly client: RuntimeClient
  /** Everything the host wrote to stdout/stderr so far, for attaching as failure evidence. */
  output(): string
  /** SIGTERM the host, wait for exit, and start a replacement on the same profile. */
  restart(): Promise<void>
  /**
   * Stop the host, prove the source artifact stayed read-only, and remove the temp root. A stop whose
   * exit cannot be confirmed rejects, keeps the root and the child owner, and leaves `dispose()`
   * retryable.
   */
  dispose(): Promise<void>
  /** Same check `dispose()` performs, without stopping anything; returns the after-fingerprint. */
  verifySourceUntouched(): ApexSourceWitness
}

export type StartOptions = {
  apexDir?: string
  /** Root for the profile, home, pointer and artifact-copy temp dirs; removed by `dispose()`. */
  userDataParent?: string
  /** Seams for the mock-child unit test; production uses the real copier and `node:child_process`. */
  seams?: { copyApexArtifact?: ApexArtifactCopier; spawnApexChild?: ApexChildSpawn }
  /** How long a launch waits for readiness before reclaiming the child (default 60 s). */
  readinessTimeoutMs?: number
  /** SIGTERM → SIGKILL escalation window for a stop (default 20 s). */
  shutdownGraceMs?: number
  /** How long SIGKILL gets to be confirmed as an exit (default 5 s; injectable for the unit test). */
  killGraceMs?: number
  /** SIGTERM → SIGKILL windows for reclaiming the forked PTY daemon on dispose. */
  daemonGraceMs?: number
  daemonKillGraceMs?: number
}

const READINESS_TIMEOUT_MS = 60_000
const SIGTERM_GRACE_MS = 20_000

/** Where the apex under test lives. The red/green switch of issue #68 is exactly this variable. */
export function resolveOrcadApexDir(explicit?: string): string {
  const apexDir =
    explicit ?? process.env.ORCA_E2E_ORCAD_APEX ?? path.join(process.cwd(), 'out', 'orcad')
  const orcadEntryPath = path.join(apexDir, 'orcad.js')
  if (!existsSync(orcadEntryPath)) {
    throw new Error(
      `No orcad apex at ${orcadEntryPath}: build with \`pnpm build:orcad\` or point ORCA_E2E_ORCAD_APEX at a built artifact`
    )
  }
  return apexDir
}

export async function startOrcadApex(options: StartOptions = {}): Promise<OrcadApexHost> {
  const copyArtifact = options.seams?.copyApexArtifact ?? copyApexArtifact
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS
  const shutdownGraceMs = options.shutdownGraceMs ?? SIGTERM_GRACE_MS

  const configuredApexDir = resolveOrcadApexDir(options.apexDir)
  const sourceWitness = witnessApexSource(configuredApexDir)
  const root = mkdtempSync(path.join(options.userDataParent ?? os.tmpdir(), 'orca-e2e-orcad-apex-'))
  const userDataDir = path.join(root, 'userdata')
  const homeDir = path.join(root, 'home')
  const buildPointerPath = path.join(root, 'build-pointer.json')
  // The profile dir must exist but be empty: `orcad` establishes its own sqlite authority, and
  // `restart()` relaunches on the same directory without wiping what the first host flushed.
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })

  const launched: LaunchedApex[] = []
  let current: LaunchedApex | null = null
  let latestReady: ApexReadiness | null = null
  let disposed = false

  const daemonDir = path.join(userDataDir, 'daemon')

  const output = (): string =>
    launched.map((entry) => `[stdout]\n${entry.stdout}[stderr]\n${entry.stderr}`).join('\n')

  const requireReady = (): ApexReadiness => {
    if (!latestReady) {
      throw new Error(`orcad apex at ${configuredApexDir} has no readiness line`)
    }
    return latestReady
  }

  const launch = async (apexDir: string): Promise<ApexReadiness> => {
    latestReady = null
    const state = spawnApexChild({
      apexDir,
      userDataDir,
      homeDir,
      buildPointerPath,
      ...(options.seams?.spawnApexChild ? { spawn: options.seams.spawnApexChild } : {})
    })
    launched.push(state)
    current = state
    latestReady = await awaitApexReadiness(state, {
      apexDir,
      timeoutMs: readinessTimeoutMs,
      output
    })
    return latestReady
  }

  /**
   * Stop the owned child and give up ownership **only once the exit is confirmed**. A stop that
   * cannot prove the exit throws and leaves `current` in place: the child is still owned (so it can
   * be retried), and the caller may not remove the temp root it is running from.
   */
  const stopCurrent = async (): Promise<void> => {
    const target = current
    if (!target) {
      return
    }
    await terminateApexChild(target, shutdownGraceMs, options.killGraceMs)
    // Only now is the exit confirmed; until then `current` is what lets a retry reach the process.
    if (current === target) {
      current = null
    }
  }

  /**
   * Reclaim the PTY daemon this profile forked, and confirm it is gone.
   *
   * Why it belongs here: the daemon deliberately outlives its `orcad` (a product restart must not kill
   * every terminal), so a case's exit leaves one `daemon-entry.js` holding the temp profile. Once the
   * root is deleted that process is unreachable by every later cleanup, which is how this host
   * accumulated 103 orphans. Ownership is proved by the profile's own pid record plus the daemon dir
   * appearing in the command line (`orcad-apex-daemon.ts`), never by process name.
   *
   * A daemon that survives is a failure, not a detail: the root is then the evidence and the retry
   * handle, so it must not be removed. When the profile never had a daemon dir there is nothing to
   * scan for, which is also what keeps the mock-child unit tests hermetic.
   */
  const reclaimDaemon = async (): Promise<unknown | null> => {
    if (!existsSync(daemonDir)) {
      return null
    }
    try {
      await reclaimApexDaemons({
        daemonDir,
        ...(options.daemonGraceMs === undefined ? {} : { graceMs: options.daemonGraceMs }),
        ...(options.daemonKillGraceMs === undefined ? {} : { killGraceMs: options.daemonKillGraceMs })
      })
      return null
    } catch (error) {
      return error
    }
  }

  /**
   * Stop, reclaim the daemon it forked, prove the source stayed read-only, then remove the temp root —
   * in that order, and only the steps whose precondition holds. `disposed` is set **after** a disposal
   * that actually finished, so a stop that could not confirm an exit keeps the root and the child
   * owner for a retry instead of reporting a cleanup it did not perform.
   */
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return
    }
    const failures: unknown[] = []
    try {
      await stopCurrent()
    } catch (error) {
      failures.push(error)
    }
    const daemonReclaimError = await reclaimDaemon()
    if (daemonReclaimError !== null) {
      failures.push(daemonReclaimError)
    }
    try {
      assertApexSourceUnchanged(sourceWitness)
    } catch (error) {
      failures.push(error)
    }
    if (current === null && daemonReclaimError === null) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
    } else if (current === null) {
      // The daemon is still holding this profile, so the root is the evidence and the retry handle,
      // not garbage; the reclaim error above says which process refused to go.
      failures.push(
        new Error(
          `the apex daemon for ${daemonDir} (pid records: ${JSON.stringify(readApexDaemonPidRecords(daemonDir))}) ` +
            `was not reclaimed; keeping ${root} for retry`
        )
      )
    } else {
      // An orphan may still be writing into the profile and the artifact copy, so the root is the
      // evidence and the retry handle, not garbage.
      failures.push(
        new Error(
          `orcad apex pid ${String(current.child.pid)} was not confirmed gone; keeping ${root} for retry`
        )
      )
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `orcad apex cleanup failed for ${sourceWitness.dir}`)
    }
    disposed = true
  }

  const createHost = (copy: ApexArtifactCopy): OrcadApexHost => ({
    apexDir: copy.dir,
    sourceApexDir: sourceWitness.dir,
    apexCopy: copy,
    sourceWitness,
    bunRuntimePath: path.join(copy.dir, 'bun-runtime'),
    orcadEntryPath: path.join(copy.dir, 'orcad.js'),
    get offer() {
      return requireReady().offer
    },
    get readiness() {
      return requireReady().readiness
    },
    userDataDir,
    homeDir,
    buildPointerPath,
    client: new RuntimeClient(userDataDir, 30_000),
    output,
    restart: async () => {
      // The first stop is deliberately outside the try: if the old child's exit cannot be confirmed, a
      // replacement must not be launched (nothing would own the old process) and the root stays.
      await stopCurrent()
      try {
        await launch(copy.dir)
      } catch (error) {
        const failures: unknown[] = []
        try {
          await stopCurrent()
        } catch (stopError) {
          failures.push(stopError)
        }
        if (failures.length > 0) {
          // Both are kept: the launch failure explains the run, the stop failure explains why the
          // root is still on disk and why `dispose()` can be retried.
          throw new AggregateError(
            [error, ...failures],
            `orcad apex restart from ${configuredApexDir} failed and the temporary root ${root} could not be reclaimed`
          )
        }
        throw error
      }
    },
    dispose,
    verifySourceUntouched: () => assertApexSourceUnchanged(sourceWitness)
  })

  try {
    // The copy lives inside the same temp root as the profile: `dispose()` removes both, and a failed
    // start reclaims the child before it removes either.
    const copy = copyArtifact({
      sourceDir: sourceWitness.dir,
      destinationDir: path.join(root, 'apex')
    })
    await launch(copy.dir)
    return createHost(copy)
  } catch (error) {
    // Nothing else owns the child yet (the caller has no host to call `dispose()` on), so the
    // failure path has to terminate it AND confirm the exit before the temp root goes away. When it
    // cannot, the root is kept and the original error stays first in the aggregate.
    const failures: unknown[] = []
    try {
      await stopCurrent()
    } catch (stopError) {
      failures.push(stopError)
    }
    const startDaemonError = await reclaimDaemon()
    if (startDaemonError !== null) {
      failures.push(startDaemonError)
    }
    if (failures.length === 0) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch (rmError) {
        failures.push(rmError)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        `orcad apex start from ${configuredApexDir} failed and the temporary root ${root} could not be reclaimed`
      )
    }
    throw error
  }
}
