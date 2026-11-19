/**
 * Per-session token attribution from the four `*UsageRecentSessions` arrays
 * (README §7.5). Kept as its own module because the rule it implements is the
 * one the task page is most likely to get wrong: a session id two providers both
 * report is *ambiguous*, not a number to add twice.
 *
 * The rule:
 * - one provider reports a session → that provider's figure is the session's;
 * - two providers report the same session id → the figure is unknown, not the
 *   larger one and not a sum. A retained session cannot be split between
 *   providers, so a pick would be a fabricated attribution.
 */
export type SessionTokenClaim = {
  sessionId: string
  tokens: number
}

export type SessionTokenTotals = ReadonlyMap<string, number | null>

/** `null` means ambiguous: a claim key mapped to two different figures. */
export function sessionTokenTotals(claims: readonly SessionTokenClaim[]): SessionTokenTotals {
  const totals = new Map<string, number | null>()
  for (const claim of claims) {
    if (claim.sessionId === '') {
      continue
    }
    totals.set(claim.sessionId, totals.has(claim.sessionId) ? null : claim.tokens)
  }
  return totals
}

/** The token figure for one session, or `null` when unknown or ambiguous. */
export function sessionTokensFor(
  totals: SessionTokenTotals,
  sessionId: string | undefined
): number | null {
  if (!sessionId) {
    return null
  }
  const tokens = totals.get(sessionId)
  return typeof tokens === 'number' ? tokens : null
}
