// The two read-only fact tables (formerly the "grayscale" tables; M8-2/M8-3).
//
// After the subtraction both tables show FACTS the host recorded — pane event clocks and failed tool
// calls — and neither carries a verdict, a threshold, a window or a write switch. The dashed treatment
// and the standing sentence say one thing that is still true: a row here is not an accident record.
//
// Neither table offers an action. Deciding what a row means is a triage question outside Orca.

import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type {
  IncidentPaneClocksViewDto,
  IncidentToolFailuresViewDto
} from '../../../../../shared/incident-gray-types'

function Minutes({ ms }: { ms: number }): React.JSX.Element {
  return <span className="tabular-nums">{Math.round(ms / 60_000)}m</span>
}

function ObservedChrome({
  children,
  label
}: {
  children: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="space-y-2 rounded border border-dashed border-border/70 bg-muted/30 px-2 py-2 text-muted-foreground"
    >
      <p className="flex items-start gap-1.5 rounded border border-dashed border-status-warning-border bg-status-warning-background px-1.5 py-1 text-[11px] text-foreground">
        <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-status-warning" />
        <span>
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.0884d2aab1',
            'These rows are facts stored by the host process, not accident records. A row here does not mean an incident exists.'
          )}
        </span>
      </p>
      {children}
    </section>
  )
}

export function IncidentPaneClocksTable({
  view
}: {
  view: IncidentPaneClocksViewDto
}): React.JSX.Element {
  return (
    <ObservedChrome
      label={translate('auto.components.right.sidebar.incidents.IncidentGrayTables.a67f20e39d',
        'Pane event clocks (facts)'
      )}
    >
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.529c988940',
          'One stored fact row per pane: state, the age of its last semantic event, and which clock the age came from. There is no threshold and no verdict here — whether this is stuck is a triage question.'
        )}
      </p>
      {view.rows.length === 0 ? (
        <p className="text-[11px]">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.3cc4f4fee3',
            'No pane has been sampled yet. The sampler records one fact row per minute while the runtime is up.'
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {view.rows.map((row) => (
            <li
              key={row.paneKey}
              data-incident-gray-row="observed"
              className="rounded border border-dashed border-border/70 px-2 py-1 text-[10px] text-muted-foreground"
            >
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="truncate font-mono text-foreground">{row.paneKey}</span>
                <span>{row.state}</span>
                <span>
                  {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.983f1f4ffd',
                    'age'
                  )}{' '}
                  <Minutes ms={row.ageMs} />
                </span>
                <span
                  className={row.ageBasis === 'state_fallback' ? 'text-status-warning' : undefined}
                  title={
                    row.ageBasis === 'state_fallback'
                      ? translate('auto.components.right.sidebar.incidents.IncidentGrayTables.803a17a05a',
                          'No semantic event clock for this pane, so age falls back to stateStartedAt: a weaker signal.'
                        )
                      : undefined
                  }
                >
                  {row.ageBasis}
                </span>
                <span className="truncate">
                  {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.9d0a503877',
                    'observed'
                  )}{' '}
                  {new Date(row.observedAt).toISOString()}
                </span>
              </div>
              {row.declaredWait !== null && (
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="truncate text-foreground" title={row.declaredWait}>
                    {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.f3ec97f59d',
                      'declared wait'
                    )}
                    : {row.declaredWait}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </ObservedChrome>
  )
}

export function IncidentToolFailuresTable({
  view
}: {
  view: IncidentToolFailuresViewDto
}): React.JSX.Element {
  const iso = (ms: number): string => new Date(ms).toISOString()
  return (
    <ObservedChrome
      label={translate('auto.components.right.sidebar.incidents.IncidentGrayTables.05dd715ac5',
        'Recorded tool failures (facts)'
      )}
    >
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.3ffb9723e7',
          'One row per failed tool call: session, turn, tool and the provider-stamped errorKind/exit code. No normalization, no window and no severity — those are triage questions now.'
        )}
      </p>
      {view.truncated && (
        <p className="text-[10px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.2c3641754f',
            'Showing {{shown}} of {{total}} rows: the read is capped, the rest are counted but not listed.',
            { shown: view.rows.length, total: view.total }
          )}
        </p>
      )}
      {view.dropped > 0 && (
        <p className="text-[10px] text-status-warning">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.00a3a930ba',
            '{{dropped}} failed call(s) were dropped by the store cap or an insert failure; the row count is a floor.',
            { dropped: view.dropped }
          )}
        </p>
      )}
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.847e479adb',
          'Covered providers: {{list}}',
          { list: view.coveredProviders.join(', ') || '—' }
        )}
      </p>
      <p className="text-[10px]">
        {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.4f8b2f1488',
          'Coverage gap: no tool-failure data from {{list}}. Silence from them is not "no tool failures".',
          { list: view.uncoveredProviders.join(', ') || '—' }
        )}
      </p>
      {view.rows.length === 0 ? (
        <p className="text-[11px]">
          {translate('auto.components.right.sidebar.incidents.IncidentGrayTables.8f749047f1',
            'No failed tool call has been recorded on this host in this window.'
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {view.rows.map((row) => (
            <li
              key={`${row.sessionId}:${row.itemKey}:${row.ordinal}`}
              data-incident-gray-row="observed"
              className="rounded border border-dashed border-border/70 px-2 py-1 text-[10px] text-muted-foreground"
            >
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="truncate font-mono text-foreground">
                  {row.sessionId.slice(0, 8)}
                </span>
                <span>{row.toolName}</span>
                <span className="font-mono">{row.errorKind ?? '—'}</span>
                <span className="tabular-nums">exit {row.exitCode === null ? '—' : row.exitCode}</span>
                <span className="truncate">{iso(row.observedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ObservedChrome>
  )
}
