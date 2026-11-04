import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const PAYLOAD = 'first line\nsecond line with "quotes" and $literal'
const COMMAND = `printf '%s\\n' '${PAYLOAD}' >> "$ORCA_TEST_OUTPUT"; printf 'WORKER_%s\\n' DONE`

async function launch(disableUpdate: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'orca-worker-update-'))
  const outputPath = join(root, 'payload.txt')
  // Mirrors the blocking read in oh-my-zsh; never sources the user's rc or updater.
  writeFileSync(
    join(root, '.zshrc'),
    `if [[ "$DISABLE_AUTO_UPDATE" != true ]]; then
  printf 'UPDATE_PROMPT [Y/n] '
  read -r -k 1 option
fi
PS1='worker-test> '
`
  )
  vi.stubEnv('HOME', root)
  vi.stubEnv('ZDOTDIR', root)
  vi.stubEnv('ORCA_ORIG_ZDOTDIR', root)
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca'))
  let session: Session | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const events: string[] = []
  let output = ''
  try {
    const subprocess = await createPtySubprocess({
      sessionId: 'worker-update-prompt',
      cols: 240,
      rows: 30,
      cwd: root,
      shellOverride: '/bin/zsh',
      launchAgent: 'trae',
      command: COMMAND,
      env: {
        HOME: root,
        SHELL: '/bin/zsh',
        TERM: 'xterm-256color',
        ORCA_TEST_OUTPUT: outputPath,
        DISABLE_AUTO_UPDATE: disableUpdate ? 'true' : 'false'
      }
    })
    session = new Session({
      sessionId: 'worker-update-prompt',
      cols: 240,
      rows: 30,
      launchAgent: 'trae',
      subprocess,
      shellReadySupported: true,
      shellReadyTimeoutMs: disableUpdate ? 5000 : 1000,
      reportReadinessEvent: (event) => events.push(event)
    })
    const active = session
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(JSON.stringify({ output, events }))), 8000)
      active.attachClient({
        onExit: () => reject(new Error('Shell exited before startup was observed')),
        onData: (data) => {
          output += data
          if (output.includes(disableUpdate ? 'WORKER_DONE' : 'bad pattern:')) {
            resolve()
          }
        }
      })
      active.write(buildStartupCommandSubmission(COMMAND, { submit: '\n', bracketedPasteSafe: true }))
    })
    return {
      output,
      events,
      readiness: active.shellState,
      payload: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null
    }
  } finally {
    clearTimeout(timer)
    if (session) {
      await session.forceKillAndWaitForExit(3000)
      session.dispose()
    }
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32' || !existsSync('/bin/zsh'))(
  'managed Worker shell update prompt',
  () => {
    it('reproduces timeout release into the blocking update prompt', async () => {
      const result = await launch(false)
      expect(result.events).toContain('shell-ready-timeout')
      expect(result.readiness).toBe('timed_out')
      expect(result.output).toContain('UPDATE_PROMPT')
      expect(result.output).toContain('bad pattern:')
      expect(result.payload).toBeNull()
    })

    it('forwards the launch environment and delivers multiline input exactly once after readiness', async () => {
      const result = await launch(true)
      expect(result.events).not.toContain('shell-ready-timeout')
      expect(result.readiness).toBe('ready')
      expect(result.output).not.toContain('UPDATE_PROMPT')
      expect(result.output).not.toContain('bad pattern:')
      const promptIndex = result.output.indexOf('worker-test> ')
      const doneIndex = result.output.indexOf('WORKER_DONE')
      expect(promptIndex).toBeGreaterThanOrEqual(0)
      expect(doneIndex).toBeGreaterThan(promptIndex)
      // The barrier strips only the startup marker, not later prompt markers.
      expect(result.output.slice(0, doneIndex)).not.toContain('orca-shell-ready')
      expect(result.payload).toBe(`${PAYLOAD}\n`)
    })
  }
)
