// The drawer's coverage section (§12, M7-B; graded per the codex-ark/trae arbitration).
//
// Local and remote are two labelled sections with different weight, never one merged warning:
//
//   * "Local coverage" lists the holes that make the local untriaged count a lower bound;
//   * "Remote view" always states the remote position when the host reports one — including
//     `not_configured`, which is where "never set up" belongs — and says in words that a remote hole
//     is a gap in the global view, not damage to this host's records.
//
// The `not_configured` line lives here and only here. That is the arbitration's rule, and it is also
// the reason the banner stays quiet on a host that never mirrored anything.

import { Radio } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type {
  IncidentLocalCoverageGap,
  IncidentRemoteCoverageLine
} from './incident-coverage-banner'
import { localCoverageGapText, remoteCoverageText } from './incident-coverage-copy'

export function IncidentCoverageDetail({
  localGaps,
  remoteLine
}: {
  localGaps: readonly IncidentLocalCoverageGap[]
  remoteLine: IncidentRemoteCoverageLine | null
}): React.JSX.Element {
  return (
    <section
      aria-label={translate('auto.components.right.sidebar.incidents.IncidentCoverageDetail.c9a4a6d395',
        'Coverage behind this incident'
      )}
      className="space-y-2"
    >
      <div className="space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentCoverageDetail.669119bbc8',
            'Local coverage'
          )}
        </h3>
        {localGaps.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.incidents.IncidentCoverageDetail.ba035c885b',
              'No local coverage gap: this host recorded what it could observe.'
            )}
          </p>
        ) : (
          <ul className="space-y-1">
            {localGaps.map((gap) => (
              <li
                key={gap.kind}
                className="rounded border border-status-warning-border bg-status-warning-background px-2 py-1 text-[11px] text-foreground"
              >
                {localCoverageGapText(gap)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right.sidebar.incidents.IncidentCoverageDetail.9fe56e3044',
            'Remote view'
          )}
        </h3>
        {remoteLine === null ? (
          <p className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.incidents.IncidentCoverageDetail.bceb8afaf2',
              'This host reports no remote-mirror coverage. Remote incident capture is unsupported by design, so the global view may be incomplete — this host\'s own records are not in doubt.'
            )}
          </p>
        ) : (
          <p className="flex items-start gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground">
            <Radio size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{remoteCoverageText(remoteLine, true)}</span>
          </p>
        )}
      </div>
    </section>
  )
}
