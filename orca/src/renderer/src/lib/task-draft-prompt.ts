/**
 * The initial prompt for a task-draft workspace's agent: it carries the dock's
 * instruction and target, and keeps the session to drafting until a later
 * confirmation step exists (design §7.9.7).
 */
export function buildTaskDraftPrompt(args: { instruction: string; targetLabel: string }): string {
  return `You are drafting one tracker task from the user instruction below.

Target: ${args.targetLabel}

Instruction:
${args.instruction}

Turn this instruction into one tracker task: a title, a body, and labels when the target provider has them. Present the draft for review.

This session only drafts. A preview and confirmation step comes later, and the user must approve the draft before anything is written to the tracker. Creating the issue now is out of scope for this session: do not run \`orca linear create\`, \`orca github create-issue\`, \`gh issue create\` or \`gh pr create\`, and do not submit any Jira form.

This workspace is a scratch directory, not a checkout. Do not edit code, do not create a branch or worktree, and write nothing outside the scratch directory.`
}
