// The graded coverage banner (§11.5, §12; M7-B).
//
// Two blocks, not one warning: local holes (primary) and — only when it is a real, monitored hole — the
// remote view (secondary). The permanent "no remote capture" fact is not rendered here at all; it lives
// in the drawer's Remote view section, because a host that never configured a peer is the normal case
// and a standing banner about it is noise that teaches readers to skim past the local warnings.
//
// The banner is never conditional on the list being empty or non-empty. That is why it lives outside
// the list component.

import { AlertTriangle, LoaderCircle, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  IncidentLocalCoverageGap,
  IncidentRemoteCoverageLine
} from './incident-coverage-banner'
import { localCoverageGapText, remoteCoverageText } from './incident-coverage-copy'

function LocalGapIcon({ gap }: { gap: IncidentLocalCoverageGap }): React.JSX.Element {
  return gap.kind === 'replay_incomplete' ? (
    <LoaderCircle
      size={12}
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-status-warning"
    />
  ) : (
    <AlertTriangle
      size={12}
      aria-hidden="true"
      className={cn('mt-0.5 shrink-0', gap.kind === 'currently_limited' && 'text-destructive')}
    />
  )
}

export function IncidentCoverageBanner({
  localGaps,
  remoteLine
}: {
  localGaps: readonly IncidentLocalCoverageGap[]
  /** Rendered only when the remote view is a monitored hole; `not_configured` stays in the drawer. */
  remoteLine: IncidentRemoteCoverageLine | null
}): React.JSX.Element {
  const showRemote = remoteLine !== null && remoteLine.gap
  return (
    <section
      aria-label={translate('auto.components.right.sidebar.incidents.IncidentCoverageBanner.24d8210b41',
        'Coverage of this incident list'
      )}
      className="shrink-0 space-y-1 border-b border-border px-3 py-2"
    >
      {localGaps.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate('auto.components.right.sidebar.incidents.IncidentCoverageBanner.3af3ea53c0',
              'Local coverage — the untriaged count above is a lower bound'
            )}
          </p>
          {localGaps.map((gap) => (
            <p
              key={gap.kind}
              className={cn(
                'flex items-start gap-1.5 rounded border px-1.5 py-1 text-[11px] leading-4 text-foreground',
                gap.kind === 'currently_limited'
                  ? 'border-destructive/40 bg-destructive/10'
                  : 'border-status-warning-border bg-status-warning-background'
              )}
            >
              <LocalGapIcon gap={gap} />
              <span>{localCoverageGapText(gap)}</span>
            </p>
          ))}
        </div>
      )}

      {showRemote && remoteLine !== null && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate('auto.components.right.sidebar.incidents.IncidentCoverageBanner.023fd64eeb',
              'Remote view — global visibility, not this host\'s records'
            )}
          </p>
          {/* Secondary treatment: an outline, not a filled warning. See incident-remote-coverage.ts. */}
          <p className="flex items-start gap-1.5 rounded border border-border bg-transparent px-1.5 py-1 text-[11px] leading-4 text-muted-foreground">
            <Radio size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{remoteCoverageText(remoteLine, false)}</span>
          </p>
        </div>
      )}
    </section>
  )
}
