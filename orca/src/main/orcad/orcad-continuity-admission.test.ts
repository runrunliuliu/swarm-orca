import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { assertStrictContinuityStartup } from '../runtime/orchestration/strict-continuity-admission'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'
import { startOrcadWithHost } from './orcad-lifecycle'
import * as hostIdentity from '../persistence/profile-state/profile-state-access-identity'

vi.mock('./orcad-browser-provider', () => ({
  resolveOrcadBrowserProvider: vi.fn(async () => null)
}))

describe('sealed database startup admission', () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-continuity-admission-'))
    file = join(root, 'orchestration.db')
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function raw(sql: string) {
    const db = new Database(file)
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
  }

  it('does not create a missing database, and accepts an ordinary pre-feature database', () => {
    assertStrictContinuityStartup(file)
    expect(existsSync(file)).toBe(false)
    raw('CREATE TABLE legacy_state (id INTEGER)')
    const before = readFileSync(file)
    assertStrictContinuityStartup(file)
    expect(readFileSync(file)).toEqual(before)
  })

  it('accepts empty continuity metadata on ordinary startup', () => {
    new OrchestrationDb(file).close()
    assertStrictContinuityStartup(file)
    new OrchestrationDb(file).close()
  })

  it.each([
    'CREATE TABLE strict_continuity_seals (unexpected TEXT)',
    'CREATE TABLE strict_continuity_seals (expires_at_ms); INSERT INTO strict_continuity_seals VALUES (1)',
    "CREATE TABLE strict_continuity_database (database_id); INSERT INTO strict_continuity_database VALUES ('orphaned')",
    'CREATE VIEW strict_continuity_seals AS SELECT 1 WHERE 0'
  ])('refuses sealed, partial or malformed metadata before any migrations: %s', (sql) => {
    raw(sql)
    const before = readFileSync(file)
    expect(() => assertStrictContinuityStartup(file)).toThrow('strict_continuity_required')
    expect(() => new OrchestrationDb(file)).toThrow('strict_continuity_required')
    expect(readFileSync(file)).toEqual(before)
  })

  it.each([
    'DROP TRIGGER trg_continuity_seal_update',
    `DROP TRIGGER trg_continuity_seal_update;
      CREATE TRIGGER trg_continuity_seal_update BEFORE UPDATE ON strict_continuity_seals
      BEGIN SELECT 1; END`
  ])('refuses missing or ineffective immutable triggers without repairing them: %s', (sql) => {
    new OrchestrationDb(file).close()
    raw(sql)
    const before = readFileSync(file)
    expect(() => assertStrictContinuityStartup(file)).toThrow('strict_continuity_required')
    expect(() => new OrchestrationDb(file)).toThrow('strict_continuity_required')
    expect(readFileSync(file)).toEqual(before)
  })

  it('fails closed on unreadable database contents', () => {
    writeFileSync(file, 'not sqlite')
    expect(() => assertStrictContinuityStartup(file)).toThrow('strict_continuity_required')
    expect(readFileSync(file, 'utf8')).toBe('not sqlite')
  })

  it('refuses before browser/runtime writers and releases startup ownership on failure', async () => {
    raw(
      "CREATE TABLE strict_continuity_seals (seal); INSERT INTO strict_continuity_seals VALUES ('sealed')"
    )
    const start = vi.fn(async () => ({}))
    const quit = vi.fn()
    await expect(startOrcadWithHost(root, start, quit)).rejects.toThrow(
      'strict_continuity_required'
    )
    expect(start).not.toHaveBeenCalled()
    expect(resolveOrcadBrowserProvider).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
    const lock = acquireOrcadInstanceLock(root)
    lock.release()
    expect(existsSync(join(root, 'orcad.lock'))).toBe(false)
  })

  it.runIf(process.platform === 'linux')(
    'records actual runtime identity once per held Server lifecycle',
    async () => {
      const readBoots = () => {
        const db = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
        try {
          return db.prepare('SELECT runtime_id FROM boots ORDER BY epoch').all()
        } finally {
          db.close()
        }
      }
      const start = async (id: string) =>
        startOrcadWithHost(
          root,
          async (_, recordRuntime) => {
            recordRuntime({ getRuntimeId: () => id })
            expect(() => recordRuntime({ getRuntimeId: () => 'duplicate' })).toThrow(
              'registration failed'
            )
            return {}
          },
          () => {}
        )
      const first = await start('actual-first')
      try {
        expect(readBoots()).toEqual([{ runtime_id: 'actual-first' }])
      } finally {
        await first.stop()
      }
      const second = await start('actual-second')
      try {
        expect(readBoots()).toEqual([
          { runtime_id: 'actual-first' },
          { runtime_id: 'actual-second' }
        ])
      } finally {
        await second.stop()
      }
    }
  )

  it.runIf(process.platform === 'linux')(
    'keeps unenrolled Linux hosts usable without inventing missing identity, but refuses an existing chain',
    async () => {
      vi.spyOn(hostIdentity, 'profileStateAccessMachineIdentity').mockReturnValue(null)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const start = () =>
        startOrcadWithHost(
          root,
          async (_, recordRuntime, successor, maintenance) => {
            recordRuntime({ getRuntimeId: () => 'actual-runtime' })
            expect(successor).toBeUndefined()
            expect(maintenance?.(async () => {})).toBeUndefined()
            return {}
          },
          () => {}
        )
      const ordinary = await start()
      await ordinary.stop()
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('continuity unavailable'))
      expect(existsSync(join(root, 'strict-runtime-lineage.db'))).toBe(false)
      writeFileSync(join(root, 'strict-runtime-lineage.db'), 'existing evidence', { mode: 0o600 })
      await expect(start()).rejects.toThrow('lineage admission failed')
      expect(readFileSync(join(root, 'strict-runtime-lineage.db'), 'utf8')).toBe(
        'existing evidence'
      )
    }
  )
})
