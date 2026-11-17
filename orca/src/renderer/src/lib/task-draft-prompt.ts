/**
 * The instruction the dock sends to a draft's agent. The agent owns the work from here: it has
 * Orca's bundled tracker skills, so it creates the ticket itself instead of the app doing it.
 */
export function buildTaskDraftPrompt(args: {
  instruction: string
  targetLabel: string | null
}): string {
  const target = args.targetLabel
    ? `The list page is showing ${args.targetLabel}; use it as the target unless the instruction says otherwise.`
    : 'Use whichever tracker the instruction names.'
  return `${args.instruction}

${target}

You are in a scratch workspace, not a checkout: do not edit code or create a branch.

Carry the instruction out yourself. The tracker skills are available (Linear and GitHub issue creation among them); create the ticket with them when the instruction asks for one, and report the ticket URL when it exists. Ask me rather than guessing when the target is ambiguous.`
}
