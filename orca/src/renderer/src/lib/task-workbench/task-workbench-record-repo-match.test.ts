import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { matchTaskRecordRepo } from './task-workbench-record-repo-match'

function repo(
  id: string,
  path: string,
  remote?: { canonicalKey?: string; remoteUrl: string }
): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'gray',
    addedAt: 1,
    ...(remote
      ? {
          gitRemoteIdentity: {
            canonicalKey: remote.canonicalKey ?? '',
            remoteName: 'origin',
            remoteUrl: remote.remoteUrl
          }
        }
      : {})
  }
}

describe('matchTaskRecordRepo', () => {
  it('returns the one registration with the same canonical remote identity', () => {
    const page = repo('local-id', '/local/repo', {
      canonicalKey: 'github.com/acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git'
    })
    expect(
      matchTaskRecordRepo(page, [
        repo('remote-other', '/remote/other', {
          canonicalKey: 'github.com/acme/other',
          remoteUrl: 'https://github.com/acme/other'
        }),
        repo('remote-id', '/remote/repo', {
          canonicalKey: 'github.com/acme/repo',
          remoteUrl: 'https://github.com/acme/repo.git'
        })
      ])
    ).toEqual({ kind: 'unique', repoId: 'remote-id' })
  })

  it('derives missing canonical keys with the existing remote URL normalizer', () => {
    const page = repo('local-id', '/repo', {
      remoteUrl: 'ssh://git@GitHub.COM/acme/repo.git/'
    })
    const runtime = repo('remote-id', '/repo', {
      remoteUrl: 'https://github.com/acme/repo'
    })
    expect(matchTaskRecordRepo(page, [runtime])).toEqual({ kind: 'unique', repoId: 'remote-id' })
  })

  it('reports zero and multiple identity matches without choosing store order', () => {
    const page = repo('local-id', '/page/repo', {
      canonicalKey: 'github.com/acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git'
    })
    expect(matchTaskRecordRepo(page, [])).toEqual({ kind: 'none' })
    expect(
      matchTaskRecordRepo(page, [
        repo('remote-a', '/a', {
          canonicalKey: 'github.com/acme/repo',
          remoteUrl: 'git@github.com:acme/repo.git'
        }),
        repo('remote-b', '/b', {
          canonicalKey: 'github.com/acme/repo',
          remoteUrl: 'git@github.com:acme/repo.git'
        })
      ])
    ).toEqual({ kind: 'ambiguous' })
  })

  it('uses path only to break a tie between registrations already matching by remote', () => {
    const page = repo('local-id', 'C:\\src\\repo', {
      canonicalKey: 'github.com/acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git'
    })
    expect(
      matchTaskRecordRepo(page, [
        repo('remote-a', 'c:/src/other', {
          canonicalKey: 'github.com/acme/repo',
          remoteUrl: 'git@github.com:acme/repo.git'
        }),
        repo('remote-b', 'c:/src/repo/', {
          canonicalKey: 'github.com/acme/repo',
          remoteUrl: 'git@github.com:acme/repo.git'
        })
      ])
    ).toEqual({ kind: 'unique', repoId: 'remote-b' })
  })

  it('refuses the same path on another host when no remote identity exists', () => {
    const page = repo('local-id', '/srv/repo')
    expect(matchTaskRecordRepo(page, [repo('remote-id', '/srv/repo')])).toEqual({
      kind: 'unidentifiable'
    })
  })
})
