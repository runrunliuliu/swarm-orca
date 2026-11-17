import React from 'react'
import { ChevronUp, LoaderCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

export type TaskDockModel = {
  instruction: string
  expanded: boolean
  /** `provider · owner/repo` for the current source and selection; null when nothing is selected. */
  targetLabel: string | null
  submitting: boolean
  errorMessage: string | null
  onInstructionChange: (value: string) => void
  onExpandedChange: (expanded: boolean) => void
  onSubmit: () => void
}

export function TaskDock({ model }: { model: TaskDockModel }): React.JSX.Element {
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const canSubmit =
    model.targetLabel !== null && model.instruction.trim().length > 0 && !model.submitting
  const placeholder = translate(
    'auto.components.TaskPage.taskDockPlaceholder',
    'Describe a task or change…'
  )

  const submit = (): void => {
    if (canSubmit) {
      model.onSubmit()
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      if (!model.expanded) {
        return
      }
      event.preventDefault()
      // Why: this keeps focus in the same textarea, which is now the collapsed line, so
      // returning focus needs no ref, no effect and no second element.
      model.onExpandedChange(false)
      return
    }
    // Why: a multi-line instruction needs ⌘/Ctrl to commit; only the one-line form takes a bare Enter.
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey || !model.expanded)) {
      return
    }
    event.preventDefault()
    submit()
  }

  const expand = (): void => {
    model.onExpandedChange(true)
    inputRef.current?.focus()
  }

  const spinner = <LoaderCircle className="size-3.5 animate-spin" />
  const sendLabel = translate('auto.components.TaskPage.taskDockSend', 'Send')
  const createDraftLabel = translate('auto.components.TaskPage.taskDockCreateDraft', 'Create draft')
  const cancelLabel = translate('auto.components.TaskPage.taskDockCancel', 'Cancel')

  return (
    <div data-testid="task-dock" className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        {/* Why the same child slot in both states: the textarea must not remount on collapse,
            or Esc would drop focus to <body>. */}
        {model.expanded ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="task-dock-expand"
            aria-label={translate('auto.components.TaskPage.taskDockExpand', 'Expand')}
            disabled={model.submitting}
            onClick={expand}
          >
            <ChevronUp className="size-4" />
          </Button>
        )}
        <Textarea
          ref={inputRef}
          data-testid="task-dock-input"
          value={model.instruction}
          rows={model.expanded ? 3 : 1}
          disabled={model.submitting}
          placeholder={placeholder}
          aria-label={placeholder}
          className={model.expanded ? 'min-h-20' : 'min-h-9'}
          onChange={(event) => model.onInstructionChange(event.target.value)}
          onFocus={() => {
            if (!model.expanded) {
              model.onExpandedChange(true)
            }
          }}
          onKeyDown={handleKeyDown}
        />
        {model.expanded ? null : (
          <Button
            type="button"
            data-testid="task-dock-submit"
            size="sm"
            aria-label={sendLabel}
            disabled={!canSubmit}
            onClick={submit}
          >
            {model.submitting ? spinner : sendLabel}
          </Button>
        )}
      </div>
      {model.expanded ? (
        <div className="flex items-center gap-2">
          {model.targetLabel === null ? null : (
            <Badge
              variant="outline"
              data-testid="task-dock-chip"
              aria-label={`${translate('auto.components.TaskPage.taskDockTarget', 'Target')}: ${model.targetLabel}`}
            >
              {model.targetLabel}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {translate(
              'auto.components.TaskPage.taskDockSubmitHint',
              '⌘⏎ to send, Esc to collapse'
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="task-dock-cancel"
              aria-label={translate(
                'auto.components.TaskPage.taskDockCancelHint',
                'Cancel and collapse (Esc)'
              )}
              disabled={model.submitting}
              onClick={() => model.onExpandedChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="task-dock-submit"
              aria-label={createDraftLabel}
              disabled={!canSubmit}
              onClick={submit}
            >
              {model.submitting ? spinner : createDraftLabel}
            </Button>
          </div>
        </div>
      ) : null}
      {/* Why expanded-only: §7.9.2 fixes the collapsed state as one persistent line. */}
      {model.expanded && model.targetLabel === null ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.TaskPage.taskDockNoTarget',
            'Pick a source and a repository first.'
          )}
        </p>
      ) : null}
      {model.errorMessage === null ? null : (
        <p data-testid="task-dock-error" role="alert" className="text-xs text-destructive">
          {translate(
            'auto.components.TaskPage.taskDockCreateFailed',
            'Could not create the draft.'
          )}{' '}
          {model.errorMessage}
        </p>
      )}
    </div>
  )
}
