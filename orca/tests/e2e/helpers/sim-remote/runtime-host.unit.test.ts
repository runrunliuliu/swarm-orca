import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import type { TaskRecordsRemoteResult } from '../../../../src/shared/task-records-remote'
import { seedTaskRecord } from './record-seeder'
import { startSimRuntimes, type SimRuntime } from './runtime-host'

function createGitRepo(root: string): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init'], { cwd: repo })
  return repo
}

describe('simulation runtime hosts', () => {
  it('isolates, pairs, kills, restarts, and seeds each runtime through its own profile', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-sim-runtime-test-'))
    const clientAPath = path.join(scratch, 'client-a')
    const clientBPath = path.join(scratch, 'client-b')
    mkdirSync(clientAPath)
    mkdirSync(clientBPath)
    const repoPath = createGitRepo(scratch)
    let hosts: SimRuntime[] = []
    let testError: unknown
    try {
      hosts = await startSimRuntimes([{ name: 'alpha' }, { name: 'beta' }])
      const [alpha, beta] = hosts
      expect(alpha).toBeDefined()
      expect(beta).toBeDefined()
      expect(alpha.userDataDir).not.toBe(beta.userDataDir)
      expect(path.basename(alpha.userDataDir)).toBe('alpha')
      expect(path.basename(beta.userDataDir)).toBe('beta')
      expect(new URL(alpha.baseUrl).port).not.toBe(new URL(beta.baseUrl).port)

      const pairedAlpha = new RuntimeClient(clientAPath, 2_000, alpha.pairingCode, null)
      const pairedBeta = new RuntimeClient(clientBPath, 2_000, beta.pairingCode, null)
      await expect(pairedAlpha.call('status.get')).resolves.toMatchObject({ ok: true })
      await expect(pairedBeta.call('status.get')).resolves.toMatchObject({ ok: true })

      const alphaEndpoint = alpha.baseUrl
      const alphaProfile = alpha.userDataDir
      await alpha.kill()
      const failedAt = Date.now()
      await expect(pairedAlpha.call('status.get')).rejects.toBeDefined()
      expect(Date.now() - failedAt).toBeLessThan(4_000)
      await alpha.start()
      expect(alpha.baseUrl).toBe(alphaEndpoint)
      expect(alpha.userDataDir).toBe(alphaProfile)
      await expect(pairedAlpha.call('status.get')).resolves.toMatchObject({ ok: true })

      const added = await beta.client.call<{ repo: { id: string } }>('repo.add', {
        path: repoPath,
        kind: 'git'
      })
      const repoId = added.result.repo.id
      const binding = {
        worktreeId: `${repoId}::${repoPath}`,
        hostId: 'local',
        isArchived: true,
        runs: 2,
        usage: 'unknown' as const
      }
      await seedTaskRecord(beta, {
        repoId,
        itemType: 'issue',
        number: 67,
        bindings: [binding]
      })
      const query = { repoId, itemType: 'issue' as const, number: 67, provider: 'github' }
      const first = await beta.client.call<TaskRecordsRemoteResult>('taskRecords.get', query)
      expect(first.result.repoKnown).toBe(true)
      expect(first.result.record?.bindings).toHaveLength(1)
      expect(first.result.record?.bindings[0]?.runs).toHaveLength(2)
      expect(first.result.record?.bindings[0]?.usageSettlement).toMatchObject({
        kind: 'unavailable'
      })

      await seedTaskRecord(beta, {
        repoId,
        itemType: 'issue',
        number: 67,
        bindings: [binding]
      })
      const replayed = await beta.client.call<TaskRecordsRemoteResult>('taskRecords.get', query)
      expect(replayed.result.record?.bindings).toHaveLength(1)
      expect(replayed.result.record?.bindings[0]?.runs).toHaveLength(2)
    } catch (error) {
      testError = error
    }
    const cleanup = await Promise.allSettled(hosts.map((host) => host.dispose()))
    rmSync(scratch, { recursive: true, force: true })
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (testError !== undefined) {
      throw failures.length > 0
        ? new AggregateError([testError, ...failures], 'Test and cleanup failed')
        : testError
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Simulation runtime test cleanup failed')
    }
  }, 90_000)
})
