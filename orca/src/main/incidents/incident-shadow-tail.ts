// "Is every line in this file already replayed?" answered from the file's tail (M2-C6).
//
// A cold start must not read a 100MB family to discover that all of it is old. Seq increases with
// append order, so the last parseable line's seq is an upper bound for the whole file: if it is at or
// below the watermark, nothing inside can be new. Only the tail sample is read.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { shadowLineSeq } from './incident-shadow-line'

const TAIL_SAMPLE_BYTES = 8192

/** Highest parseable seq in the last `TAIL_SAMPLE_BYTES`, or `null` when none can be read. */
export function lastSeqInTail(path: string): number | null {
  try {
    const size = statSync(path).size
    if (size === 0) {
      return null
    }
    const from = Math.max(0, size - TAIL_SAMPLE_BYTES)
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(size - from)
      let offset = 0
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, from + offset)
        if (read <= 0) {
          break
        }
        offset += read
      }
      const lines = buffer
        .toString('utf8', 0, offset)
        .split('\n')
        .filter((line) => line.trim().length > 0)
      // The last line may be torn, so walk backwards to the first line that yields a seq.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          return shadowLineSeq(lines[index])
        } catch {
          continue
        }
      }
      return null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
