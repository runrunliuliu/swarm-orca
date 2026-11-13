// "Something in the store changed" — one process-wide signal (§12, M7-A).
//
// The store emits here after a write that actually moved the read model: an insert that landed, a
// decision that was appended, a prune that deleted rows, a shadow replay that finished (it can clear
// `incomplete` without inserting anything). Consumers subscribe; today the only one is the
// activity-bar count push, which coalesces bursts before it sends anything to the renderer.
//
// Why the store emits instead of each writer: there are six insert call sites (PTY exit, tool error,
// stall write, acceptance gate, replay, self report) and every future one would have to remember to
// notify, with a stale badge as the silent failure mode. Emitting from the two store methods and the
// prune path makes "a write happened" and "a notification was scheduled" the same event.
//
// Two rules:
//   * a listener that throws must not fail the write — the writer's contract is that nothing here can
//     reach a PTY teardown, so listener errors are swallowed;
//   * duplicates do NOT emit. A refused-in-place insert changed nothing, and notifying would make the
//     "3 changes → 1 push" guarantee untestable.

export type IncidentStoreChangeKind = 'insert' | 'decision' | 'prune' | 'replay'

export type IncidentStoreChange = {
  kind: IncidentStoreChangeKind
  /** Rows this change added, removed or re-projected; 0 when the change is a coverage update. */
  rows: number
}

export type IncidentStoreChangeListener = (change: IncidentStoreChange) => void

const listeners = new Set<IncidentStoreChangeListener>()

/** Subscribe; returns the unsubscribe function (same shape as the preload bridges). */
export function onIncidentStoreChange(listener: IncidentStoreChangeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announce a change.
 *
 * Never throws: a subscriber is UI plumbing, and the store is on a path that must survive a bad one.
 */
export function emitIncidentStoreChange(change: IncidentStoreChange): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(change)
    } catch {
      // A broken listener is not allowed to fail the write that caused it.
    }
  }
}

/** Test seam (house pattern): drop every subscriber between cases. */
export function __resetIncidentStoreChangeListenersForTests(): void {
  listeners.clear()
}

export function incidentStoreChangeListenerCount(): number {
  return listeners.size
}
