import type { HandlerGroup } from './handler-group-manifest'

/**
 * The commands that operate on *this machine's* profile-state database outside the
 * runtime: `profile state …`, `history backfill` (offline writes) and `history task`
 * (a read-only export that also works while the app runs).
 *
 * Why a sibling module: `handler-group-manifest.ts` sits at its `max-lines` budget, and
 * these groups share the property the manifest cannot state — they do not route through
 * the remote runtime. Split exactly like `browser-handler-groups.ts`; the manifest still
 * owns ordering, the duplicate-key check and the eager key lists, so a group cannot
 * become unreachable by moving here.
 */
export const OFFLINE_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'profile-state',
    keys: ['profile state exports', 'profile state rollback'],
    load: async () => (await import('./handlers/profile-state.js')).PROFILE_STATE_HANDLERS
  },
  {
    name: 'history',
    keys: ['history backfill', 'history task'],
    load: async () => (await import('./handlers/history.js')).HISTORY_HANDLERS
  }
]
