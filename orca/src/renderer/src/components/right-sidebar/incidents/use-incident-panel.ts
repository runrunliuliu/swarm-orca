// IPC plumbing for the incident panel (§12, M7-B).
//
// Four independent reads: the list snapshot, one detail row, and the two grayscale views. Split into
// hooks instead of one omnibus "panel data" object because their lifetimes differ — the detail exists
// only while a drawer is open, the gray views only while their tab is selected, and both would
// otherwise be re-fetched (and could resolve out of order) on every list refresh.
//
// Two rules repeated from `use-incident-counts.ts`:
//   * reads go through `runtime/incident-read-client` (local or a paired environment) and never through
//     `window.api.incidents`, which is local-only; the decide/gray paths stay on the bridge because they
//     mutate or project the local store (§19.1). A renderer without the bridge still renders, stating
//     which of those it cannot do;
//   * a slow response must not overwrite a newer one. Each hook keeps a generation counter and drops
//     any result that is not from its own last request.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  IncidentDecideRequest,
  IncidentDecideResultDto,
  IncidentDecideFailureDto,
  IncidentDetailDto,
  IncidentListRequest,
  IncidentSnapshotDto
} from '../../../../../shared/incident-api-types'
import type {
  IncidentPaneClocksViewDto,
  IncidentToolFailuresViewDto
} from '../../../../../shared/incident-gray-types'
import type { IncidentDecideReply } from './IncidentTriageActions'
import { incidentReadTarget, readIncidentDetail, readIncidentSnapshot } from '../../../runtime/incident-read-client'
import { useAppStore } from '../../../store'

type IncidentBridge = NonNullable<Window['api']>['incidents']

/** One guarded access for every hook: no bridge means "stated unavailable", not a thrown render. */
function incidentBridge(): IncidentBridge | null {
  const bridge = window.api?.incidents
  return bridge && typeof bridge.snapshot === 'function' ? bridge : null
}

const NO_BRIDGE_MESSAGE =
  'The incident bridge is not available in this window, so the panel cannot read the host store.'

type SnapshotState = {
  snapshot: IncidentSnapshotDto | null
  loading: boolean
  error: string | null
  /**
   * Why the list is empty, when it is: `idle` before the first read, `unsupported` when the selected
   * host serves no incident read at all, `unavailable` when it does but could not answer. Only `ok`
   * with zero rows may be described as "no incidents".
   */
  availability: 'idle' | 'ok' | 'unsupported' | 'unavailable'
}

export function useIncidentSnapshot(
  request: IncidentListRequest,
  isVisible: boolean
): SnapshotState & {
  reload: () => void
} {
  const [state, setState] = useState<SnapshotState>({
    snapshot: null,
    loading: true,
    error: null,
    availability: 'idle'
  })
  // Why the target is read here and not passed in: the panel is host-scoped, and the selection can
  // change while the sidebar stays mounted. Reading it in the hook keeps the list, the detail and the
  // counts on one selection instead of three call sites that could disagree.
  const activeEnvironmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  // Why memoized on the id and not on `settings`: `getActiveRuntimeTarget` returns a fresh object, and an
  // unstable target would re-run `load` on every render (an unbounded read loop, which is exactly what
  // the panel test surfaced).
  const target = useMemo(
    () => incidentReadTarget({ activeRuntimeEnvironmentId: activeEnvironmentId }),
    [activeEnvironmentId]
  )
  const generation = useRef(0)
  // Read through a ref so a visibility change does not re-subscribe the push listener below.
  const visible = useRef(isVisible)
  visible.current = isVisible

  const load = useCallback(() => {
    const current = ++generation.current
    setState((previous) => ({ ...previous, loading: true, error: null }))
    void readIncidentSnapshot(target, request)
      .then((outcome) => {
        if (current !== generation.current) {
          return
        }
        if (outcome.availability === 'supported') {
          setState({ snapshot: outcome.value, loading: false, error: null, availability: 'ok' })
          return
        }
        setState({
          snapshot: null,
          loading: false,
          error: outcome.availability === 'unavailable' ? outcome.error : null,
          availability: outcome.availability
        })
      })
      .catch((error: unknown) => {
        if (current !== generation.current) {
          return
        }
        setState({
          snapshot: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          availability: 'unavailable'
        })
      })
  }, [request, target])

  // The sidebar keeps this panel mounted while it is collapsed, so a read only happens for a panel a
  // reader can actually see — and becoming visible is itself the refresh trigger, which is what keeps
  // a long-hidden panel from showing a snapshot nobody updated (review C7).
  useEffect(() => {
    if (isVisible) {
      load()
    }
  }, [load, isVisible])

  // Follow the coalesced store push: a decision made in the CLI, or a new crash, must not leave an open
  // panel showing yesterday's list. The main process already coalesced, so no timer is added here.
  // While hidden the push is dropped on purpose: a 200-row snapshot read per coalesced write, for a
  // panel nobody can see, is the cost this gate removes.
  useEffect(() => {
    const bridge = incidentBridge()
    if (bridge === null || typeof bridge.onCountsChanged !== 'function') {
      return
    }
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = bridge.onCountsChanged(() => {
        if (visible.current) {
          load()
        }
      })
    } catch {
      unsubscribe = null
    }
    return () => unsubscribe?.()
  }, [load])

  return { ...state, reload: load }
}

type DetailState = {
  detail: IncidentDetailDto | null
  loading: boolean
  error: string | null
}

export function useIncidentDetail(incidentId: string | null): DetailState & {
  reload: () => void
} {
  const [state, setState] = useState<DetailState>({ detail: null, loading: false, error: null })
  const generation = useRef(0)
  const activeEnvironmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const target = useMemo(
    () => incidentReadTarget({ activeRuntimeEnvironmentId: activeEnvironmentId }),
    [activeEnvironmentId]
  )

  const load = useCallback(() => {
    if (incidentId === null) {
      generation.current += 1
      setState({ detail: null, loading: false, error: null })
      return
    }
    const current = ++generation.current
    setState((previous) => ({ ...previous, loading: true, error: null }))
    void readIncidentDetail(target, incidentId)
      .then((outcome) => {
        if (current !== generation.current) {
          return
        }
        setState(
          outcome.availability === 'supported'
            ? { detail: outcome.value, loading: false, error: null }
            : {
                detail: null,
                loading: false,
                error:
                  outcome.availability === 'unavailable'
                    ? outcome.error
                    : 'This host does not serve incident reads.'
              }
        )
      })
      .catch((error: unknown) => {
        if (current !== generation.current) {
          return
        }
        setState({
          detail: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }, [incidentId, target])

  useEffect(() => {
    load()
  }, [load])

  return { ...state, reload: load }
}

/**
 * Append one decision, then let the caller refresh what it reads.
 *
 * The renderer does not interpret the outcome: `appended` is the only one that triggers a refresh,
 * because any other outcome wrote nothing. Everything else is handed back verbatim for the drawer to
 * display (`actor_required`, `invalid_transition`, …), so the store's policy is the only policy.
 */
export function useIncidentDecide(options: { onAppended: () => void }): (
  request: IncidentDecideRequest
) => Promise<IncidentDecideReply> {
  const { onAppended } = options
  return useCallback(
    async (request: IncidentDecideRequest): Promise<IncidentDecideReply> => {
      const bridge = incidentBridge()
      if (bridge === null) {
        return { outcome: 'incident_store_unavailable', detail: NO_BRIDGE_MESSAGE }
      }
      const result = await bridge.decide(request)
      if (!result.ok) {
        return { outcome: result.code, detail: result.error }
      }
      const value: IncidentDecideResultDto | IncidentDecideFailureDto = result.value
      if (value.outcome === 'appended') {
        onAppended()
        return { outcome: 'appended' }
      }
      return { outcome: value.outcome, detail: value.detail }
    },
    [onAppended]
  )
}

type GrayState<T> = { view: T | null; loading: boolean; error: string | null }

/**
 * One grayscale view, fetched only while its tab is selected.
 *
 * `active` is the tab's visibility, and it is also the reload trigger: a reader who opens the tab
 * expects a fresh sample, not the one from the last time it was opened.
 */
export function useIncidentGrayView<T>(
  active: boolean,
  read: (bridge: IncidentBridge) => Promise<
    { ok: true; value: T } | { ok: false; error: string; code: string }
  >
): GrayState<T> & { reload: () => void } {
  const [state, setState] = useState<GrayState<T>>({ view: null, loading: false, error: null })
  const generation = useRef(0)
  const readRef = useRef(read)
  readRef.current = read

  const load = useCallback(() => {
    const bridge = incidentBridge()
    const current = ++generation.current
    if (!active) {
      return
    }
    if (bridge === null) {
      setState({ view: null, loading: false, error: NO_BRIDGE_MESSAGE })
      return
    }
    setState((previous) => ({ ...previous, loading: true, error: null }))
    void readRef
      .current(bridge)
      .then((result) => {
        if (current !== generation.current) {
          return
        }
        setState(
          result.ok
            ? { view: result.value, loading: false, error: null }
            : { view: null, loading: false, error: result.error }
        )
      })
      .catch((error: unknown) => {
        if (current !== generation.current) {
          return
        }
        setState({
          view: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }, [active])

  useEffect(() => {
    load()
  }, [load])

  return { ...state, reload: load }
}

export function useIncidentPaneClocks(
  active: boolean
): GrayState<IncidentPaneClocksViewDto> & { reload: () => void } {
  return useIncidentGrayView<IncidentPaneClocksViewDto>(active, (bridge) => bridge.paneClocks())
}

export function useIncidentToolFailures(
  active: boolean
): GrayState<IncidentToolFailuresViewDto> & { reload: () => void } {
  return useIncidentGrayView<IncidentToolFailuresViewDto>(active, (bridge) => bridge.toolFailures())
}
