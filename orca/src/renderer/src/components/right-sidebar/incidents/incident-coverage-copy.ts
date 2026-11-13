// Copy for the graded coverage facts (§11.5, §12; M7-B).
//
// One module so the banner and the drawer word the same fact the same way — and so the grading rule is
// stated in prose, not only in tone: local holes call the local count a lower bound, remote holes say
// the *global* picture is incomplete while this host's own records are intact.

import { translate } from '@/i18n/i18n'
import type { IncidentLocalCoverageGap, IncidentRemoteCoverageLine } from './incident-coverage-banner'

export function localCoverageGapText(gap: IncidentLocalCoverageGap): string {
  switch (gap.kind) {
    case 'currently_limited':
      return translate('auto.components.right.sidebar.incidents.incident.coverage.copy.e8bdad331c',
        'The incident store is refusing writes right now, so new incidents on this host are not being recorded.'
      )
    case 'replay_incomplete':
      return gap.dropped > 0
        ? translate('auto.components.right.sidebar.incidents.incident.coverage.copy.f2559c14e2',
            'Shadow replay has not finished and dropped {{dropped}} hint line(s): those incidents will never appear.',
            { dropped: gap.dropped }
          )
        : translate('auto.components.right.sidebar.incidents.incident.coverage.copy.17b2083e87',
            'Shadow replay has not reached the end, so hinted incidents may still be missing.'
          )
    case 'capacity_latch':
      return translate('auto.components.right.sidebar.incidents.incident.coverage.copy.4097322546',
        'This store hit its capacity limit at some point (history, not a current fault): a past write may have been dropped.'
      )
    case 'scan_truncated':
      return translate('auto.components.right.sidebar.incidents.incident.coverage.copy.1422b679c2',
        'Showing {{shown}} of {{total}} matching incidents. Worktree and time filters only see the loaded rows.',
        { shown: gap.shown, total: gap.total }
      )
  }
}

/**
 * The remote line. `detail` adds the sentence the banner does not need: what a remote hole does *not*
 * mean.
 */
export function remoteCoverageText(line: IncidentRemoteCoverageLine, detail: boolean): string {
  const base = (() => {
    switch (line.state) {
      case 'not_configured':
        return translate('auto.components.right.sidebar.incidents.incident.coverage.copy.9d0cb4ee63',
          'No remote host is mirrored or monitored from here (not configured).'
        )
      case 'complete':
        // Unreachable with `null` by construction: the grading above only returns `complete` for a
        // monitored mirror that stated a count. The fallback keeps the string well-formed anyway.
        return translate('auto.components.right.sidebar.incidents.incident.coverage.copy.d35e5659d8',
          'Remote mirror is synchronised: {{unsynced}} unsynchronised incident(s), so the global view is complete.',
          { unsynced: line.unsynced ?? 0 }
        )
      case 'gap':
        return line.capture === 'not_probed'
          ? translate('auto.components.right.sidebar.incidents.incident.coverage.copy.7625f1478a',
              'The remote mirror has not been probed yet, so incidents from the peer may be missing.'
            )
          : line.capture === 'mirrored'
            ? line.unsynced === null
              ? translate('auto.components.right.sidebar.incidents.incident.coverage.copy.a2c68208ec',
                  'The remote mirror is behind, but it has not stated how many incidents are still unsynchronised, so incidents from the peer may be missing.'
                )
              : translate('auto.components.right.sidebar.incidents.incident.coverage.copy.38e8b64b7f',
                  'The remote mirror is behind: {{unsynced}} incident(s) are not synchronised yet.',
                  { unsynced: line.unsynced }
                )
            : translate('auto.components.right.sidebar.incidents.incident.coverage.copy.fbb676739b',
                'Remote capture is unsupported on this host, so the peer observation cannot be mirrored.'
              )
    }
  })()
  if (!detail) {
    return base
  }
  return line.gap
    ? `${base} ${translate('auto.components.right.sidebar.incidents.incident.coverage.copy.e0a23d2ea3',
        'This is a gap in the global view, not a fault in this host\'s own records: every untriaged count above is still local fact.'
      )}`
    : `${base} ${translate('auto.components.right.sidebar.incidents.incident.coverage.copy.98c68e442c',
        'Remote capture is unsupported by design: this list only contains incidents this host observed, so SSH/WSL incidents are not shown.'
      )}`
}
