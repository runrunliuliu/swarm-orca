import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  assertReadyRuntime,
  assertWorktreeRemoved,
  cliRouteProbeCommand,
  hasNonceOutput,
  isWithinDirectory,
  nonceCommand
} from './runtime-serve-terminal-smoke.mjs'

test('native removal may retain recovery metadata but not the target worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-smoke-removal-test-'))
  try {
    const trash = join(root, '.orca-worktree-trash')
    const worktree = join(root, 'smoke')
    mkdirSync(trash)
    assert.doesNotThrow(() => assertWorktreeRemoved(worktree))
    assert.equal(existsSync(trash), true)
    mkdirSync(worktree)
    assert.throws(() => assertWorktreeRemoved(worktree), /target directory present/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pairing must resolve the launched runtime with a ready graph before writes', () => {
  const status = { runtime: { runtimeId: 'smoke-runtime' }, graph: { state: 'ready' } }
  assert.doesNotThrow(() => assertReadyRuntime(status, 'smoke-runtime'))
  assert.throws(() => assertReadyRuntime(status, 'other-runtime'))
  assert.throws(() => assertReadyRuntime({}, undefined))
  for (const state of ['unavailable', 'starting', 'reloading']) {
    assert.throws(() => assertReadyRuntime({ ...status, graph: { state } }, 'smoke-runtime'))
  }
})

test('shell echo alone cannot prove the command ran', () => {
  const nonce = 'ORCA_SMOKE_0123456789abcdef'
  const command = nonceCommand(nonce)
  assert.equal(command.includes(nonce), false)
  assert.equal(hasNonceOutput([command, `$ echo ${nonce}`, `${nonce}-suffix`], nonce), false)
  assert.equal(hasNonceOutput([command, `${nonce}\r`], nonce), true)
  assert.equal(hasNonceOutput([], nonce), false)
})

test('CLI route probe requires real output, not the echoed command', () => {
  const command = cliRouteProbeCommand('runtime', "/profile with '$chars")
  assert.equal(command.includes('ORCA_CLI_OWNER_OK'), false)
  assert.equal(command.includes('ORCA_CLI_COMMAND'), true)
  assert.equal(command.includes('ORCA_USER_DATA_PATH'), true)
})

test('worktree must be a strict descendant of its verified base', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-smoke-path-test-'))
  try {
    const base = join(root, 'workspaces')
    const child = join(base, 'repo', 'branch')
    const sibling = join(root, 'workspaces-other')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling)
    assert.equal(isWithinDirectory(base, child), true)
    assert.equal(isWithinDirectory(base, base), false)
    assert.equal(isWithinDirectory(base, sibling), false)
    assert.equal(isWithinDirectory(base, root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
