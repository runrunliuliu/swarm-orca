import React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A workbench action that is drawn but not wired in this build (P1b owns the
 * hops: terminal, workspace creation, Settings, reading delivery evidence).
 *
 * README §7.4.2 取舍 3 requires these to render as disabled instead of looking
 * live. Why the explanation lives on a wrapper and not on the button:
 * `ui/button.tsx` sets `disabled:pointer-events-none`, so a `title` on the
 * disabled button itself is never hovered, and a disabled button is not a
 * tab stop either. The wrapper owns the pointer, so a mouse user can still read
 * why; the button keeps `disabled` so nothing can fire it.
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
  return (
    <span className={cn('inline-flex shrink-0', className)} title={hint}>
      <Button
        type="button"
        variant={variant}
        size="xs"
        disabled
        aria-disabled="true"
        data-testid={testId}
        className="text-muted-foreground"
      >
        {label}
        {children}
      </Button>
    </span>
  )
}
