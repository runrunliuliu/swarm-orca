import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import { strictCoordinatorPolicy } from './strict-coordinator-policy'
import { readGrantForRun, readStartGrantRevocation, type StartGrant } from './start-grant-policy'

/**
 * Every decision the spawn path makes under a grant, in one function per insert site.
 *
 * Kept apart from the record/store module on purpose: this is the part that has to be true inside
 * another module's transaction, and it reads like the rules it enforces.
 */
/**
 * Whether a strict Run with no grant binding is refused at spawn.
 *
 * `false` for now: strict Runs created before grants existed would stop dead the moment this landed,
 * and closing that migration window is a deployment decision, not this commit's. Flipping it to `true`
 * is the whole switch — the refusal path below is already tested with it on.
 */
export const START_GRANT_REQUIRED = false

type GrantDb = Pick<OrchestrationDb, 'db'>

export type SpawnScope = {
  runId: string
  /** The repo the dispatch would run in; null when the caller could not resolve one. */
  repoId: string | null
  /** The worktree it would run in; null when this spawn would create a new one. */
  worktreeId: string | null
  federated?: boolean
  /** Defaults to `START_GRANT_REQUIRED`; tests exercise both states explicitly. */
  startGrantRequired?: boolean
}

/**
 * The one decision the spawn path makes, called inside the transaction that will write the dispatch.
 *
 * `undefined` means "this Run is not governed by a grant" — a non-strict Run, or a strict Run created
 * before grants existed. A strict Run with no grant is refused instead: otherwise the old create verb
 * keeps a complete bypass, and the cap would only apply to whoever chose to use it.
 *
 * Every refusal here happens before the caller's first write, which is what makes "no dispatch row,
 * no receipt, no Task, no terminal" true rather than merely intended.
 */
export function assertSpawnAdmissible(db: GrantDb, scope: SpawnScope): StartGrant | undefined {
  // One reader for "which grant covers this Run": it returns undefined only when nothing is bound,
  // and refuses a binding whose grant is missing. Re-reading the binding here would be a second
  // implementation of that rule, and the two would eventually disagree.
  const grant = readGrantForRun(db, scope.runId)
  if (!grant) {
    const required = scope.startGrantRequired ?? START_GRANT_REQUIRED
    if (required && strictCoordinatorPolicy(db, scope.runId)) {
      throw new OrchestrationError(
        'start_grant_required',
        `Run ${scope.runId} is strict but has no start grant; create it again under a grant before dispatching Workers.`,
        { runId: scope.runId }
      )
    }
    return undefined
  }
  const revocation = readStartGrantRevocation(db, grant.grantId)
  if (revocation) {
    throw new OrchestrationError(
      'start_grant_revoked',
      `Start grant ${grant.grantId} was revoked at ${revocation.revokedAt}: ${revocation.reason}`,
      { grantId: grant.grantId, revokedAt: revocation.revokedAt }
    )
  }
  if (Date.now() > Date.parse(grant.deadline)) {
    throw new OrchestrationError(
      'start_grant_expired',
      `Start grant ${grant.grantId} expired at ${grant.deadline}; no new Worker starts under it.`,
      { grantId: grant.grantId, deadline: grant.deadline }
    )
  }
  // Before the scope check: "a remote Worker cannot be counted" does not depend on a repo id, and a
  // federation call carries none. Ordering it after the scope would report the wrong reason.
  if (scope.federated) {
    throw new OrchestrationError(
      'start_grant_remote_unsupported',
      `Start grant ${grant.grantId} covers local Workers only; the worker count cannot see a remote host.`,
      { grantId: grant.grantId }
    )
  }
  assertScopeAdmits(db, grant, scope)
  const active = activeDispatches(db, grant.grantId)
  if (active.length >= grant.maxWorkers) {
    throw new OrchestrationError(
      'start_grant_worker_limit',
      `Start grant ${grant.grantId} allows ${grant.maxWorkers} concurrent Workers and ${active.length} are active.`,
      {
        grantId: grant.grantId,
        maxWorkers: grant.maxWorkers,
        active: active.map((row) => row)
      }
    )
  }
  return grant
}

/**
 * The repo/worktree scope, with the creation case spelled out: while a worktree is being created it
 * has no id yet, so only a repo-wide scope (`worktreeIds: null`) can authorise it. Allowing creation
 * under an enumerated worktree list would be a whitelist that also grants everything it omits.
 */
function assertScopeAdmits(db: GrantDb, grant: StartGrant, scope: SpawnScope): void {
  const refuse = (reason: string): never => {
    throw new OrchestrationError(
      'start_grant_repo_not_granted',
      `Start grant ${grant.grantId} does not cover ${scope.repoId ?? 'this repo'}${
        scope.worktreeId ? `/${scope.worktreeId}` : ' (new worktree)'
      }: ${reason}`,
      { grantId: grant.grantId, repoId: scope.repoId, worktreeId: scope.worktreeId }
    )
  }
  if (!scope.repoId) {
    // Unresolvable is not "allowed": the scope is the only thing standing between an approval and an
    // arbitrary checkout, and a guess here would be the fail-open case.
    refuse('the repository could not be resolved')
  }
  const candidates = grant.repos.filter((entry) => entry.repoId === scope.repoId)
  if (candidates.length === 0) {
    refuse('the repository is not in the grant')
  }
  if (scope.worktreeId === null) {
    if (!candidates.some((entry) => entry.worktreeIds === null)) {
      refuse('the grant enumerates worktrees, so it cannot authorise creating a new one')
    }
    return
  }
  if (candidates.some((entry) => entry.worktreeIds === null || entry.worktreeIds.includes(scope.worktreeId!))) {
    return
  }
  if (claimedByRun(db, scope.runId, scope.worktreeId)) {
    // A worktree this Run already created under the grant stays in scope for its own Workers.
    return
  }
  refuse('the worktree is not in the grant')
}

function claimedByRun(db: GrantDb, runId: string, worktreeId: string): boolean {
  const row = db.db
    .prepare(
      `SELECT 1 AS claimed FROM worker_dispatches w
       JOIN dispatch_contexts d ON d.id = w.dispatch_id
       WHERE d.run_id = ? AND w.worktree_id = ? LIMIT 1`
    )
    .get(runId, worktreeId)
  return row !== undefined
}

type ActiveDispatch = { dispatchId: string; status: string; updatedAt: string | null }

/**
 * The repo a new Worker worktree would actually be created in, resolved the same way the creation
 * itself resolves it (`params.repo ?? coordinatorWorktree.repoId`).
 *
 * The creation happens after the Dispatch row is written, so the grant scope has to be checked
 * against a repo id that is known *before* it: taking the coordinator's repo and ignoring an
 * explicit `--repo` would let a caller create a worktree in a repo the grant never covered.
 * `null` means "could not be resolved", and the scope check refuses that rather than assuming.
 */
export async function resolveCreationRepoId(
  runtime: { listManagedWorktrees: (selector: string, limit?: number) => Promise<{ worktrees: { repoId: string }[] }> },
  selector: string | null
): Promise<string | null> {
  if (!selector) {
    return null
  }
  try {
    const listed = await runtime.listManagedWorktrees(selector, 1)
    return listed.worktrees[0]?.repoId ?? null
  } catch {
    return null
  }
}

/** How many Workers the grant currently counts, for the read-only projection. */
export function grantActiveWorkers(db: GrantDb, grantId: string): number {
  return activeDispatches(db, grantId).length
}

/** Active means "may still own a live Worker": settled rows are done, everything else is not. */
function activeDispatches(db: GrantDb, grantId: string): ActiveDispatch[] {
  const rows = z
    .array(
      z.object({
        dispatch_id: z.string(),
        status: z.string(),
        observed_at: z.string().nullable()
      })
    )
    .parse(
      db.db
        .prepare(
          `SELECT d.id AS dispatch_id, d.status AS status,
                  COALESCE(w.updated_at, d.dispatched_at, d.created_at) AS observed_at
           FROM dispatch_contexts d
           JOIN start_grant_runs g ON g.run_id = d.run_id
           LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
           WHERE g.grant_id = ? AND d.status IN ('pending', 'dispatched')
           ORDER BY observed_at`
        )
        .all(grantId)
    )
  return rows.map((row) => ({
    dispatchId: row.dispatch_id,
    status: row.status,
    // Named after the column the contract promises; a context-only Dispatch has no worker row and
    // falls back to its own timestamps in the query above.
    updatedAt: row.observed_at
  }))
}

