// Why its own module (M4): the create sequence, the read-back and the post-failure adjudication all
// refuse with the same typed error, and importing each other to reach it would be a cycle.

/** M0 stable codes owned by the create path (the M2 rules carry their own). */
export type SparseTaskWorkspaceErrorCode =
  | 'sparse_task_capability_required'
  | 'sparse_task_head_mismatch'
  | 'sparse_task_effective_cone_mismatch'

/** Refusals carry a bracketed code in `message` because the create error channel may only carry
 *  text; `code` is the same value for callers that can see the object. */
export class SparseTaskWorkspaceError extends Error {
  readonly code: SparseTaskWorkspaceErrorCode

  constructor(code: SparseTaskWorkspaceErrorCode, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'SparseTaskWorkspaceError'
    this.code = code
  }
}
