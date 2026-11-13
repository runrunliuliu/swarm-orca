// The filter row (§12, M7-B).
//
// Four dropdowns, one per filter, plus a clear affordance that only appears when something is off the
// default. Each trigger carries its current value in its accessible name (`Status: untriaged`), so a
// screen-reader user knows the state without opening the menu, and the panel's "clear" control has
// something specific to reset.
//
// The menus are presentational: they call `onChange` with the chosen value and let the panel decide
// what that means for the store request (see `incident-filter.ts`). No filtering happens here.

import { ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  type IncidentClassFilter,
  type IncidentFilters,
  type IncidentStatusFilter,
  type IncidentTimeWindowFilter,
  type IncidentWorktreeFilter,
  type IncidentWorktreeOption,
  incidentFiltersActive
} from './incident-filter'
import {
  INCIDENT_CLASSES_FOR_FILTER,
  INCIDENT_STATUSES_FOR_FILTER,
  incidentClassFilterLabel,
  incidentStatusFilterLabel,
  incidentTimeWindowLabel
} from './incident-filter-labels'

function FilterMenu({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="max-w-[9.5rem] justify-between"
          aria-label={`${label}: ${value}`}
        >
          <span className="truncate">
            {label}: {value}
          </span>
          <ChevronDown size={10} className="shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {/* Why the wrapper: the design-system grammar does not allow a scroll class on the content
            primitive, and a long worktree list must still scroll with the shared thin scrollbar. */}
        <div className="max-h-72 overflow-y-auto scrollbar-sleek">
          {options.map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
              <span className={cn(option.value === value && 'font-semibold')}>{option.label}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function IncidentFilterBar({
  filters,
  worktreeOptions,
  onChange,
  onClear
}: {
  filters: IncidentFilters
  worktreeOptions: readonly IncidentWorktreeOption[]
  onChange: (filters: IncidentFilters) => void
  onClear: () => void
}): React.JSX.Element {
  const statusLabel = translate('auto.components.right.sidebar.incidents.IncidentFilterBar.491025e1b3',
    'Status'
  )
  const classLabel = translate('auto.components.right.sidebar.incidents.IncidentFilterBar.d6e5b0dcf0',
    'Class'
  )
  const worktreeLabel = translate('auto.components.right.sidebar.incidents.IncidentFilterBar.c062d1faea',
    'Worktree'
  )
  const windowLabel = translate('auto.components.right.sidebar.incidents.IncidentFilterBar.68570a7b56',
    'Time'
  )
  const anyLabel = translate('auto.components.right.sidebar.incidents.IncidentFilterBar.87c3f00cc2', 'any')

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
      <FilterMenu
        label={statusLabel}
        value={incidentStatusFilterLabel(filters.status)}
        options={[
          { value: 'untriaged', label: incidentStatusFilterLabel('untriaged') },
          { value: 'all', label: incidentStatusFilterLabel('all') },
          ...INCIDENT_STATUSES_FOR_FILTER.filter((status) => status !== 'untriaged').map(
            (status) => ({ value: status, label: incidentStatusFilterLabel(status) })
          )
        ]}
        onChange={(value) => onChange({ ...filters, status: value as IncidentStatusFilter })}
      />
      <FilterMenu
        label={classLabel}
        value={incidentClassFilterLabel(filters.class)}
        options={[
          { value: 'all', label: incidentClassFilterLabel('all') },
          ...INCIDENT_CLASSES_FOR_FILTER.map((value) => ({
            value,
            label: incidentClassFilterLabel(value)
          }))
        ]}
        onChange={(value) => onChange({ ...filters, class: value as IncidentClassFilter })}
      />
      <FilterMenu
        label={worktreeLabel}
        value={filters.worktree === 'all' ? anyLabel : filters.worktree}
        options={[
          { value: 'all', label: anyLabel },
          ...worktreeOptions.map((option) => ({
            value: option.worktreeId,
            label: `${option.worktreeId} (${option.count})`
          }))
        ]}
        onChange={(value) =>
          onChange({ ...filters, worktree: value as IncidentWorktreeFilter })
        }
      />
      <FilterMenu
        label={windowLabel}
        value={incidentTimeWindowLabel(filters.window)}
        options={[
          { value: 'all', label: incidentTimeWindowLabel('all') },
          { value: '24h', label: incidentTimeWindowLabel('24h') },
          { value: '7d', label: incidentTimeWindowLabel('7d') }
        ]}
        onChange={(value) =>
          onChange({ ...filters, window: value as IncidentTimeWindowFilter })
        }
      />
      {incidentFiltersActive(filters) && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onClear}
          aria-label={translate('auto.components.right.sidebar.incidents.IncidentFilterBar.ff92e72a40',
            'Reset filters to the default view'
          )}
        >
          <X size={10} />
          {translate('auto.components.right.sidebar.incidents.IncidentFilterBar.abbbb3aa2e', 'reset')}
        </Button>
      )}
    </div>
  )
}
