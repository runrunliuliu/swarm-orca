/**
 * The in-band marker that says "this workspace already has a worktree-delivery
 * session" (README §7.11.3 rule 4, task source D2).
 *
 * Why an existing field and not a new one: `launchAgentInNewTab` already accepts
 * `quickCommandLabel`, a tab persists it, and
 * `shared/agent-row-conversation-name.ts` already resolves it into the row name.
 * So the fact "a delivery session exists" is readable from the workbench's own
 * agent rows (`DashboardCard.conversationName`) without new persistence, a new
 * RPC or a new store field. This module exists so the one literal and the one
 * matching rule are written down once: the launcher writes the label, the state
 * projection reads it, and neither keeps its own copy.
 *
 * Why exact, trimmed, case-sensitive equality: a user may legitimately rename a
 * tab, which is the D2 reopen condition — a renamed session stops being counted
 * as the delivery session rather than being guessed back. A fuzzy match would
 * turn any row whose name merely contains the word into a false positive, and a
 * false positive makes the entry say "open terminal" for a session it never
 * started.
 *
 * Pure by construction: no React, store, RPC or `git` import. The state
 * projection and the launch lib both import it, and the workbench's import
 * boundary test must stay green.
 */

/** The label written as the launching tab's `quickCommandLabel`. ASCII on
 *  purpose: it is a marker read back by code, not localized interface copy. */
export const TASK_WORKBENCH_DELIVER_SESSION_LABEL = 'DELIVER'

/** Whether a row/tab name is the delivery marker and nothing else. */
export function isTaskWorkbenchDeliverSessionName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim() === TASK_WORKBENCH_DELIVER_SESSION_LABEL
}
