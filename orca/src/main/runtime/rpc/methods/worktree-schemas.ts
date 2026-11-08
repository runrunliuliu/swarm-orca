import { z } from 'zod'
import { requiredString } from '../../../../shared/rpc-contract/rpc-param-primitives'

/** M4: which repo's task-create journal to inspect, and how many attempts to look at. */
export const WorktreeCreateStatusParams = z.object({
  repo: requiredString('Missing repo selector'),
  limit: z.number().int().positive().max(50).optional()
})

export {
  AutomationWorkspaceProvenanceRequest,
  CliWorkspaceProvenanceRequest,
  OptionalTuiAgent,
  WorktreeActivate,
  WorktreeDetectedListParams,
  WorktreeForceDeleteBranch,
  WorktreeListParams,
  WorktreePsParams,
  WorktreeRemove,
  WorktreeResolveMrBase,
  WorktreeResolvePrBase,
  WorktreeSelector,
  WorktreeSet,
  WorktreeSortOrder,
  WorktreeTeardownMissingTerminalsParams,
  assertLinkedWorkItemSourceContextMatch
} from '../../../../shared/rpc-contract/worktree-params'
