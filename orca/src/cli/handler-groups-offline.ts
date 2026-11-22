import type { HandlerGroup } from './handler-group-manifest'

/**
 * The commands that write *this machine's* profile-state database while Orca is
 * stopped: `profile state …` and `history backfill`.
 *
 * Why a sibling module: `handler-group-manifest.ts` sits at its `max-lines` budget, and
 * these two groups share the property the manifest cannot state — they are offline
 * writers for the local profile, not runtime callers. Split exactly like
 * `browser-handler-groups.ts`; the manifest still owns ordering, the duplicate-key
 * check and the eager key lists, so a group cannot become unreachable by moving here.
 */
export const OFFLINE_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'profile-state',
    keys: ['profile state exports', 'profile state rollback'],
    load: async () => (await import('./handlers/profile-state.js')).PROFILE_STATE_HANDLERS
  },
  {
    name: 'history',
    keys: ['history backfill'],
    load: async () => (await import('./handlers/history.js')).HISTORY_HANDLERS
  }
]
