import { getWorkspaceIntentName, slugifyForWorkspaceName } from '../../../shared/workspace-name'

export type TaskDraftName = { displayName: string; seedName: string }

/**
 * Derive the sidebar identity of a task draft from the dock's instruction.
 * Reuses `getWorkspaceIntentName` so a draft reads like any other workspace.
 */
export function getTaskDraftName(args: {
  instruction: string
  provider: string
  existingNames: readonly string[]
}): TaskDraftName {
  const fallbackName = `draft-${args.provider}`
  // Why: a CJK-only instruction keeps a CJK display name but slugs to '', so the
  // helper returns null and the fallback must supply the name (design §7.9.9 R11).
  const intent = getWorkspaceIntentName({ sourceText: args.instruction, fallbackName })
  let displayName = getFirstFreeDraftName(intent?.displayName ?? fallbackName, args.existingNames)
  let seedName = slugifyForWorkspaceName(displayName)
  if (!seedName) {
    // Why: keep deduping the ASCII fallback instead of returning an empty seed.
    displayName = getFirstFreeDraftName(fallbackName, args.existingNames)
    seedName = slugifyForWorkspaceName(displayName)
  }
  return { displayName, seedName }
}

function getFirstFreeDraftName(baseName: string, existingNames: readonly string[]): string {
  if (!existingNames.includes(baseName)) {
    return baseName
  }
  let suffix = 1
  while (existingNames.includes(`${baseName}-${suffix}`)) {
    suffix += 1
  }
  return `${baseName}-${suffix}`
}
