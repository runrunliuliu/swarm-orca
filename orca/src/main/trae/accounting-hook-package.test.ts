import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { buildTraeAccountingHookPackage } from './accounting-hook-package'

describe('Trae accounting hook package', () => {
  it('exports only verified events, with no install or trust mutation', () => {
    const files = buildTraeAccountingHookPackage('/tmp/hook package')
    const hooks = files.find((file) => file.path === join('hooks', 'hooks.json'))
    const parsed = JSON.parse(hooks!.content)
    expect(Object.keys(parsed.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop'])
    expect(parsed.hooks.Stop[0].hooks).toEqual([
      {
        type: 'command',
        command: "/bin/sh '/tmp/hook package/orca-trae-hook.sh'",
        timeout: 10
      }
    ])
    expect(files.map((file) => file.path)).toEqual([
      join('.codex-plugin', 'plugin.json'),
      join('hooks', 'hooks.json'),
      'orca-trae-hook.sh'
    ])
    const manifest = files.find((file) => file.path === join('.codex-plugin', 'plugin.json'))
    expect(JSON.parse(manifest!.content)).toMatchObject({
      name: 'orca-trae-accounting',
      hooks: './hooks/hooks.json'
    })
    expect(() => buildTraeAccountingHookPackage('relative')).toThrow(/absolute POSIX/)
  })

  it.skipIf(process.platform === 'win32')(
    'sends stdin and exact pane/launch metadata without exposing payload in argv',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-trae-hook-'))
      try {
        const packageDir = join(dir, "package with ' quote")
        await mkdir(packageDir)
        for (const file of buildTraeAccountingHookPackage(packageDir)) {
          const path = join(packageDir, file.path)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, file.content, { mode: file.mode })
        }
        await writeFile(
          join(dir, 'curl'),
          '#!/bin/sh\ncommand -p cat > "$CAPTURE_BODY"\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n',
          { mode: 0o700 }
        )
        const payload = JSON.stringify({
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'thread-1',
          transcript_path: '/sessions/thread-1.jsonl',
          cwd: '/workspace',
          model: 'test-model'
        })
        const hooks = buildTraeAccountingHookPackage(packageDir).find(
          (file) => file.path === join('hooks', 'hooks.json')
        )
        const command: string = JSON.parse(hooks!.content).hooks.SessionStart[0].hooks[0].command
        const env = {
          PATH: `${dir}:/usr/bin:/bin`,
          CAPTURE_BODY: join(dir, 'body'),
          CAPTURE_ARGS: join(dir, 'args'),
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'test-token',
          ORCA_PANE_KEY: 'tab:leaf',
          ORCA_TAB_ID: 'tab',
          ORCA_WORKTREE_ID: 'folder-1',
          ORCA_AGENT_LAUNCH_TOKEN: 'launch-1'
        }
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', command],
          env,
          input: payload,
          timeoutMs: 5000
        })
        expect(result).toMatchObject({ code: 0, stdout: '{}\n', timedOut: false })
        expect(await readFile(env.CAPTURE_BODY, 'utf8')).toBe(payload)
        const args = await readFile(env.CAPTURE_ARGS, 'utf8')
        expect(args).toContain('/hook/trae')
        expect(args).toContain('launchToken=launch-1')
        expect(args).toContain('paneKey=tab:leaf')
        expect(args).toContain('payload@-')
        expect(args).not.toContain('thread-1')

        const outside = await runProcess({
          program: '/bin/sh',
          args: ['-c', command],
          env: { PATH: '/usr/bin:/bin' },
          input: payload,
          timeoutMs: 5000
        })
        expect(outside).toMatchObject({ code: 0, stdout: '{}\n', timedOut: false })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
