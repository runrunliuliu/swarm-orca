// `--override-acceptance` on the operator maintenance commands (issue-sedimentation.md §8, M5 C1).
//
// Two commands may settle a dispatch without its worker reporting: `orchestration task-update --status
// completed` and `orchestration gate-create` (both complete the active Dispatch). They are external
// authority, so they may bypass a declared acceptance rule — but only as an explicit, named act.
//
// Without the flag this module returns undefined and the dispatches stay unsettled; the CLI prints the
// skipped ids so "nothing happened" is never silent. With it, the runtime writes an
// `acceptance_overridden` incident plus the stop's override state before the settlement commits.

import { getRequiredStringFlag } from '../../flags'

export type CliAcceptanceOverride = { actor: string; reason: string }

const OVERRIDE_FLAG = 'override-acceptance'

export function acceptanceOverrideFromFlags(
  flags: Map<string, string | boolean>
): CliAcceptanceOverride | undefined {
  if (flags.get(OVERRIDE_FLAG) !== true) {
    return undefined
  }
  return {
    actor: getRequiredStringFlag(flags, 'actor'),
    reason: getRequiredStringFlag(flags, 'reason')
  }
}
