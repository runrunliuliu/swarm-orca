// A deadlined capture that must outlive its deadline: the child keeps running (unlike the default,
// which kills it) and finishes its work after the caller already got the timeout.
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitCommandTimeoutError } from './git-command-timeout'
import { gitExecFileAsync } from './git-exec-file'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createStubGitFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
  markerPath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-git-keep-running-'))
  tempRoots.push(root)
  const binDir = path.join(root, 'bin')
  const cwd = path.join(root, 'repo')
  const markerPath = path.join(root, 'finished')
  await mkdir(binDir)
  await mkdir(cwd)
  const script = path.join(binDir, 'git')
  // Why a marker file: it is the only proof that survives the caller's rejection — a killed child
  // never reaches the write, a detached one does.
  await writeFile(
    script,
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
setTimeout(() => {
  writeFileSync(process.env.ORCA_STUB_MARKER, 'finished')
}, Number(process.env.ORCA_STUB_SLEEP_MS))
`
  )
  await chmod(script, 0o755)
  return {
    cwd,
    markerPath,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_STUB_MARKER: markerPath
    }
  }
}

async function waitForMarker(markerPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return existsSync(markerPath)
}

describe.skipIf(process.platform === 'win32')('git timeout that leaves the child running', () => {
  it('lets the child finish the work after the caller stops waiting', async () => {
    const fixture = await createStubGitFixture()

    await expect(
      gitExecFileAsync(['status'], {
        cwd: fixture.cwd,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '400' },
        timeoutMsForTest: 100,
        keepRunningOnTimeout: true
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)

    await expect(waitForMarker(fixture.markerPath, 3_000)).resolves.toBe(true)
  })

  it('still kills the child when the caller did not ask to keep it', async () => {
    const fixture = await createStubGitFixture()

    await expect(
      gitExecFileAsync(['status'], {
        cwd: fixture.cwd,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '600' },
        timeoutMsForTest: 100
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)

    await expect(waitForMarker(fixture.markerPath, 1_000)).resolves.toBe(false)
  })
})
