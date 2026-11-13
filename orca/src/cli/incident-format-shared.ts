// Pure display helpers shared by the `orca incident …` formatters (§12, simplify S1).
//
// Deliberately tiny and behaviourless: column padding, an ISO timestamp, a byte count and a window
// label. Six formatters had their own copy of `pad()`, which is six places for the truncation rule to
// drift the day one of them wants an ellipsis.
//
// What is NOT here: the formatters themselves. Each one's wording, ordering and "what to warn about"
// is the operator's script for that command, and merging them would make a change to the stall text
// a change to the acceptance text.

/** Fixed-width column: truncate to the width, otherwise pad on the right. No ellipsis, no wrapping. */
export function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

/** ISO-8601 for a timestamp, or an em dash when there is nothing to show. */
export function isoTimestamp(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString()
}

/** Binary byte count with one decimal above the first unit. */
export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value}B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KB`
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

/** `7d` / `24h` / `90m` for a window length. Shared so digest and mine label the same window alike. */
export function formatWindowLabel(windowMs: number): string {
  return windowMs >= 86_400_000
    ? `${Math.round(windowMs / 86_400_000)}d`
    : windowMs >= 3_600_000
      ? `${Math.round(windowMs / 3_600_000)}h`
      : `${Math.round(windowMs / 60_000)}m`
}
