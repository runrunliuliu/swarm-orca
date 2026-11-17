import React from 'react'
import { ChevronUp, LoaderCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

export type TaskDockModelOption = { id: string; label: string }

/** One rendered line of the draft agent's conversation, as the dock shows it. */
export type TaskDockTranscriptLine = { text: string; tone?: 'agent' | 'user' | 'meta' }

/** `none`: no draft session yet, so there is nothing to show. */
export type TaskDockTranscriptStatus = 'none' | 'live' | 'ended'

export type TaskDockModel = {
  instruction: string
  expanded: boolean
  /** `provider · owner/repo` for the current source and selection; null when nothing is selected. */
  targetLabel: string | null
  /** The model id sent as the agent's `--model`; empty means the agent's configured default. */
  model: string
  modelOptions: readonly TaskDockModelOption[]
  /** Tail of the draft agent's terminal, newest last; empty until a session exists. */
  transcript: readonly TaskDockTranscriptLine[]
  transcriptStatus: TaskDockTranscriptStatus
  submitting: boolean
  errorMessage: string | null
  onInstructionChange: (value: string) => void
  onModelChange: (value: string) => void
  onExpandedChange: (expanded: boolean) => void
  onSubmit: () => void
}

/**
 * The Tasks list page's agent input: one instruction, one model, one send. Everything after the
 * send happens in the draft's agent session — the dock does not call a tracker itself.
 */
export function TaskDock({ model }: { model: TaskDockModel }): React.JSX.Element {
  const canSend = model.instruction.trim().length > 0 && !model.submitting
  const submit = (): void => {
    if (canSend) {
      model.onSubmit()
    }
  }
  return (
    <div className="shrink-0 border-t" data-testid="task-dock">
      {model.expanded ? (
        <div className="space-y-2 p-3">
          {model.transcript.length > 0 ? (
            <div
              data-testid="task-dock-transcript"
              data-transcript-status={model.transcriptStatus}
              aria-live="polite"
              className="max-h-40 min-h-0 overflow-y-auto scrollbar-sleek whitespace-pre-wrap rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed"
            >
              {model.transcript.map((line, index) => (
                <div
                  // Why index keys: the transcript is an append-only slice of a terminal tail;
                  // the same text can repeat, so text is not a key and order is the identity.
                  key={index}
                  data-transcript-tone={line.tone ?? 'agent'}
                >
                  {line.text}
                </div>
              ))}
            </div>
          ) : null}
          <Textarea
            autoFocus
            value={model.instruction}
            onChange={(event) => model.onInstructionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                model.onExpandedChange(false)
              }
            }}
            placeholder={translate(
              'auto.components.TaskPage.taskDockPlaceholder',
              'Describe a task or change…'
            )}
            data-testid="task-dock-input"
            rows={3}
          />
          {model.errorMessage ? (
            <p className="text-sm text-destructive" data-testid="task-dock-error">
              {model.errorMessage}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              {model.targetLabel ? (
                <Badge variant="secondary" className="max-w-[40%] min-w-0">
                  <span className="truncate">{model.targetLabel}</span>
                </Badge>
              ) : null}
              {model.modelOptions.length > 0 ? (
                <select
                  aria-label={translate('auto.components.TaskPage.taskDockModel', 'Model')}
                  className="h-7 max-w-[40%] rounded-md border bg-transparent px-2 text-xs"
                  value={model.model}
                  onChange={(event) => model.onModelChange(event.target.value)}
                  data-testid="task-dock-model"
                >
                  <option value="">
                    {translate('auto.components.TaskPage.taskDockModelDefault', 'Agent default')}
                  </option>
                  {model.modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={translate('auto.components.TaskPage.taskDockModel', 'Model')}
                  className="h-7 w-40 rounded-md border bg-transparent px-2 text-xs"
                  value={model.model}
                  placeholder={translate(
                    'auto.components.TaskPage.taskDockModelPlaceholder',
                    'Model (agent default)'
                  )}
                  onChange={(event) => model.onModelChange(event.target.value)}
                  data-testid="task-dock-model"
                />
              )}
              <span className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPage.taskDockSubmitHint',
                  '⌘↵ to send, Esc to close'
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => model.onExpandedChange(false)}
              >
                {translate('auto.components.TaskPage.taskDockCancel', 'Close')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canSend}
                onClick={submit}
                data-testid="task-dock-send"
              >
                {model.submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {translate('auto.components.TaskPage.taskDockSend', 'Send')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={translate('auto.components.TaskPage.taskDockExpand', 'Open the input')}
            onClick={() => model.onExpandedChange(true)}
          >
            <ChevronUp className="size-4" />
          </Button>
          <button
            type="button"
            className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-left text-xs text-muted-foreground"
            onClick={() => model.onExpandedChange(true)}
            data-testid="task-dock-collapsed"
          >
            {translate('auto.components.TaskPage.taskDockPlaceholder', 'Describe a task or change…')}
          </button>
        </div>
      )}
    </div>
  )
}
