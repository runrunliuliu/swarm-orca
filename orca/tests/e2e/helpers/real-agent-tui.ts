import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from './orca-app'
import { getPiAgentStatusExtensionSource } from '../../../src/main/pi/agent-status-extension-source'
import type { OrcadApexHost } from './orcad-apex-host'

export {
  isProcessAlive,
  launchedAgentProcess,
  noAgentProcess,
  stopRealAgentProcess,
  type AgentProcessControl,
  type StopAgentOptions
} from './real-agent-process'

/**
 * A **real agent TUI** on a headless `orcad` apex, and the panes it runs in.
 *
 * Why `pi`: it is the agent this build ships a status extension for
 * (`main/pi/agent-status-extension-source.ts`), so its hook traffic is the product's own path end to
 * end — the extension posts `session_start`/`agent_start`/`agent_end` from the coordinates the apex
 * put in the pane's environment. That is the difference between this helper and the spec's POST-based
 * cases: nothing here invents an event.
 */

/** Provider config source. Copied, never read from this repo and never committed. */
const PI_PROVIDER_SOURCE_DIR = path.join(os.homedir(), '.pi', 'agent')
const PI_PROVIDER_FILES = ['models.json', 'models-store.json', 'auth.json', 'settings.json']

/**
 * Environment the launched `pi` must NOT inherit from the test runner, applied to the **pane** as a
 * second line of defence (`terminal.create{envToDelete}`).
 *
 * The first line is earlier and is what actually buys the isolation: `startOrcadApex()` spawns the
 * apex with `AGENT_PANE_ENV_KEYS_ISOLATED_FROM_RUNNER` (`orcad-apex-child.ts`) removed, so the
 * host-env assembler's `process.env` fallback cannot resolve the runner's real `~/.pi/agent` before it
 * resolves the throwaway dir. `envToDelete` alone is too late: `host-env/assembly.ts` builds the PTY
 * env — and installs managed extensions — before `runtime/spawn-options.ts` merges `envToDelete`.
 *
 * This list is deliberately **not** the apex list: it applies after the assembler, so it must not
 * delete `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`. Those are this case's own seeded temp
 * dir (passed in `env`); removing them here pointed the child `pi` at the apex's empty default home,
 * which is silently event-free (measured: the TUI paints, the extension is missing, no run).
 *
 * Measured, not defensive: a worker that itself runs inside `pi` carries `ORCA_PI_STATUS_OWNED`
 * (the owning pid) and `PI_SESSION_FILE`. With the owner stamp present the extension's owner guard
 * answers "another live process owns this pane" and **posts nothing at all** — the TUI loads the
 * extension (`[Extensions] orca-agent-status.ts`) and stays silent, which reads exactly like a
 * product bug. `PI_SESSION_FILE` would make the child write into the worker's own session.
 */
export const PI_ENV_TO_DELETE = [
  'PI_SESSION_FILE',
  'PI_SESSION_ID',
  'PI_CODING_AGENT',
  'ORCA_PI_SOURCE_AGENT_DIR',
  'ORCA_AGENT_PANE'
]

export type PiAgentDir = { agentDir: string; sessionDir: string }

/**
 * A throwaway pi agent dir: the user's provider config (copied) plus the product's own status
 * extension.
 *
 * Why the extension is seeded instead of left to the host-env assembler: the assembler installs it
 * into the agent dir it resolves from the PTY environment, and a run against a fresh agent dir
 * measured no `extensions/` file there — the same finding `new-workspace-swarm-pi-real-agent.spec.ts`
 * records and handles the same way. The seeded source is `getPiAgentStatusExtensionSource('pi')`,
 * i.e. exactly the bytes the product ships; the hook coordinates (port, token, paneKey) still come
 * from the environment the apex assembles for every terminal.
 */
export function seedPiAgentDir(root: string): PiAgentDir {
  const agentDir = path.join(root, 'pi-agent')
  const sessionDir = path.join(root, 'pi-sessions')
  mkdirSync(path.join(agentDir, 'extensions'), { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  for (const name of PI_PROVIDER_FILES) {
    const from = path.join(PI_PROVIDER_SOURCE_DIR, name)
    if (existsSync(from)) {
      copyFileSync(from, path.join(agentDir, name))
    }
  }
  writeFileSync(
    path.join(agentDir, 'extensions', 'orca-agent-status.ts'),
    `// @orca-managed-pi-extension\n${getPiAgentStatusExtensionSource('pi')}`
  )
  return { agentDir, sessionDir }
}

export type RealAgentTerminal = { handle: string; tabId: string; paneKey: string }

/** A real `pi` TUI in the apex worktree, launched the way a host-side create does it. */
export async function launchRealAgentTerminal(
  host: OrcadApexHost,
  worktreeId: string,
  dirs: PiAgentDir
): Promise<RealAgentTerminal> {
  const created = await host.client.call<{ terminal: RealAgentTerminal }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    // Why `command` and not `startupAgent`: the runtime refuses `startupAgent` together with a
    // caller-supplied launch environment ("startupAgent pi cannot combine with a caller-supplied
    // launch"), and the isolated agent dir is what keeps the user's own pi profile out of the run.
    command: 'pi --no-tools',
    env: {
      PI_CODING_AGENT_DIR: dirs.agentDir,
      PI_CODING_AGENT_SESSION_DIR: dirs.sessionDir,
      // Empty, not deleted: the extension's owner guard reads this stamp, and a live pid here means
      // "someone else owns this pane" — the silent-no-post case described above.
      ORCA_PI_STATUS_OWNED: '',
      ORCA_PI_TITLE_MARKER_OWNED: ''
    },
    envToDelete: PI_ENV_TO_DELETE
  })
  return created.result.terminal
}

/** The pane's own read of its screen: the proof the TUI is up before a prompt is typed into it. */
export async function waitForAgentTui(host: OrcadApexHost, handle: string): Promise<string> {
  let screen = ''
  await expect
    .poll(
      async () => {
        const read = await host.client
          .call<{ terminal: { tail: string[] } }>('terminal.read', { terminal: handle, screen: true })
          .catch(() => null)
        screen = read?.result.terminal.tail.join('\n') ?? ''
        return screen.includes('Pi ') || screen.includes('escape interrupt')
      },
      { timeout: 60_000, message: 'the real pi TUI never painted its startup screen' }
    )
    .toBe(true)
  return screen
}

/** The pane's foreground pid, for the orphan check a close has to pass. */
export async function readAgentPid(host: OrcadApexHost, handle: string): Promise<number | null> {
  const inspected = await host.client.call<{
    process: { foregroundProcessEvidence?: { fence?: { process?: { pid?: number } } } }
  }>('terminal.inspectProcess', { terminal: handle })
  return inspected.result.process.foregroundProcessEvidence?.fence?.process?.pid ?? null
}
