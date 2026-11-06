// Formats are pinned to raw Linux captures (0.209.1, 0.212.1 and 0.213.1).
const CONTEXT_FOOTER = / · Context \d+% left · /i
const MODEL_PATH_FOOTER = /^\S[^\n]* · (?:\/|~\/|[a-z]:[\\/])/i
const TRAILING_CONTEXT_FOOTER = / · Context \d+% left$/i

/** Fresh-start evidence only: the composer also remains visible during business turns. */
export function hasTraeStartupComposer(lines: readonly string[]): boolean {
  const trimmed = lines.map((line) => line.trim())
  if (trimmed.some((line) => /Booting MCP server:|esc to interrupt/i.test(line))) {
    return false
  }
  return trimmed.some((line, index) => {
    const footer = trimmed[index + 2] ?? ''
    return (
      /^❯(?:\s|$)/.test(line) &&
      /^─{4,}$/.test(trimmed[index - 1] ?? '') &&
      /^─{4,}$/.test(trimmed[index + 1] ?? '') &&
      (CONTEXT_FOOTER.test(footer) ||
        (MODEL_PATH_FOOTER.test(footer) &&
          (TRAILING_CONTEXT_FOOTER.test(footer) || trimmed[index + 3] === '? for shortcuts')))
    )
  })
}

/** A later Trae banner/composer dismisses historical trust, but does NOT establish idle. */
export function findTraePostTrustPromptIndex(normalized: string): number | null {
  const header = normalized.lastIndexOf('trae cli')
  if (header === -1) {
    return null
  }
  const segment = normalized.slice(header)
  const composer = /─{4,}\s*❯[^─]*─{4,}\s*([^\n─]+)/g
  let last: number | null = null
  for (const match of segment.matchAll(composer)) {
    const footer = match[1]
    if (
      CONTEXT_FOOTER.test(` ${footer}`) ||
      (MODEL_PATH_FOOTER.test(footer) && /\? for shortcuts/.test(footer))
    ) {
      last = header + match.index
    }
  }
  return last
}
