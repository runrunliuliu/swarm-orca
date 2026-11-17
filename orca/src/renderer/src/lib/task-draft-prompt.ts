import type { TaskDraftProvider } from '@/lib/task-draft-issue-create'

/**
 * The initial prompt for a task-draft workspace's agent: it carries the dock's
 * instruction and target, the proposal envelope it must write, and keeps the
 * session to drafting until the user confirms (design §7.9.7, contract D1/D8).
 */
export function buildTaskDraftPrompt(args: {
  instruction: string
  targetLabel: string
  draftKey: string
  provider: TaskDraftProvider
  repoId: string | null
  proposalPath: string
}): string {
  const envelope = JSON.stringify({
    version: 1,
    draftKey: args.draftKey,
    provider: args.provider,
    repoId: args.repoId,
    revision: 1,
    proposal: { title: '<title>', body: '<body>', labels: [] }
  })
  return `You are drafting one tracker task from the user instruction below.

Target: ${args.targetLabel}

Instruction:
${args.instruction}

Turn this instruction into one tracker task: a title, a body, and labels when the target provider has them. Present the draft for review.

This session only drafts. A preview and confirmation step comes later, and the user must approve the draft before anything is written to the tracker. Creating the issue now is out of scope for this session: do not run \`orca linear create\`, \`orca github create-issue\`, \`gh issue create\` or \`gh pr create\`, and do not submit any Jira form.

After presenting the draft, write exactly this JSON envelope to ${args.proposalPath} and nothing else, replacing the placeholder title and body with the draft:
${envelope}
Keep \`version\`, \`draftKey\`, \`provider\` and \`repoId\` exactly as written. Increment \`revision\` every time you rewrite the file: the app only accepts a newer revision, so a follow-up that rewrites revision 1 would be ignored. The app reads that file and creates the issue only after the user confirms.

Only if the app later sends \`gh issue create --repo …\` in this session, run that one command and write the printed URL and number to \`task-draft-receipt.json\` in the same directory, with \`"channel": "gh-fallback"\`.

This workspace is a scratch directory, not a checkout. Do not edit code, do not create a branch or worktree, and write nothing outside the scratch directory.`
}
