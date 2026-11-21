import type { TaskWorkbenchWallClock } from './task-workbench-view'

/**
 * The two formatters the History strip prints a clock with, in one place because
 * two components (the facts line and every run row) read them and a second copy
 * would drift into two formats on one screen.
 */

/** Wall-clock copy is unit-only, so it stays untranslated: `3h 14m` reads the
 *  same in every locale this build ships. The *source* of the number is the part
 *  a reader must not misread, and that is what the parenthetical says. */
export function formatWallClock(wall: TaskWorkbenchWallClock): string {
  if (wall.kind === 'unknown' || wall.startedAt === undefined || wall.endedAt === undefined) {
    return ''
  }
  const minutes = Math.max(0, Math.round((wall.endedAt - wall.startedAt) / 60_000))
  if (minutes < 1) {
    return '<1m'
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ''}` : `${rest}m`
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
