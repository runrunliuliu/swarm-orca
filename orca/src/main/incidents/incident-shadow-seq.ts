// The shadow's monotonic sequence numbers (issue-sedimentation.md v2.3 §11.2, M2-C1).
//
// The watermark is `lastSeq`, so a line's seq has to satisfy three things at once:
//   * strictly increasing inside one writer (a repeat write in the same millisecond cannot collide);
//   * unique across writers — the runtime and the CLI append to the same family, sometimes in the
//     same millisecond;
//   * ordered by append time, because replay skips everything at or below the watermark.
//
// Encoding: `virtualMs * 4096 + slot`.
//   * `slot` is 12 bits derived from the writer's process id. Two concurrent processes have
//     distinct pids; distinct slots can never produce the same number for the same `virtualMs`.
//   * `virtualMs` starts at the wall-clock millisecond and is bumped to the next virtual millisecond
//     when this writer has already used its slot in that millisecond. That keeps a busy writer
//     strictly increasing *without* stepping into another writer's slot (the naive `last + 1` bump
//     would).
//   * `Date.now() * 4096` stays below `Number.MAX_SAFE_INTEGER` until 2086.
//
// Residual, stated rather than hidden: two *concurrent* processes whose pids differ by a multiple of
// 4096 share a slot. That is the only way to collide, and the store's UNIQUE key still decides
// whether the record itself is a duplicate — seq only orders replay.

export const SHADOW_SEQ_SLOT_BITS = 12
export const SHADOW_SEQ_SLOT_SIZE = 1 << SHADOW_SEQ_SLOT_BITS
const SLOT_MASK = SHADOW_SEQ_SLOT_SIZE - 1

export function shadowSeqSlotForPid(pid: number): number {
  return Number.isFinite(pid) ? Math.abs(Math.trunc(pid)) & SLOT_MASK : 0
}

export type ShadowSeqGenerator = {
  readonly slot: number
  /** Next sequence number for `now` (defaults to the wall clock). */
  next: (now?: number) => number
}

/**
 * A generator for one writer. `slot` is injectable so a test can drive two "processes" and prove
 * they never collide; production leaves it to the pid.
 */
export function createShadowSeqGenerator(slot: number = shadowSeqSlotForPid(process.pid)): ShadowSeqGenerator {
  const normalized = Math.abs(Math.trunc(slot)) & SLOT_MASK
  let last = 0

  function next(now: number = Date.now()): number {
    const wallMs = Number.isFinite(now) ? Math.floor(now) : Date.now()
    // Smallest virtual millisecond whose slot value is greater than the previous one.
    const floorVirtual = Math.ceil((last + 1 - normalized) / SHADOW_SEQ_SLOT_SIZE)
    const virtualMs = Math.max(wallMs, floorVirtual)
    last = virtualMs * SHADOW_SEQ_SLOT_SIZE + normalized
    return last
  }

  return { slot: normalized, next }
}
