import type Database from '../../sqlite/sync-database'

const active = new WeakMap<Database.Database, number>()

/** Process-local in-flight effects; this is not a daemon/remote writer fence. */
export function trackStrictContinuityEffect<T>(
  db: Database.Database | undefined,
  invoke: () => T
): T {
  if (!db) {
    return invoke()
  }
  active.set(db, (active.get(db) ?? 0) + 1)
  const release = () => active.set(db, (active.get(db) ?? 1) - 1)
  let pending = false
  try {
    const result = invoke()
    if (result instanceof Promise) {
      pending = true
      void result.then(release, release)
    }
    return result
  } finally {
    if (!pending) {
      release()
    }
  }
}

export function assertStrictContinuityEffectsIdle(db: Database.Database): void {
  if (active.get(db)) {
    throw new Error('strict_continuity_required: PTY effects still in flight; cannot seal')
  }
}
