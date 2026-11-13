// Triage actions for one incident (§5, §12; M7-B).
//
// The panel offers the five actions and lets the host refuse. It does not decide:
//
//   * there is no transition table here, so `confirmed` is offered on a `closed` row too and the
//     refusal (`invalid_transition`) is displayed. A renderer-side table would be a second policy,
//     and the one surfaced to the user would be the wrong one as soon as the store changes;
//   * `actor` is never prefilled. §19.1 makes it self-reported and unverified, and a pre-filled
//     "operator" would make every `confirmed` row look attributed without anyone typing a name. The
//     field is marked required-looking only through copy, not by blocking submit — the store is the
//     authority on whether an actor is required;
//   * `reason` is equally the host's rule (`reason_required`), so an empty reason is submitted and
//     answered rather than silently disabled.
//
// Confirmation is a distinct, explicit step: the reader picks a target, then submits. There is no
// one-click `confirmed` and no batch action.

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { IncidentDecideRequest, IncidentStatusDto } from '../../../../../shared/incident-api-types'
import {
  incidentDecisionOutcomeView,
  type IncidentDecisionOutcomeView
} from './incident-detail-model'

/** The five actions §12 allows from the panel. `confirmed` is included but never auto-acted. */
export const TRIAGE_TARGETS = [
  'watch',
  'duplicate',
  'invalid',
  'needs_archive',
  'confirmed'
] as const satisfies readonly IncidentStatusDto[]

function targetLabel(target: (typeof TRIAGE_TARGETS)[number]): string {
  switch (target) {
    case 'watch':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.943f26ceb7',
        'Watch'
      )
    case 'duplicate':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.3243153b12',
        'Duplicate'
      )
    case 'invalid':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.3bc69884dd',
        'Invalid'
      )
    case 'needs_archive':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.1567092ea6',
        'Needs archive'
      )
    case 'confirmed':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.39556064e5',
        'Confirmed'
      )
  }
}

export type IncidentDecideReply = {
  outcome: string
  detail?: string | null
}

function outcomeMessage(view: IncidentDecisionOutcomeView): string {
  switch (view.kind) {
    case 'appended':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.169f2b22e0',
        'Decision appended. The incident row itself is unchanged; the timeline and status were projected from it.'
      )
    case 'actor_required':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.195a238741',
        'An actor is required for this decision and none was given. Type who is deciding; it is recorded as self-reported.'
      )
    case 'reason_required':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.7c6ef8406c',
        'A reason is required for every decision. Say why, even briefly.'
      )
    case 'invalid_transition':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.f10f9605a9',
        'The store refuses that move from the current status. Nothing was recorded.'
      )
    case 'status_unchanged':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.0796a184f5',
        'That is already the current status, so there is nothing to record.'
      )
    case 'status_changed':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.5769b25d9c',
        'The status changed before this decision was recorded. Reload the incident and decide again.'
      )
    case 'not_found':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.cfe8e19364',
        'This incident no longer exists in the store. It may have been pruned.'
      )
    case 'unavailable':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.abdc4aa03d',
        'The incident store refused the write: {{detail}}',
        { detail: view.detail ?? 'unavailable' }
      )
    case 'other':
      return translate('auto.components.right.sidebar.incidents.IncidentTriageActions.bf05ad4ca4',
        'The decision was not recorded: {{detail}}',
        { detail: view.detail ?? 'unknown outcome' }
      )
  }
}

export function IncidentTriageActions({
  incidentId,
  onDecide
}: {
  incidentId: string
  onDecide: (request: IncidentDecideRequest) => Promise<IncidentDecideReply>
}): React.JSX.Element {
  const [target, setTarget] = useState<(typeof TRIAGE_TARGETS)[number] | null>(null)
  const [actor, setActor] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<IncidentDecisionOutcomeView | null>(null)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (target === null || busy) {
      return
    }
    setBusy(true)
    try {
      const reply = await onDecide({
        incidentId,
        toStatus: target,
        ...(actor.trim().length === 0 ? {} : { actor }),
        reason
      })
      setFeedback(incidentDecisionOutcomeView(reply.outcome, reply.detail ?? null))
      if (reply.outcome === 'appended') {
        setReason('')
      }
    } catch (error) {
      setFeedback({
        kind: 'other',
        detail: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={translate('auto.components.right.sidebar.incidents.IncidentTriageActions.c74785a719',
        'Triage this incident'
      )}
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-1">
        {TRIAGE_TARGETS.map((candidate) => {
          return (
            <Button
              key={candidate}
              type="button"
              size="xs"
              variant={target === candidate ? 'secondary' : 'outline'}
              aria-pressed={target === candidate}
              onClick={() => {
                setTarget(candidate)
                setFeedback(null)
              }}
            >
              {targetLabel(candidate)}
            </Button>
          )
        })}
      </div>

      {target === null ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentTriageActions.176c4a3f00',
            'Pick an action first. Nothing is recorded until you submit it, and every decision is appended, never overwritten.'
          )}
        </p>
      ) : (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-1 text-[11px]">
            <span className="font-medium">
              {translate('auto.components.right.sidebar.incidents.IncidentTriageActions.003711947c', 'Reason')}
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              aria-label={translate('auto.components.right.sidebar.incidents.IncidentTriageActions.003711947c',
                'Reason'
              )}
              className="w-full resize-none rounded border border-border bg-input/40 px-2 py-1 text-[11px] outline-none focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/40"
            />
          </label>
          <label className="block space-y-1 text-[11px]">
            <span className="font-medium">
              {translate('auto.components.right.sidebar.incidents.IncidentTriageActions.ae629b1386',
                'Actor (self-reported, not verified)'
              )}
            </span>
            <input
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              // Never prefilled: §19.1 makes the actor an unverified claim, and a default name would
              // attribute decisions to someone who never typed anything.
              placeholder={translate('auto.components.right.sidebar.incidents.IncidentTriageActions.d5b240a0f3',
                'your name'
              )}
              aria-label={translate('auto.components.right.sidebar.incidents.IncidentTriageActions.ae629b1386',
                'Actor (self-reported, not verified)'
              )}
              className="w-full rounded border border-border bg-input/40 px-2 py-1 text-[11px] outline-none focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/40"
            />
            {target === 'confirmed' && (
              <span className="block text-[10px] text-status-warning">
                {translate('auto.components.right.sidebar.incidents.IncidentTriageActions.87401e3dfe',
                  'confirmed requires an explicit actor and a reason. Leaving the actor blank is refused by the store.'
                )}
              </span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <Button type="submit" size="xs" disabled={busy}>
              {busy
                ? translate('auto.components.right.sidebar.incidents.IncidentTriageActions.465a493bfa',
                    'Recording…'
                  )
                : translate('auto.components.right.sidebar.incidents.IncidentTriageActions.1dc714e43f',
                    'Record decision'
                  )}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {translate('auto.components.right.sidebar.incidents.IncidentTriageActions.c6463c3c3c',
                'Append-only: this adds a decision, it does not edit the incident.'
              )}
            </span>
          </div>
        </form>
      )}

      {feedback !== null && (
        <p
          role="status"
          className={cn(
            'rounded border px-2 py-1 text-[11px]',
            feedback.kind === 'appended'
              ? 'border-status-success-border bg-status-success-background text-foreground'
              : 'border-destructive/40 bg-destructive/10 text-foreground'
          )}
        >
          {outcomeMessage(feedback)}
        </p>
      )}
    </section>
  )
}
