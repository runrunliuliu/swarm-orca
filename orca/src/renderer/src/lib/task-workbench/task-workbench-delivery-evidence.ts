import type { DeliveryEvidence } from '@/components/task-workbench/task-workbench-view'

/**
 * The delivery evidence the renderer can actually read (README §7.12 S3).
 *
 * Why this is its own module: the only delivery source this build has is the
 * workspace's own `review` (a PR number and state). Nothing here runs git, `gh`
 * or a PR query, so commits / checks / review verdicts stay absent — the type
 * marks them optional, and an absent field must never become a `0` or an empty
 * string (README §7.5).
 *
 * Why not make it up from the default workspace alone: `joinTaskWorkbench` picks
 * the default workspace's evidence, and a per-workspace fact must stay
 * per-workspace — adding two workspaces' reviews would name a PR that does not
 * belong to either row.
 */

/** The slice of a workspace this selector reads. Declared structurally so the
 *  module stays pure and unit-testable without the store's snapshot type. */
export type ReviewedWorkspace = {
  worktreeId: string
  review?: { number: number; state: 'draft' | 'open' | 'merged' | 'closed' }
}

/** One entry per workspace that has a review; a workspace without one is absent
 *  rather than present-and-empty, so the join reports "not read". */
export function deliveryEvidenceByWorktree(
  workspaces: readonly ReviewedWorkspace[]
): Record<string, DeliveryEvidence> {
  const evidence: Record<string, DeliveryEvidence> = {}
  for (const workspace of workspaces) {
    if (workspace.review) {
      evidence[workspace.worktreeId] = {
        pullRequest: { number: workspace.review.number, state: workspace.review.state }
      }
    }
  }
  return evidence
}
