// The incident detail drawer (§9, §12; M7-B).
//
// A right-side `Sheet`, which is this repository's existing drawer primitive: Radix owns the focus
// trap, the `Escape` binding, the `aria-labelledby`/`aria-describedby` wiring and returning focus to
// the row that opened it. Re-implementing that around a plain absolutely-positioned div would be a
// second, worse focus model — so the only focus behaviour this file adds is "the close button is the
// first stop", which Radix does by focusing the content's first focusable element.
//
// The drawer is a *reader*: it renders what the record says. It does not read a transcript body (§6.3),
// does not infer an exit cause from an exit code, and does not filter the timeline. The one write path
// it exposes is `IncidentTriageActions`, which appends and shows the host's answer.

import { ExternalLink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  IncidentDecideRequest,
  IncidentDetailDto,
  IncidentEvidencePointerDto
} from '../../../../../shared/incident-api-types'
import {
  IncidentTriageActions,
  type IncidentDecideReply
} from './IncidentTriageActions'
import { IncidentCoverageDetail } from './IncidentCoverageDetail'
import type {
  IncidentLocalCoverageGap,
  IncidentRemoteCoverageLine
} from './incident-coverage-banner'
import {
  incidentDecisionTimeline,
  incidentEvidenceRows,
  incidentExitCauseView
} from './incident-detail-model'
import {
  evidenceKindLabel,
  incidentClassLabel,
  incidentExitCauseLabel,
  incidentStatusLabel
} from './incident-labels'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function ExitCause({ detail }: { detail: IncidentDetailDto }): React.JSX.Element {
  const view = incidentExitCauseView(detail.exitCause)
  // `unknown` is not greyed out as "bad data": it is a first-class answer and reads as one.
  const unknown = view.kind === 'unknown' || view.kind === 'not_recorded'
  return (
    <p className={unknown ? 'text-[12px] text-status-warning' : 'text-[12px]'}>{incidentExitCauseLabel(view)}</p>
  )
}

function EvidencePointers({
  detail,
  onOpenEvidence
}: {
  detail: IncidentDetailDto
  onOpenEvidence: (pointer: IncidentEvidencePointerDto) => void
}): React.JSX.Element {
  const rows = incidentEvidenceRows(detail.evidence)
  return (
    <Section
      title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.0e3dd862ed',
        'Evidence pointers'
      )}
    >
      <p className="text-[10px] text-muted-foreground">
        {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.d94f948519',
          'Pointers only: path, byte offsets and sha256. No transcript body is loaded or rendered here, and offsets are not line numbers.'
        )}
      </p>
      {rows.length === 0 ? (
        <p className="text-[12px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.6c44f59135',
            'No evidence pointer was recorded for this incident. That is a gap, not a clean bill of health.'
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row, index) => {
            const pointer = detail.evidence.pointers[index]
            return (
              <li key={`${row.path}:${index}`} className="rounded border border-border px-2 py-1 text-[10px]">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{evidenceKindLabel(row.kind)}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.fcbc1582ad',
                      'Open {{path}}',
                      { path: row.path }
                    )}
                    title={row.path}
                    onClick={() => onOpenEvidence(pointer)}
                  >
                    <ExternalLink size={12} />
                  </Button>
                </div>
                <div className="break-all font-mono text-muted-foreground">{row.path}</div>
                <div className="flex flex-wrap gap-x-2 text-muted-foreground">
                  <span>
                    {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.ca8f4dcd35',
                      'offsets'
                    )}
                    : {row.offsetRange ?? '—'}
                  </span>
                  <span title={row.sha256 ?? undefined}>
                    sha256: {row.sha256Short ?? '—'}
                  </span>
                  <span>
                    {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.499a404b5b',
                      'bytes'
                    )}
                    : {row.bytes ?? '—'}
                  </span>
                  {row.truncated && (
                    <span className="text-status-warning">
                      {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.73045e5bad',
                        'window truncated'
                      )}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

function UnknownBoundaries({ detail }: { detail: IncidentDetailDto }): React.JSX.Element {
  const boundaries = detail.evidence.unknownBoundaries
  return (
    <Section
      title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.1916de7c15',
        'Unknown boundaries'
      )}
    >
      {boundaries.length === 0 ? (
        <p className="text-[12px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.9b708f5b0a',
            'No unknown boundary was recorded. The absence itself is a gap: this row does not enumerate what could not be observed.'
          )}
        </p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
          {boundaries.map((boundary) => (
            <li key={boundary}>{boundary}</li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function DecisionTimeline({ detail, now }: { detail: IncidentDetailDto; now: number }): React.JSX.Element {
  const timeline = incidentDecisionTimeline(detail.decisions)
  return (
    <Section
      title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.4093c44621',
        'Decision timeline (append-only)'
      )}
    >
      {timeline.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.23c59d7618',
            'No decision has been recorded. untriaged is a valid resting state: nobody is forced to judge a row they cannot judge.'
          )}
        </p>
      ) : (
        <ol className="space-y-1">
          {timeline.map((decision) => (
            <li key={decision.id} className="rounded border border-border px-2 py-1 text-[11px]">
              <div className="flex flex-wrap items-center gap-1">
                <span className="font-medium">
                  {incidentStatusLabel(decision.fromStatus)} → {incidentStatusLabel(decision.toStatus)}
                </span>
                <span className="text-muted-foreground">
                  {formatUiRelativeTime(decision.createdAt - now)}
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.0d312004c5',
                  'actor (self-reported)'
                )}
                : {decision.actor}
              </div>
              <div>{decision.reason}</div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}

/** Stable default: an array literal default would be a new reference on every render. */
const NO_LOCAL_COVERAGE_GAPS: readonly IncidentLocalCoverageGap[] = []

export function IncidentDetailDrawer({
  detail,
  loading,
  error,
  now,
  coverageLocalGaps = NO_LOCAL_COVERAGE_GAPS,
  coverageRemoteLine = null,
  onClose,
  onDecide,
  onOpenEvidence
}: {
  detail: IncidentDetailDto | null
  loading: boolean
  error: string | null
  now: number
  /** Coverage is list-level, passed in so the drawer can state it without a second read. */
  coverageLocalGaps?: readonly IncidentLocalCoverageGap[]
  coverageRemoteLine?: IncidentRemoteCoverageLine | null
  onClose: () => void
  onDecide: (request: IncidentDecideRequest) => Promise<IncidentDecideReply>
  onOpenEvidence: (pointer: IncidentEvidencePointerDto) => void
}): React.JSX.Element {
  const open = detail !== null || loading || error !== null
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(28rem,92vw)] sm:max-w-none"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <SheetTitle>
                <span className="block truncate">
                  {detail === null
                    ? translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.72260bf5c1',
                        'Incident'
                      )
                    : `${incidentClassLabel(detail.class)} · ${detail.id}`}
                </span>
              </SheetTitle>
              <SheetDescription>
                <span className="block truncate">
                  {detail === null
                    ? translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.229adedfd0',
                        'Loading this incident from the host store.'
                      )
                    : detail.summary}
                </span>
              </SheetDescription>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={onClose}
              aria-label={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.ec79155587',
                'Close incident details'
              )}
            >
              <X size={14} />
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-sleek px-3 py-2">
            {error !== null && (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px]">
                {error}
              </p>
            )}
            {detail === null ? (
              loading ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.bedc2d060d',
                    'Reading one row and its decision log…'
                  )}
                </p>
              ) : null
            ) : (
              <>
                <Section
                  title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.e9af8a88b9',
                    'Status'
                  )}
                >
                  <p className="text-[12px]">
                    {incidentStatusLabel(detail.effectiveStatus)}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.6593ee56cb',
                        '(entry status {{status}}, {{count}} decision(s))',
                        {
                          status: incidentStatusLabel(detail.status),
                          count: detail.decisionCount
                        }
                      )}
                    </span>
                  </p>
                </Section>
                <Section
                  title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.a386664c68',
                    'Exit cause'
                  )}
                >
                  <ExitCause detail={detail} />
                </Section>
                <IncidentCoverageDetail
                  localGaps={coverageLocalGaps}
                  remoteLine={coverageRemoteLine}
                />
                <UnknownBoundaries detail={detail} />
                <EvidencePointers detail={detail} onOpenEvidence={onOpenEvidence} />
                <DecisionTimeline detail={detail} now={now} />
                <Section
                  title={translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.690d66222c',
                    'Source'
                  )}
                >
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[10px] text-muted-foreground">
                    <dt>{translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.6fb399bd7f', 'source')}</dt>
                    <dd className="truncate font-mono">
                      {detail.sourceKind}/{detail.facet}
                    </dd>
                    <dt>{translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.30871945d1', 'host')}</dt>
                    <dd className="truncate font-mono">{detail.hostId}</dd>
                    <dt>{translate('auto.components.right.sidebar.incidents.IncidentDetailDrawer.81a462587b', 'fingerprint')}</dt>
                    <dd className="truncate font-mono" title={detail.fingerprint}>
                      {detail.fingerprint.slice(0, 16)}
                    </dd>
                  </dl>
                </Section>
                <IncidentTriageActions incidentId={detail.id} onDecide={onDecide} />
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
