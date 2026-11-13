// Wait declarations (issue-sedimentation.md v2.4 §7.2, M3-1).
//
// A declaration says "this pane is expected to be quiet until X". It is the only thing that makes a
// long training run or a long build not look stuck, and it is the one piece of state M3 had to
// invent — §4 records that neither a `waitReason` field nor an `expected_wait` existed anywhere.
//
// Rules, all enforced here rather than at the call sites:
//   * keyed by `(pane_key, epoch)`. The epoch is the `stateStartedAt` the declaration was made
//     against, so a pane that is torn down and respawned cannot inherit the old promise;
//   * `expires_at` is a deadline, not a hint: an expired declaration is ignored on read and deleted
//     on the next sweep, so nobody has to remember to clear it;
//   * the actor is self-reported (§19.1): recorded for the audit trail, never verified.

import type Database from '../sqlite/sync-database'
import { readMeta } from './incident-store-meta'
import { writeMeta } from './incident-store-meta'

/** Active declarations seen by the last sample, so coverage can say "N panes declared quiet". */
export const PANE_CLOCK_DECLARED_WAITS_META = 'pane_clock_declared_waits'

export type WaitDeclaration = {
  paneKey: string
  /** `stateStartedAt` the declaration was made against, as a string for comparison. */
  epoch: string
  reason: string
  actor: string
  createdAt: number
  expiresAt: number | null
}

export type DeclareWaitInput = {
  paneKey: string
  epoch: string
  reason: string
  actor: string
  expiresAt: number | null
  now?: number
}

export type ClearWaitInput = {
  paneKey: string
  /** When omitted, every declaration for the pane is cleared (the operator's "I'm back" is unambiguous). */
  epoch?: string
  now?: number
}

export class WaitDeclarationError extends Error {
  constructor(
    readonly reason: 'missing_reason' | 'missing_actor' | 'missing_epoch' | 'expired_deadline'
  ) {
    super(reason)
  }
}

function rowToDeclaration(row: Record<string, unknown>): WaitDeclaration {
  return {
    paneKey: String(row.pane_key),
    epoch: String(row.epoch),
    reason: String(row.reason),
    actor: String(row.actor),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at)
  }
}

/**
 * Insert or replace one declaration. Re-declaring the same `(pane, epoch)` updates it in place: the
 * operator extending a wait should not produce two rows that disagree.
 */
export function declareWait(db: Database.Database, input: DeclareWaitInput): WaitDeclaration {
  const reason = input.reason.trim()
  const actor = input.actor.trim()
  const epoch = input.epoch.trim()
  if (reason.length === 0) {
    throw new WaitDeclarationError('missing_reason')
  }
  if (actor.length === 0) {
    throw new WaitDeclarationError('missing_actor')
  }
  if (epoch.length === 0) {
    throw new WaitDeclarationError('missing_epoch')
  }
  const now = input.now ?? Date.now()
  if (input.expiresAt !== null && input.expiresAt <= now) {
    // A deadline in the past would create a declaration that is dead on arrival; refusing is kinder
    // than storing a promise nobody can keep.
    throw new WaitDeclarationError('expired_deadline')
  }
  db.prepare(
    `INSERT INTO incident_wait_declarations (pane_key, epoch, reason, actor, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pane_key, epoch) DO UPDATE SET
       reason = excluded.reason,
       actor = excluded.actor,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`
  ).run(
    input.paneKey,
    epoch,
    reason.slice(0, 500),
    actor.slice(0, 200),
    now,
    input.expiresAt
  )
  return {
    paneKey: input.paneKey,
    epoch,
    reason: reason.slice(0, 500),
    actor: actor.slice(0, 200),
    createdAt: now,
    expiresAt: input.expiresAt
  }
}

/** Remove one epoch's declaration (or all of a pane's). Returns the number removed. */
export function clearWait(db: Database.Database, input: ClearWaitInput): number {
  const result =
    input.epoch === undefined
      ? db.prepare('DELETE FROM incident_wait_declarations WHERE pane_key = ?').run(input.paneKey)
      : db
          .prepare('DELETE FROM incident_wait_declarations WHERE pane_key = ? AND epoch = ?')
          .run(input.paneKey, input.epoch)
  return Number(result.changes)
}

/** Delete expired declarations. Called by the sampler so the table cannot grow without bound. */
export function pruneExpiredWaits(db: Database.Database, now: number): number {
  const result = db
    .prepare(
      'DELETE FROM incident_wait_declarations WHERE expires_at IS NOT NULL AND expires_at <= ?'
    )
    .run(now)
  return Number(result.changes)
}

/** Active declarations (one per pane+epoch), optionally restricted to one pane. */
export function listActiveWaits(
  db: Database.Database,
  options: { now: number; paneKey?: string }
): WaitDeclaration[] {
  const rows =
    options.paneKey === undefined
      ? db
          .prepare(
            `SELECT pane_key, epoch, reason, actor, created_at, expires_at
             FROM incident_wait_declarations
             WHERE expires_at IS NULL OR expires_at > ?
             ORDER BY pane_key ASC`
          )
          .all(options.now)
      : db
          .prepare(
            `SELECT pane_key, epoch, reason, actor, created_at, expires_at
             FROM incident_wait_declarations
             WHERE pane_key = ? AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY epoch ASC`
          )
          .all(options.paneKey, options.now)
  return rows.map(rowToDeclaration)
}

/** Publish the active-declaration count for coverage (§12's "注记"). */
export function publishDeclaredWaitCount(db: Database.Database, count: number): void {
  writeMeta(db, PANE_CLOCK_DECLARED_WAITS_META, String(count))
}

export function readDeclaredWaitCount(db: Database.Database): number {
  const value = Number(readMeta(db, PANE_CLOCK_DECLARED_WAITS_META) ?? 0)
  return Number.isFinite(value) && value >= 0 ? value : 0
}
