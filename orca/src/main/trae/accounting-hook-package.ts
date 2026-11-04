import { join, posix } from 'node:path'
import { getManagedScript } from '../claude/hook-script'
import { quotePosixShellString } from '../agent-hooks/posix-hook-command'

/** Export only: native Trae installation and hook trust remain explicit operator actions. */
export function buildTraeAccountingHookPackage(directory: string) {
  if (!posix.isAbsolute(directory) || [...directory].some((char) => char.charCodeAt(0) < 32)) {
    throw new Error('Trae accounting hooks require an absolute POSIX package directory.')
  }
  const scriptPath = posix.join(directory, 'orca-trae-hook.sh')
  const command = `/bin/sh ${quotePosixShellString(scriptPath)}`
  return [
    {
      path: join('.codex-plugin', 'plugin.json'),
      mode: 0o600,
      content: `${JSON.stringify(
        {
          name: 'orca-trae-accounting',
          version: '0.1.0',
          description:
            'Opt-in Orca session attribution for local Trae 0.209.1 --no-daemon workers.',
          hooks: './hooks/hooks.json'
        },
        null,
        2
      )}\n`
    },
    {
      path: join('hooks', 'hooks.json'),
      mode: 0o600,
      content: `${JSON.stringify(
        {
          hooks: Object.fromEntries(
            ['SessionStart', 'UserPromptSubmit', 'Stop'].map((event) => [
              event,
              [
                {
                  hooks: [{ type: 'command', command, timeout: 10 }]
                }
              ]
            ])
          )
        },
        null,
        2
      )}\n`
    },
    {
      path: 'orca-trae-hook.sh',
      mode: 0o700,
      content: getManagedScript('posix', { source: 'trae' })
    }
  ]
}
