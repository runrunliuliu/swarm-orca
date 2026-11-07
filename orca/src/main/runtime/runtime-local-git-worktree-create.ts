import type { LocalGitExecOptions } from '../git/repo-default-base-ref'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { SparseTaskWorkspaceReceipt } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { resolveCreatedWorktree } from '../ipc/created-worktree-reconciliation'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import {
  assertSparseTaskWorkspaceCreatePath,
  assertSparseTaskWorkspaceNewBranch,
  createSparseTaskWorkspace,
  resolveSparseTaskWorkspaceRequest,
  type SparseTaskWorkspaceCreateOutcome
} from '../ipc/sparse-task-workspace-create'
import { configureCreatedWorktreePushTarget } from '../ipc/worktree-remote'
import {
  addSparseWorktree,
  addWorktree,
  type AddWorktreeOptions,
  type AddWorktreeResult
} from '../git/worktree'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { isGeneratedWorktreeCreateName } from '../worktree-create-candidates'
import {
  consumePreparedWorktreeCreate,
  type PreparationRearmHolder
} from '../worktree-create-preparation'
import {
  failedWorktreeCreationNeedsRetirement,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'

export async function createRuntimeLocalGitWorktree(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: RuntimeStore
  settings: {
    workspaceDir: string
    nestWorkspaces: boolean
    refreshLocalBaseRefOnWorktreeCreate: boolean
    localBaseRefSuggestionDismissed?: boolean
  }
  baseBranch: string
  workspaceRoot: string
  branchName: string
  worktreePath: string
  effectiveSanitizedName?: string
  checkoutExistingBranch: boolean
  localWorktreeGitOptions: LocalGitExecOptions
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options?: LocalGitExecOptions
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<boolean>
  refreshRemoteTrackingBase: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
  fetchRemote: (repoPath: string, remote: string, options?: LocalGitExecOptions) => Promise<void>
  rearm: PreparationRearmHolder
}): Promise<{
  remoteTrackingBase: RemoteTrackingBase | null
  sparseDirectories: string[]
  configuredPushTarget?: GitPushTarget
  created: GitWorktreeInfo
  addResult: AddWorktreeResult
  sparseCheckoutReceipt?: SparseTaskWorkspaceReceipt
}> {
  // Why: the task sparse contract refuses what this path cannot honour before any Git work, so a
  // legacy sparse result can never stand in for a pinned one. Strict parsing lives in this call.
  const sparseTaskRequest = resolveSparseTaskWorkspaceRequest(args.request.sparseCheckout)
  assertSparseTaskWorkspaceCreatePath(sparseTaskRequest, 'local')
  assertSparseTaskWorkspaceNewBranch(sparseTaskRequest, args.checkoutExistingBranch)
  let remoteTrackingBase = await args.resolveRemoteTrackingBase(
    args.repo.path,
    args.baseBranch,
    args.localWorktreeGitOptions
  )
  if (remoteTrackingBase) {
    const [hadRemoteRef, hasNamedLocalBaseRef] = await Promise.all([
      args.hasRemoteTrackingRef(args.repo.path, remoteTrackingBase, args.localWorktreeGitOptions),
      hasLocalWorktreeBaseRef(args.repo.path, args.baseBranch, args.localWorktreeGitOptions)
    ])
    const hasLocalBase = hadRemoteRef || hasNamedLocalBaseRef
    if (!hadRemoteRef && hasLocalBase) {
      remoteTrackingBase = null
    } else {
      const refresh = await args.refreshRemoteTrackingBase(
        args.repo.path,
        remoteTrackingBase,
        args.localWorktreeGitOptions
      )
      if (!refresh.ok && !hadRemoteRef) {
        throw new Error(
          `Could not refresh base ref "${args.baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
        )
      }
      if (
        !hadRemoteRef &&
        !(await args.hasRemoteTrackingRef(
          args.repo.path,
          remoteTrackingBase,
          args.localWorktreeGitOptions
        ))
      ) {
        throw new Error(`Base ref "${args.baseBranch}" was not found after fetching.`)
      }
    }
  } else if (
    !(await hasLocalWorktreeBaseRef(args.repo.path, args.baseBranch, args.localWorktreeGitOptions))
  ) {
    try {
      await args.fetchRemote(args.repo.path, 'origin', args.localWorktreeGitOptions)
    } catch {}
  }
  // Why the strict cone for a task request, legacy normalization for everything else: the two
  // rules must never be mixed, and a legacy payload keeps its historical trim/dedupe behavior.
  const sparseDirectories = sparseTaskRequest
    ? sparseTaskRequest.directories
    : args.request.sparseCheckout
      ? normalizeSparseDirectories(args.request.sparseCheckout.directories)
      : []
  if (args.request.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  // Why: defer the remote add + fetch (fork case) or the redundant re-fetch
  // (same-repo case, already fetched while resolving the PR start point) to
  // first use -- push/pull/fetch/fast-forward materialize it on demand
  // (#17828). Metadata is persisted untouched; only the git mutation defers.
  const preparedPushTarget = args.request.pushTarget
  const suggestLocalBaseRefUpdate =
    !args.settings.refreshLocalBaseRefOnWorktreeCreate &&
    !args.settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const preparedWorktreeOptions: AddWorktreeOptions = {
    ...remoteOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {}),
    ...args.localWorktreeGitOptions
  }
  const addOptions: AddWorktreeOptions = {
    ...preparedWorktreeOptions,
    ...(args.checkoutExistingBranch ? { checkoutExistingBranch: true } : {})
  }
  const shouldRetireGeneratedName =
    args.request.nameWasGenerated === true &&
    Boolean(args.effectiveSanitizedName) &&
    isGeneratedWorktreeCreateName(args.effectiveSanitizedName!)
  let addResult: AddWorktreeResult
  let sparseTaskOutcome: SparseTaskWorkspaceCreateOutcome | undefined
  // Why `--set-upstream-to` needs the remote to already exist: safe for a same-repo target (its
  // remote, e.g. `origin`, always exists) but not for a deferred fork remote, which is materialized
  // lazily at first push/pull/fetch.
  const configureDeferredPushTarget = async (): Promise<GitPushTarget | undefined> =>
    preparedPushTarget && !preparedPushTarget.remoteUrl
      ? await configureCreatedWorktreePushTarget(
          args.worktreePath,
          args.branchName,
          preparedPushTarget,
          args.localWorktreeGitOptions
        )
      : preparedPushTarget
  let configuredPushTarget: GitPushTarget | undefined
  try {
    if (sparseTaskRequest) {
      sparseTaskOutcome = await createSparseTaskWorkspace({
        repoPath: args.repo.path,
        worktreePath: args.worktreePath,
        branch: args.branchName,
        baseBranch: args.baseBranch,
        baseSource: args.request.baseBranch ? 'request' : 'default',
        request: sparseTaskRequest,
        options: args.localWorktreeGitOptions,
        addWorktreeAtPin: (pin) =>
          addSparseWorktree(
            args.repo.path,
            args.worktreePath,
            args.branchName,
            sparseDirectories,
            args.baseBranch,
            args.settings.refreshLocalBaseRefOnWorktreeCreate,
            {
              ...addOptions,
              pinnedBaseOid: pin.pinnedSha,
              retainPartialWorktreeOnFailure: true
            }
          ),
        worktreeCreated: async () => {
          runWorktreeChangeInvalidators(args.repo.id)
          if (shouldRetireGeneratedName) {
            await retireGeneratedWorktreeName(
              args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
              args.repo,
              args.settings,
              args.effectiveSanitizedName!
            )
          }
          configuredPushTarget = await configureDeferredPushTarget()
        }
      })
      addResult = sparseTaskOutcome.addResult
    } else {
      const preparedAttempt =
        sparseDirectories.length === 0 && !args.checkoutExistingBranch
          ? await consumePreparedWorktreeCreate({
              repoPath: args.repo.path,
              workspaceRoot: args.workspaceRoot,
              worktreePath: args.worktreePath,
              branch: args.branchName,
              baseBranch: args.baseBranch,
              refreshLocalBaseRef: args.settings.refreshLocalBaseRefOnWorktreeCreate,
              options: preparedWorktreeOptions
            })
          : null
      // This path has no create-span recorder, so the miss reason is only observable on the IPC path.
      if (preparedAttempt?.status === 'miss' && preparedAttempt.rearm) {
        args.rearm.fire = preparedAttempt.rearm
      }
      if (preparedAttempt?.status === 'hit') {
        addResult = preparedAttempt.result
        // Deferred, not fired: re-arming is a full `reset --hard`, and the caller still has
        // materialization probes and terminals ahead of it.
        args.rearm.fire = preparedAttempt.rearm
      } else if (sparseDirectories.length > 0) {
        addResult =
          (await addSparseWorktree(
            args.repo.path,
            args.worktreePath,
            args.branchName,
            sparseDirectories,
            args.baseBranch,
            args.settings.refreshLocalBaseRefOnWorktreeCreate,
            addOptions
          )) ?? {}
      } else {
        addResult =
          (await addWorktree(
            args.repo.path,
            args.worktreePath,
            args.branchName,
            args.baseBranch,
            args.settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            addOptions
          )) ?? {}
      }
    }
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(
        args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
        args.repo,
        args.settings,
        args.effectiveSanitizedName!
      )
    }
    throw error
  }
  let created: GitWorktreeInfo
  if (sparseTaskOutcome) {
    // The orchestrated path already invalidated caches, retired the name, configured the push
    // target and read the worktree back.
    created = sparseTaskOutcome.resolution.created
  } else {
    // Why: the worktree is listable from here on; scans that began before it appeared are stale.
    runWorktreeChangeInvalidators(args.repo.id)
    if (shouldRetireGeneratedName) {
      await retireGeneratedWorktreeName(
        args.store as Parameters<typeof retireGeneratedWorktreeName>[0],
        args.repo,
        args.settings,
        args.effectiveSanitizedName!
      )
    }
    configuredPushTarget = await configureDeferredPushTarget()
    created = (
      await resolveCreatedWorktree(
        args.repo.path,
        args.worktreePath,
        args.branchName,
        args.localWorktreeGitOptions
      )
    ).created
  }
  const sparseCheckoutReceipt = sparseTaskOutcome?.receipt
  return {
    remoteTrackingBase,
    sparseDirectories,
    ...(configuredPushTarget ? { configuredPushTarget } : {}),
    created,
    addResult,
    ...(sparseCheckoutReceipt ? { sparseCheckoutReceipt } : {})
  }
}
