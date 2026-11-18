import React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A workbench action that is drawn but not wired in this build (P1b owns the
 * hops: terminal, workspace creation, Settings, reading delivery evidence).
 *
 * README §7.4.2 取舍 3 requires these to render as disabled instead of looking
 * live. Two separate problems that has to solve:
 *
 * - A mouse user: `ui/button.tsx` sets `disabled:pointer-events-none`, so a
 *   `title` on the disabled button itself is never hovered. The wrapper span owns
 *   the pointer, and its `title` is the explanation.
 * - A keyboard or screen-reader user: the disabled button is not a tab stop, so
 *   the reason can never be "focused into". It is therefore also rendered once as
 *   `sr-only` text that the button is `aria-describedby`, which is what assistive
 *   tech announces with the button instead of an unexplained "unavailable".
 *
 * When one of these is wired it should stop using this component: a live action
 * is a plain `Button`, and a disabled one that silently does nothing is the bug
 * this file exists to avoid.
 */

export type TaskWorkbenchPendingActionProps = {
  label: string
  /** Why it does nothing yet, in the reader's language. */
  hint: string
  testId: string
  variant?: 'ghost' | 'outline'
  className?: string
  children?: React.ReactNode
}

export function TaskWorkbenchPendingAction({
  label,
  hint,
  testId,
  variant = 'ghost',
  className,
  children
}: TaskWorkbenchPendingActionProps): React.JSX.Element {
  // Why a generated id: one screen can carry several of these (one per agent row),
  // and a constant id would point every `aria-describedby` at the first hint.
  const hintId = React.useId()
  return (
    <span className={cn('inline-flex shrink-0', className)} title={hint}>
      <Button
        type="button"
        variant={variant}
        size="xs"
        disabled
        aria-disabled="true"
        aria-describedby={hintId}
        data-testid={testId}
      >
        {/* Why the muted tone is on the text, not on the Button: the design-system
            lint forbids restyling <Button>'s own color, and `ghost` alone is the
            section's quiet treatment (docs/STYLEGUIDE.md color roles). */}
        <span className="text-muted-foreground">{label}</span>
        {children}
      </Button>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </span>
  )
}
