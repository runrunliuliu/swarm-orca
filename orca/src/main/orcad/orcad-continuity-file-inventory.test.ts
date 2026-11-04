import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  continuityFileInventory,
  type ContinuityInventoryScope
} from './orcad-continuity-file-inventory'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))

describe.runIf(process.platform === 'linux')('exact continuity file inventory', () => {
  let root: string
  let scope: ContinuityInventoryScope
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-file-inventory-'))
    scope = continuityInventoryFixture(root)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })
  const pin = () => continuityFileInventory(scope).inventoryCanonicalSha256

  it('has deterministic raw-byte file pins and an explicitly separate canonical inventory digest', () => {
    const result = continuityFileInventory(scope)
    expect(result.inventoryCanonicalSha256).toBe(hashCanonical(result.inventory))
    expect(result.inventory.files).toHaveLength(4)
    expect(result.inventory.directories).toHaveLength(2)
    expect(result.executionAuthorized).toBe(false)
    expect(result).toEqual(continuityFileInventory(scope))
    expect(result.inventory.files[0]).toMatchObject({ kind: 'file', sizeBytes: 3 })
    expect(JSON.stringify(result)).not.toContain('verified":true')
  })

  it('includes hidden files, nested directories and lock objects without exclusions', () => {
    const before = pin()
    mkdirSync(join(scope.monitorStateRoot, '.hidden'), { mode: 0o700 })
    writeFileSync(join(scope.monitorStateRoot, '.hidden', 'receipt'), 'x', { mode: 0o600 })
    writeFileSync(join(scope.monitorStateRoot, 'monitor.lock'), '', { mode: 0o600 })
    expect(pin()).not.toBe(before)
    expect(continuityFileInventory(scope).inventory.files).toHaveLength(6)
  })

  it.each(['change', 'add', 'delete', 'replace', 'head', 'directory'])(
    'detects %s after the source snapshot',
    (operation) => {
      const before = pin()
      const file = join(scope.monitorStateRoot, 'state.json')
      if (operation === 'change') {
        writeFileSync(file, '{"new":true}')
      }
      if (operation === 'add') {
        writeFileSync(join(scope.monitorStateRoot, 'STOP'), '', { mode: 0o600 })
      }
      if (operation === 'delete') {
        rmSync(file)
      }
      if (operation === 'replace') {
        renameSync(file, join(root, 'old-state'))
        copyFileSync(join(root, 'old-state'), file)
        chmodSync(file, 0o600)
      }
      if (operation === 'head') {
        writeFileSync(scope.files[0], '{"different":true}')
      }
      if (operation === 'directory') {
        mkdirSync(join(scope.monitorStateRoot, 'empty'), { mode: 0o700 })
      }
      expect(pin()).not.toBe(before)
    }
  )

  it('refuses symlinks, path aliases, hardlinks and public state files', () => {
    const alias = join(root, 'alias')
    symlinkSync(scope.monitorStateRoot, alias)
    expect(() => continuityFileInventory({ ...scope, monitorStateRoot: alias })).toThrow(
      'nonsymlink'
    )
    expect(() =>
      continuityFileInventory({ ...scope, files: [join(root, 'alias', 'state.json')] })
    ).toThrow('nonsymlink')
    const link = join(scope.monitorStateRoot, 'link')
    linkSync(scope.files[0], link)
    expect(pin).toThrow('unaliased')
    rmSync(link)
    chmodSync(scope.files[0], 0o644)
    expect(pin).toThrow('private owned')
  })

  it('refuses overlapping roots and duplicate explicit paths, but deduplicates files already in a root', () => {
    expect(() =>
      continuityFileInventory({ ...scope, continuationStateRoot: scope.monitorStateRoot })
    ).toThrow('overlapping')
    expect(() =>
      continuityFileInventory({ ...scope, files: [...scope.files, ...scope.files] })
    ).toThrow('duplicate')
    const result = continuityFileInventory({
      ...scope,
      files: [...scope.files, join(scope.monitorStateRoot, 'state.json')]
    })
    expect(result.inventory.files).toHaveLength(4)
  })

  it('bounds individual file size before allocation', () => {
    truncateSync(scope.files[0], 8 * 1024 * 1024 + 1)
    expect(pin).toThrow('byte limit')
  })

  it('refuses content drift during an open-descriptor read', () => {
    const read = fs.readSync
    vi.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      const count = read(...args)
      writeFileSync(join(scope.monitorStateRoot, 'monitor-stop.json'), 'changed')
      return count
    })
    expect(pin).toThrow('changed during read')
  })

  it('does not skip special files or symlinks below a state root', () => {
    symlinkSync(scope.files[0], join(scope.monitorStateRoot, 'unexpected'))
    expect(pin).toThrow('nonsymlink')
  })

  it('rechecks files already read before returning the complete observation', () => {
    const read = fs.readSync
    vi.spyOn(fs, 'readSync')
      .mockImplementationOnce(read)
      .mockImplementationOnce((...args) => {
        const count = read(...args)
        writeFileSync(join(scope.monitorStateRoot, 'monitor-stop.json'), 'late-change')
        return count
      })
    expect(pin).toThrow('changed during inventory')
  })
})
