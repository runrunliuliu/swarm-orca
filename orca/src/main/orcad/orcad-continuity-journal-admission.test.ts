import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { strictCoordinatorHarness } from '../runtime/rpc/strict-coordinator-test-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { sealStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'
import { startOrcadWithHost } from './orcad-lifecycle'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'

vi.mock('./orcad-browser-provider', () => ({
  resolveOrcadBrowserProvider: vi.fn(async () => null)
}))

describe.runIf(process.platform === 'linux')('independent journal startup fence', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-journal-admission-'))
    vi.clearAllMocks()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it.each(['old-backup', 'missing-db', 'metadata-removed'])(
    'refuses before writers despite %s and an expired seal, preserving all evidence',
    async (mode) => {
      const h = strictCoordinatorHarness()
      const lock = acquireOrcadInstanceLock(root)
      const journal = openOrcadRuntimeLineage(root, lock)
      const path = join(root, 'orchestration.db')
      try {
        const runId = await h.create()
        await h.db.db.backup(path)
        await h.db.db.backup(join(root, 'old.db'))
        const db = new OrchestrationDb(path)
        try {
          const now = Date.now() - 120_000
          journal.recordBoot('source', now)
          journal.recordSourceInventory(continuityInventoryFixture(root), now)
          const proof = sealStrictContinuityDatabase(
            db,
            {
              runId,
              sourceRuntimeId: 'source',
              expiresAtMs: now + 60_000
            },
            now
          )
          journal.recordDatabaseSeal(
            db,
            {
              runId,
              databaseId: proof.seal.databaseId,
              sealCanonicalSha256: proof.sealCanonicalSha256
            },
            now + 1
          )
        } finally {
          db.close()
        }
      } finally {
        journal.close()
        lock.release()
        h.close()
      }
      if (mode === 'metadata-removed') {
        const raw = new Database(path)
        raw.exec('DROP TABLE strict_continuity_seals; DROP TABLE strict_continuity_database')
        raw.close()
      } else {
        renameSync(path, join(root, 'sealed.db'))
        if (mode === 'old-backup') {
          renameSync(join(root, 'old.db'), path)
        }
      }
      const journalPath = join(root, 'strict-runtime-lineage.db')
      const before = readFileSync(journalPath)
      const start = vi.fn(async () => ({}))
      await expect(startOrcadWithHost(root, start, () => {})).rejects.toThrow(
        'lineage admission failed'
      )
      expect(start).not.toHaveBeenCalled()
      expect(resolveOrcadBrowserProvider).not.toHaveBeenCalled()
      expect(readFileSync(journalPath)).toEqual(before)
      const released = acquireOrcadInstanceLock(root)
      released.release()
    }
  )
})
