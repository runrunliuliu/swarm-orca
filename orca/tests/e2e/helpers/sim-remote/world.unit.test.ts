import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskRecordsRemoteResult } from '../../../../src/shared/task-records-remote'
import { startSimulation } from './index'

function createGitRepo(root: string): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init'], { cwd: repo })
  return repo
}

async function bindReleasedPorts(ports: readonly number[]): Promise<Server[]> {
  const servers: Server[] = []
  try {
    for (const port of ports) {
      const server = createServer()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      servers.push(server)
    }
    return servers
  } catch (error) {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    throw error
  }
}

describe('simulation world', () => {
  it('composes named runtimes, a targeted proxy, record seeding, and idempotent teardown', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-sim-world-test-'))
    const repoPath = createGitRepo(scratch)
    let seededRepoId = ''
    const simulation = await startSimulation({
      runtimes: [{ name: 'alpha' }, { name: 'beta' }],
      network: { target: 'beta' },
      records: [
        {
          runtime: 'beta',
          args: async (runtime) => {
            const added = await runtime.client.call<{ repo: { id: string } }>('repo.add', {
              path: repoPath,
              kind: 'git'
            })
            seededRepoId = added.result.repo.id
            return {
              repoId: seededRepoId,
              itemType: 'issue',
              number: 67,
              bindings: [
                {
                  worktreeId: `${seededRepoId}::${repoPath}`,
                  hostId: 'local',
                  isArchived: false,
                  runs: 1,
                  usage: 'unknown'
                }
              ]
            }
          }
        }
      ]
    })
    const alpha = simulation.runtime('alpha')
    const beta = simulation.runtime('beta')
    const ports = [
      Number(new URL(alpha.baseUrl).port),
      simulation.proxy?.targetPort ?? 0,
      simulation.proxy?.listenPort ?? 0
    ]
    const profilePaths = simulation.runtimes.map((runtime) => runtime.userDataDir)
    let rebound: Server[] = []
    try {
      expect(alpha.name).toBe('alpha')
      expect(beta.name).toBe('beta')
      expect(() => simulation.runtime('missing')).toThrow('Unknown simulation runtime')
      expect(beta.client.isRemote).toBe(true)
      expect(Number(new URL(beta.baseUrl).port)).toBe(simulation.proxy?.listenPort)
      expect(simulation.proxy?.targetPort).not.toBe(Number(new URL(alpha.baseUrl).port))

      const result = await beta.client.call<TaskRecordsRemoteResult>('taskRecords.get', {
        repoId: seededRepoId,
        itemType: 'issue',
        number: 67,
        provider: 'github'
      })
      expect(result.result.repoKnown).toBe(true)
      expect(result.result.record?.bindings).toHaveLength(1)
      expect(result.result.record?.bindings[0]?.runs).toHaveLength(1)
      expect(result.result.record?.bindings[0]?.usageSettlement).toMatchObject({
        kind: 'unavailable'
      })

      await simulation.dispose()
      await expect(simulation.dispose()).resolves.toBeUndefined()
      expect(profilePaths.every((profilePath) => !existsSync(profilePath))).toBe(true)
      rebound = await bindReleasedPorts(ports)
      expect(
        rebound
          .map((server) => server.address())
          .map((address) => (address && typeof address !== 'string' ? address.port : -1))
          .sort()
      ).toEqual([...ports].sort())
    } finally {
      await Promise.all(
        rebound.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
      await simulation.dispose()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 90_000)
})
