import type Database from '../../sqlite/sync-database'

const connections = new WeakMap<
  Database.Database,
  { assertCurrent: () => void; active: boolean; seal: unknown }
>()

function latestSeal(db: Database.Database) {
  return db
    .prepare('SELECT seal FROM strict_continuity_seals ORDER BY recovery_epoch DESC LIMIT 1')
    .get()?.seal
}

/** An explicit successor owns this connection only while its native instance lock is held. */
export function bindStrictContinuityResume(
  db: Database.Database,
  assertCurrent: () => void,
  active = true
): void {
  assertCurrent()
  if (connections.has(db)) {
    throw new Error('strict_continuity_resume_already_bound')
  }
  connections.set(db, { assertCurrent, active, seal: latestSeal(db) })
}

export function hasStrictContinuityResume(db: Database.Database, allowStarting = false): boolean {
  const connection = connections.get(db)
  if (!connection) {
    return false
  }
  connection.assertCurrent()
  return (connection.active || allowStarting) && connection.seal === latestSeal(db)
}

export function activateStrictContinuityResume(db: Database.Database): void {
  const connection = connections.get(db)
  if (!connection) {
    throw new Error('strict_continuity_resume_required')
  }
  connection.assertCurrent()
  connection.active = true
}
