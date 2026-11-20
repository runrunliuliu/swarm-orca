import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { parseSwarmMaxWorkers, type NewWorkspaceLaunchMode } from '@/lib/swarm-launch-prompt'

type NewWorkspaceComposerLaunchModeSectionProps = {
  launchMode: NewWorkspaceLaunchMode
  onLaunchModeChange: (next: NewWorkspaceLaunchMode) => void
  /** The field's raw text, not a number: clearing it must stay compatible with an invalid gate. */
  maxWorkers: string
  onMaxWorkersChange: (next: string) => void
  /** Label of the agent the Coordinator would run as; null when none is picked yet. */
  coordinatorAgentLabel: string | null
  /** Short, non-sensitive label of what the run starts from (e.g. `#123`); null when unlinked. */
  taskSourceLabel: string | null
}

const SEGMENT_CLASS =
  'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[5px] text-[12.5px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/**
 * The composer's start-mode choice: one agent (today's behaviour) or a Swarm
 * Coordinator that dispatches its own Workers.
 *
 * Deliberately only two fields — the mode and one concurrency cap. The
 * Coordinator is configured by its prompt plus a private policy file, and it
 * asks for whatever the prompt leaves out, so a form that mirrored its
 * parameters would import a compatibility mapping that does not exist. Nothing
 * here is persisted as a global preference: each workspace states its mode.
 */
export function NewWorkspaceComposerLaunchModeSection({
  launchMode,
  onLaunchModeChange,
  maxWorkers,
  onMaxWorkersChange,
  coordinatorAgentLabel,
  taskSourceLabel
}: NewWorkspaceComposerLaunchModeSectionProps): React.JSX.Element {
  const labelId = React.useId()
  const maxWorkersInputId = React.useId()
  const parsedMaxWorkers = parseSwarmMaxWorkers(maxWorkers)
  const showsMaxWorkersError = maxWorkers.trim().length > 0 && parsedMaxWorkers === null
  const segments: { mode: NewWorkspaceLaunchMode; label: string; glyph: string }[] = [
    {
      mode: 'single',
      glyph: '◇',
      label: translate('auto.components.new.workspace.launch.mode.single', 'Single agent')
    },
    {
      mode: 'swarm',
      glyph: '◈',
      label: translate('auto.components.new.workspace.launch.mode.swarm', 'Swarm Coordinator')
    }
  ]

  return (
    <div className="min-w-0 space-y-1" data-new-workspace-launch-mode={launchMode}>
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {translate('auto.components.new.workspace.launch.mode.label', 'Start with')}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex gap-0.5 rounded-md border border-input bg-input/30 p-0.5"
      >
        {segments.map((segment) => (
          <button
            key={segment.mode}
            type="button"
            aria-pressed={launchMode === segment.mode}
            onClick={() => onLaunchModeChange(segment.mode)}
            className={cn(
              SEGMENT_CLASS,
              launchMode === segment.mode
                ? // Why solid: on a 28px segment a tinted fill reads as a hover state, and this
                  // choice changes what the workspace starts with.
                  'bg-primary font-medium text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <span aria-hidden="true" className="text-[11px] opacity-85">
              {segment.glyph}
            </span>
            {segment.label}
          </button>
        ))}
      </div>
      {launchMode === 'swarm' ? (
        <div className="space-y-2 pt-2.5">
          <div className="flex items-baseline gap-2">
            <label htmlFor={maxWorkersInputId} className="text-xs text-muted-foreground">
              max_workers
            </label>
            <input
              id={maxWorkersInputId}
              value={maxWorkers}
              onChange={(event) => onMaxWorkersChange(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={showsMaxWorkersError}
              aria-label={translate(
                'auto.components.new.workspace.launch.mode.maxWorkers',
                'max_workers'
              )}
              className={cn(
                'h-7 w-16 rounded-md border border-input bg-input/30 px-2 text-right text-[13px] tabular-nums outline-none',
                'focus:border-ring focus:ring-[3px] focus:ring-ring/50',
                showsMaxWorkersError && 'border-destructive'
              )}
            />
            <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.new.workspace.launch.mode.summary',
                'Coordinator = {{value0}} · Workers ≤ {{value1}} · Task source = {{value2}}',
                {
                  value0:
                    coordinatorAgentLabel ??
                    translate('auto.components.new.workspace.launch.mode.noAgent', 'no agent'),
                  value1: parsedMaxWorkers === null ? '—' : String(parsedMaxWorkers),
                  value2:
                    taskSourceLabel ??
                    translate(
                      'auto.components.new.workspace.launch.mode.noTaskSource',
                      'not linked'
                    )
                }
              )}
            </span>
          </div>
          {showsMaxWorkersError ? (
            <p className="text-xs text-destructive">
              {translate(
                'auto.components.new.workspace.launch.mode.maxWorkersInvalid',
                'Enter a whole number from 1 to 1000.'
              )}
            </p>
          ) : null}
          {coordinatorAgentLabel === null ? (
            <p className="text-xs text-destructive">
              {translate(
                'auto.components.new.workspace.NewWorkspaceComposerLaunchModeSection.13b4ab780a',
                'Pick an agent to run the Coordinator.'
              )}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground/80">
            {translate(
              'auto.components.new.workspace.launch.mode.hint',
              'The Coordinator confirms budget, writable scope and whether merging is allowed before it starts; with no link it asks for the goal first.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
