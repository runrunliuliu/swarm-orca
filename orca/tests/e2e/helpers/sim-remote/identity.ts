import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeGitRemoteUrl } from '../../../../src/shared/git-remote-identity'

export type SimIdentity = {
  owner: string
  repo: string
  originUrl: string
  canonicalKey: string
  bareRepoPath: string
  worktreePath: string
  tracker: {
    state: 'open' | 'closed'
    url: string
    number: number
    title: string
  }
}

type IdentityMetadata = SimIdentity['tracker']

const FIXTURE_DATE = '2000-01-01T00:00:00Z'
const IDENTITY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/

function requireIdentitySegment(value: string, field: 'owner' | 'repo'): void {
  if (!IDENTITY_SEGMENT.test(value)) {
    throw new Error(`Invalid simulation identity ${field}: ${JSON.stringify(value)}`)
  }
}

function requireMetadata(metadata: IdentityMetadata): void {
  if (
    (metadata.state !== 'open' && metadata.state !== 'closed') ||
    !Number.isInteger(metadata.number) ||
    metadata.number < 1 ||
    metadata.title.trim() === '' ||
    metadata.url.trim() === ''
  ) {
    throw new Error('Invalid simulation tracker metadata')
  }
}

export async function prepareSimIdentity(args: {
  owner: string
  repo: string
  metadata?: IdentityMetadata
  root?: string
}): Promise<SimIdentity> {
  requireIdentitySegment(args.owner, 'owner')
  requireIdentitySegment(args.repo, 'repo')
  const tracker =
    args.metadata ??
    ({
      state: 'open',
      url: `https://github.com/${args.owner}/${args.repo}/issues/1`,
      number: 1,
      title: `Simulation issue for ${args.owner}/${args.repo}`
    } satisfies IdentityMetadata)
  requireMetadata(tracker)

  const ownsRoot = args.root === undefined
  const root = args.root ?? mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-sim-identity-'))
  mkdirSync(root, { recursive: true })
  const sourcePath = path.join(root, 'seed-source')
  const bareRepoPath = path.join(root, 'remote.git')
  const worktreePath = path.join(root, 'worktree')
  const hooksPath = path.join(root, 'empty-hooks')
  const globalConfigPath = path.join(root, 'empty-gitconfig')
  mkdirSync(sourcePath)
  mkdirSync(hooksPath)
  writeFileSync(globalConfigPath, '')

  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  const git = (cwd: string, gitArgs: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.file.allow=always',
        '-c',
        `core.hooksPath=${hooksPath}`,
        ...gitArgs
      ],
      { cwd, encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()

  const originUrl = `git@github.com:${args.owner}/${args.repo}.git`
  const canonicalKey = normalizeGitRemoteUrl(originUrl)
  if (!canonicalKey) {
    throw new Error(`Product remote normalization refused ${originUrl}`)
  }

  try {
    git(sourcePath, ['init'])
    git(sourcePath, ['checkout', '-b', 'main'])
    writeFileSync(path.join(sourcePath, 'README.md'), `# ${args.owner}/${args.repo}\n`)
    git(sourcePath, ['add', 'README.md'])
    git(sourcePath, [
      '-c',
      'user.name=Orca E2E',
      '-c',
      'user.email=orca-e2e@example.com',
      'commit',
      '-m',
      'seed identity fixture'
    ])
    git(root, ['clone', '--bare', sourcePath, bareRepoPath])
    git(root, ['clone', bareRepoPath, worktreePath])
    git(worktreePath, ['remote', 'set-url', 'origin', originUrl])
    rmSync(sourcePath, { recursive: true, force: true })
    return {
      owner: args.owner,
      repo: args.repo,
      originUrl,
      canonicalKey,
      bareRepoPath,
      worktreePath,
      tracker
    }
  } catch (error) {
    rmSync(sourcePath, { recursive: true, force: true })
    rmSync(bareRepoPath, { recursive: true, force: true })
    rmSync(worktreePath, { recursive: true, force: true })
    if (ownsRoot) {
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}
