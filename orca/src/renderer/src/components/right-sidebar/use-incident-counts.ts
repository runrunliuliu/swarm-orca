// Pull the incident counts once, then follow the main-process push (§12, M7-A).
//
// The push is already coalesced upstream (`main/ipc/incident-counts-push.ts`), so this hook keeps no
// timer of its own: a second debounce here would only add a second set of windows to reason about.
//
// Two honesty rules:
//   * an unavailable store is not "0 untriaged" — it leaves the counts `null` (no badge) instead of
//     drawing a reassuring zero over an unreadable store;
//   * a pull that resolves after the first push must not overwrite newer counts, so the newer
//     `readAt` wins either way.

import { useEffect, useState } from 'react'
import type { IncidentCountsDto } from '../../../../shared/incident-api-types'

function newer(
  current: IncidentCountsDto | null,
  next: IncidentCountsDto
): IncidentCountsDto {
  return current === null || next.readAt >= current.readAt ? next : current
}

export function useIncidentCounts(): IncidentCountsDto | null {
  const [counts, setCounts] = useState<IncidentCountsDto | null>(null)

  useEffect(() => {
    let live = true
    let unsubscribe: (() => void) | null = null
    // One guarded access for both calls: a renderer without the incident bridge (paired web client,
    // or a component test that mocks a partial `window.api`) must still render, just without a badge.
    const api = (() => {
      const incidents = window.api?.incidents
      return incidents && typeof incidents.counts === 'function' ? incidents : null
    })()
    if (api === null) {
      return
    }
    try {
      unsubscribe = api.onCountsChanged((next) => {
        if (live) {
          setCounts((current) => newer(current, next))
        }
      })
    } catch {
      unsubscribe = null
    }
    void api
      .counts()
      .then((result) => {
        if (live && result.ok) {
          setCounts((current) => newer(current, result.value))
        }
      })
      .catch(() => {
        // Same as a closed failure: no badge rather than a guessed one.
      })
    return () => {
      live = false
      unsubscribe?.()
    }
    // Mount-only on purpose: the counts are host-global, so no store field can change the answer and
    // re-subscribing on every state write would churn listeners for no new information.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return counts
}
