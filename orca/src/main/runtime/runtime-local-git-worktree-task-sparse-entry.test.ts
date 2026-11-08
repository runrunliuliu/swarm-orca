// Entry-level wiring for the task sparse contract: what the runtime create entry passes to Git, and
// what a legacy sparse create must still not do. Real Git; the runner is wrapped only to record argv.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { createRuntimeLocalGitWorktree } from './runtime-local-git-worktree-create'

const { runnerCalls } = vi.hoisted(() => ({ runnerCalls: [] as string[][] }))

vi.mock('../git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  const record =
    <Args extends unknown[], R>(run: (...args: Args) => Promise<R>) =>
    async (...args: Args): Promise<R> => {
      const [first] = args
      if (Array.isArray(first)) {
        runnerCalls.push(first.map(String))
      }
      return run(...args)
    }
  return {
    ...actual,
    gitExecFileAsync: record(actual.gitExecFileAsync),
    gitExecFileAsyncBuffer: record(actual.gitExecFileAsyncBuffer)
  }
})

const tempRoots: string[] = []

// Why: the create path journals its intent under userData; keep the suite off real state.
process.env.ORCA_SPARSE_TASK_JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'orca-task-entry-journal-'))
afterAll(() => rmSync(process.env.ORCA_SPARSE_TASK_JOURNAL_DIR!, { recursive: true, force: true }))

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-sparse-task-entry-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await mkdir(join(repoPath, 'swarm', 'skills'), { recursive: true })
  await mkdir(join(repoPath, 'orca'), { recursive: true })
  await writeFile(join(repoPath, 'AGENTS.md'), 'agents\n')
  await writeFile(join(repoPath, 'swarm', 'notes.md'), 'swarm\n')
  await writeFile(join(repoPath, 'swarm', 'skills', 'skill.md'), 'skill\n')
  await writeFile(join(repoPath, 'orca', 'main.ts'), 'orca\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return realpath(repoPath)
}

/** One entry call with only the repo/request varying; every other dependency is inert. */
function createArgs(
  repoPath: string,
  request: Pick<RuntimeManagedWorktreeCreateArgs, 'sparseCheckout'>
) {
  return {
    request: {
      ...request,
      repoSelector: repoPath,
      name: 'task',
      // Why skip: the task sparse contract only creates with setup skipped, and this entry now
      // enforces that. A create that wants setup is refused before any git work.
      setupDecision: 'skip'
    },
    repo: { id: 'repo-1', path: repoPath } as Repo,
    store: {} as Parameters<typeof createRuntimeLocalGitWorktree>[0]['store'],
    settings: {
      workspaceDir: dirname(repoPath),
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      localBaseRefSuggestionDismissed: true
    },
    baseBranch: 'main',
    workspaceRoot: dirname(repoPath),
    branchName: 'task-sparse',
    worktreePath: join(dirname(repoPath), 'wt-task'),
    checkoutExistingBranch: false,
    localWorktreeGitOptions: {},
    resolveRemoteTrackingBase: async () => null,
    hasRemoteTrackingRef: async () => false,
    refreshRemoteTrackingBase: async () => ({ ok: true }),
    fetchRemote: async () => {},
    rearm: { fire: () => {} }
  } as Parameters<typeof createRuntimeLocalGitWorktree>[0]
}

function ranAny(predicate: (argv: string) => boolean): boolean {
  return runnerCalls.some((call) => predicate(call.join(' ')))
}

beforeEach(() => {
  runnerCalls.length = 0
})

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime task sparse create entry', () => {
  it('creates at the pinned commit and returns a receipt with the verified fields', async () => {
    const repoPath = await createRepo()
    // The pin the entry resolves is the branch tip, and the argv/HEAD assertions below prove it is
    // what the add used (the helper's own test covers a ref that moves mid-create).
    const pinnedSha = git(repoPath, ['rev-parse', 'refs/heads/main'])

    const result = await createRuntimeLocalGitWorktree(
      createArgs(repoPath, {
        sparseCheckout: {
          mode: 'task-workspace-v1',
          directories: ['swarm'],
          requiredPaths: ['AGENTS.md']
        }
      })
    )

    expect(result.sparseCheckoutReceipt).toEqual({
      baseSource: 'default',
      resolvedRef: 'refs/heads/main',
      pinnedSha,
      actualHead: pinnedSha,
      requestedSparseCone: ['swarm'],
      effectiveSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md']
    })
    expect(result.created.head).toBe(pinnedSha)
    // The probe reads the repository at the pinned commit, before the worktree exists.
    expect(
      ranAny((argv) => argv.startsWith(`ls-tree -z --full-tree ${pinnedSha} -- :(literal)swarm`))
    ).toBe(true)
    // The add is pinned, not the (now moved) base branch.
    expect(ranAny((argv) => argv.includes('worktree add') && argv.endsWith(pinnedSha))).toBe(true)
  })

  it('refuses a setup decision before any git work', async () => {
    const repoPath = await createRepo()
    const args = createArgs(repoPath, {
      sparseCheckout: { mode: 'task-workspace-v1', directories: ['swarm'] }
    })

    await expect(
      createRuntimeLocalGitWorktree({ ...args, request: { ...args.request, setupDecision: 'run' } })
    ).rejects.toThrow(/sparse_task_capability_required/)
    // Why no runner call: the refusal has to precede the first side effect, not follow it.
    expect(runnerCalls).toEqual([])
  })

  it('leaves a legacy sparse create with no probe, no readback and no receipt', async () => {
    const repoPath = await createRepo()

    const result = await createRuntimeLocalGitWorktree(
      createArgs(repoPath, { sparseCheckout: { directories: ['swarm'] } })
    )

    expect(result.sparseCheckoutReceipt).toBeUndefined()
    expect(ranAny((argv) => argv.startsWith('ls-tree'))).toBe(false)
    expect(ranAny((argv) => argv.includes('sparse-checkout list'))).toBe(false)
    expect(ranAny((argv) => argv === 'rev-parse --verify HEAD')).toBe(false)
    // Legacy sparse creation is still a normal `worktree add` at the base ref, with no pin.
    expect(ranAny((argv) => /^(.* )?worktree add .*(^| )refs\/heads\/main$/.test(argv))).toBe(true)
    expect(result.sparseDirectories).toEqual(['swarm'])
  })
})
