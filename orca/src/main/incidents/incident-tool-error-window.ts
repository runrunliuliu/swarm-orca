// Sliding-window counting for tool errors (issue-sedimentation.md v2.5 §7.3, M4-1).
//
// Same session + same tool + same normalized code, 5 times in 10 minutes. High-severity codes
// (`permission_denied`) open a candidate on the first hit.
//
// The window is **in-process and in-memory** on purpose: persisting it would need a new table and a
// write per failed tool call, and the design already accepts that a restart resets the count. The cost
// is stated here rather than hidden: a burst that straddles a restart needs up to five fresh events
// before it can open again, so a restart can delay a candidate by one window — never duplicate one,
// because the incident key is epoch-based.

export const TOOL_ERROR_WINDOW_MS = 10 * 60 * 1000
export const TOOL_ERROR_THRESHOLD = 5

export type ToolErrorWindowKey = {
  sessionId: string
  toolName: string
  code: string
  /** Journal turn item id (or `thread`); a new turn opens a new window. */
  turn: string
}

export type ToolErrorWindowSnapshot = ToolErrorWindowKey & {
  count: number
  /** First event still inside the window: the idempotency key's epoch. */
  windowStart: number
  lastAt: number
  highSeverity: boolean
  wouldWriteIfEnabled: boolean
  /** True once this window's incident was attempted, so a burst writes once. */
  written: boolean
  lastTurn: string
}

type WindowState = ToolErrorWindowSnapshot & { timestamps: number[] }

const windowKey = (key: ToolErrorWindowKey): string =>
  `${key.sessionId}\u0000${key.turn}\u0000${key.toolName}\u0000${key.code}`

export type ToolErrorWindowRecordResult = {
  count: number
  windowStart: number
  highSeverity: boolean
  wouldWriteIfEnabled: boolean
  /** The window already produced its incident; the caller must not write again. */
  alreadyWritten: boolean
  lastTurn: string
}

export type ToolErrorWindowTracker = {
  record: (input: ToolErrorWindowKey & { at: number; highSeverity: boolean }) =>
    | ToolErrorWindowRecordResult
  markWritten: (key: ToolErrorWindowKey, windowStart: number) => void
  snapshot: () => ToolErrorWindowSnapshot[]
  reset: () => void
  /** Bounded so a long-lived process cannot accumulate one entry per session/turn/tool/code forever. */
  size: () => number
  /** Windows dropped by the bound since start; a non-zero value means counts were lost (M4-C4). */
  evicted: () => number
}

export const TOOL_ERROR_WINDOW_MAX_ENTRIES = 512

export function createToolErrorWindowTracker(options: {
  windowMs?: number
  threshold?: number
  highSeverityCodes?: readonly string[]
  maxEntries?: number
} = {}): ToolErrorWindowTracker {
  const windowMs = options.windowMs ?? TOOL_ERROR_WINDOW_MS
  const threshold = options.threshold ?? TOOL_ERROR_THRESHOLD
  const highSeverityCodes = new Set(options.highSeverityCodes ?? ['permission_denied'])
  const maxEntries = options.maxEntries ?? TOOL_ERROR_WINDOW_MAX_ENTRIES
  const windows = new Map<string, WindowState>()
  let evicted = 0

  function evictIfNeeded(): void {
    while (windows.size > maxEntries) {
      // Map preserves insertion order; the oldest window is the least likely to still matter.
      const oldest = windows.keys().next().value
      if (oldest === undefined) {
        return
      }
      windows.delete(oldest)
      evicted += 1
    }
  }

  function record(input: ToolErrorWindowKey & { at: number; highSeverity: boolean }) {
    const key = windowKey(input)
    const cutoff = input.at - windowMs
    const state = windows.get(key)
    const timestamps = (state?.timestamps ?? []).filter((at) => at > cutoff)
    timestamps.push(input.at)
    const windowStart = timestamps[0]
    const highSeverity = input.highSeverity || highSeverityCodes.has(input.code)
    const count = timestamps.length
    const wouldWriteIfEnabled = highSeverity ? count >= 1 : count >= threshold
    const alreadyWritten = state?.written === true && state.windowStart === windowStart
    const next: WindowState = {
      sessionId: input.sessionId,
      toolName: input.toolName,
      code: input.code,
      turn: input.turn,
      count,
      windowStart,
      lastAt: input.at,
      highSeverity,
      wouldWriteIfEnabled,
      written: state?.written === true && state.windowStart === windowStart,
      lastTurn: input.turn,
      timestamps
    }
    // Re-insert so eviction order tracks recency.
    windows.delete(key)
    windows.set(key, next)
    evictIfNeeded()
    return {
      count,
      windowStart,
      highSeverity,
      wouldWriteIfEnabled,
      alreadyWritten,
      lastTurn: input.turn
    }
  }

  function markWritten(key: ToolErrorWindowKey, windowStart: number): void {
    const state = windows.get(windowKey(key))
    if (state && state.windowStart === windowStart) {
      state.written = true
    }
  }

  function snapshot(): ToolErrorWindowSnapshot[] {
    return [...windows.values()]
      .map(({ timestamps: _timestamps, ...rest }) => rest)
      .sort((left, right) => right.lastAt - left.lastAt)
  }

  function reset(): void {
    windows.clear()
    evicted = 0
  }

  return {
    record,
    markWritten,
    snapshot,
    reset,
    size: () => windows.size,
    evicted: () => evicted
  }
}
