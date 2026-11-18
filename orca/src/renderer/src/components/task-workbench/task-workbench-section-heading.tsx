import React from 'react'
import { cn } from '@/lib/utils'

/**
 * The one section heading. README §7.4.2 fixes the shape: a `12px/600` name, a
 * muted `12px` count right beside it, and — at the right edge — the section's
 * single quiet control (the fold of its own history, or its one action).
 *
 * Why a component instead of three copies: the previous shell had three count
 * formats (`Workspaces · 1 total` / `Agents · 1` / `History · 1`) and a fold that
 * started a new line. One shape here means a section cannot grow a fourth.
 *
 * No copy lives in this file: labels arrive translated, so the CJK rule (no
 * `uppercase`, no `tracking-wide`) is enforced once, at the class names.
 */

export type TaskWorkbenchSectionHeadingProps = {
  label: string
  /** Omit for a section that has no count (the facts strip). */
  count?: string
  /** The section's one control, rendered at the right edge. */
  action?: React.ReactNode
  className?: string
}

export function TaskWorkbenchSectionHeading({
  label,
  count,
  action,
  className
}: TaskWorkbenchSectionHeadingProps): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className="shrink-0 text-[12px] font-semibold text-foreground">{label}</span>
      {count === undefined ? null : (
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{count}</span>
      )}
      {action === undefined ? null : (
        <div className="ml-auto flex min-w-0 items-center gap-1">{action}</div>
      )}
    </div>
  )
}
