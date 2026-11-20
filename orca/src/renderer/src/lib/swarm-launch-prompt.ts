/**
 * The new-workspace composer's launch mode: today's single agent, or a Swarm
 * Coordinator that dispatches Workers itself.
 *
 * This module owns the only two things that mode changes — the first prompt and
 * whether it is submitted — plus the `max_workers` field's parse rule. It
 * deliberately carries no model list, profile file, host or runtime id: the
 * Coordinator's own policy is asked for in conversation, never encoded here.
 */
export type NewWorkspaceLaunchMode = 'single' | 'swarm'

/**
 * What the composer's launch-mode section hands to submit. `maxWorkers` is the
 * parsed field, so a blank or invalid entry arrives as null and the swarm branch
 * is skipped rather than guessed at.
 */
export type NewWorkspaceLaunchSelection = {
  mode: NewWorkspaceLaunchMode
  maxWorkers: number | null
}

/** Form default, not a repository policy: the user still sees and can edit it. */
export const DEFAULT_SWARM_MAX_WORKERS = 4

/** Upper bound on the form field; a larger cap is a typo, not a real Run budget. */
export const MAX_SWARM_MAX_WORKERS = 1000

/**
 * Parse the `max_workers` field. Only a positive integer is a usable cap on one
 * Run's concurrency: blank, zero, negative, decimal, over-limit and non-numeric
 * input all return null, so the composer disables submit instead of sending a
 * value the Coordinator would have to reinterpret.
 */
export function parseSwarmMaxWorkers(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_SWARM_MAX_WORKERS
    ? parsed
    : null
}

/**
 * Whether the start mode keeps the primary button disabled. A swarm start needs
 * a selected agent to run the Coordinator and a real cap; every other
 * combination leaves the existing create gates alone, so this can only ever
 * *add* a reason to block.
 */
export function launchModeBlocksCreate(
  launchMode: NewWorkspaceLaunchMode,
  rawMaxWorkers: string,
  agentSelected: boolean
): boolean {
  return launchMode === 'swarm' && (!agentSelected || parseSwarmMaxWorkers(rawMaxWorkers) === null)
}

/**
 * The single repository-relative path the template cites. Renaming the skill
 * must update this constant — the template intentionally does not copy the
 * skill's contents, so there is nothing else to keep in sync.
 */
export const SWARM_COORDINATOR_SKILL_PATH = 'swarm/skills/swarm-orchestration/SKILL.md'

export type SwarmLaunchPromptArgs = {
  /** The linked work item's URL. Absent when the user linked nothing. */
  issueUrl?: string | null
  /** Absolute path of the workspace's repository, from the composer's own selection. */
  repoPath?: string | null
  /** Branch the worktree starts from; absent means the project default. */
  baseRef?: string | null
  maxWorkers: number
  /** Free-form note; appended after the template, never instead of it. */
  note?: string
}

/**
 * Build the first prompt for a Swarm Coordinator launch.
 *
 * Two properties are load-bearing, both from the M1 design:
 * - the URL is an *intent*, not a task source: `swarm/start_grant.py` wants an
 *   absolute path plus a SHA, so the Coordinator must
 *   write the issue body and this authorization to a file first and report it;
 * - `max_workers` counts every agent the Run uses (review, integration, nested,
 *   discussion), so the prompt says so — otherwise the number is read as
 *   "workers that write code" and gets bypassed.
 */
export function buildSwarmLaunchPrompt(args: SwarmLaunchPromptArgs): string {
  const target = args.issueUrl?.trim()
    ? `目标：${args.issueUrl.trim()}`
    : '目标：见下（未提供链接，开工前先问我目标，不要猜）'
  const location = args.repoPath?.trim()
    ? `；仓库 ${args.repoPath.trim()}${args.baseRef?.trim() ? `，基线 ${args.baseRef.trim()}` : ''}。`
    : '。'
  const lines = [
    `以 Swarm Coordinator 模式开始工作；先完整读取 ${SWARM_COORDINATOR_SKILL_PATH} 再动手。`,
    `${target}${location}`,
    `max_workers=${args.maxWorkers}；含审查、集成、嵌套与讨论用 agent，不另开 Run 绕过该上限。`,
    '开工前先把任务源落盘为一个文件（issue 正文 + 本次授权），把路径与 SHA 报给我，并以它作为任务源。',
    '缺预算、可写根、是否允许合并或部署时先问我，不要用默认值。'
  ]
  const note = args.note?.trim()
  if (note) {
    lines.push('', note)
  }
  return lines.join('\n')
}

/** Everything the quick-create path needs to know about the first prompt. */
export type QuickCreateLaunchPromptPlan = {
  /** Text that may travel on the launch command, i.e. an argv/flag prompt. */
  commandPrompt: string
  /** Draft text for the argv-prefill launch plan; null when the prompt is not a draft. */
  draftPrompt: string | null
  /** Prompt the agent starts clean with and the renderer pastes once it is ready. */
  pasteAfterReadyPrompt: string | null
  /** Whatever the agent ends up receiving — what a structured route delivers. */
  deliveredPrompt: string
  promptDelivery: 'draft' | 'auto-submit' | 'submit-after-ready'
}

/**
 * Decide the first prompt and its delivery for a quick create.
 *
 * The single-agent branch returns its inputs untouched: same text, same
 * `draft`/`auto-submit` decision as before the launch mode existed. The swarm
 * branch is only taken when the user asked for it *and* the cap parsed, so an
 * invalid field can never quietly start a Coordinator with a guessed value.
 */
export function planQuickCreateLaunchPrompt(args: {
  selection: NewWorkspaceLaunchSelection
  agentSelected: boolean
  singleAgentPrompt: string
  singleAgentDraftPrompt: string | null
  linkedWorkItemUrl: string | null
  repoPath: string
  baseRef: string | null
  note: string
}): QuickCreateLaunchPromptPlan {
  const { selection } = args
  const swarmPrompt =
    selection.mode === 'swarm' && args.agentSelected && selection.maxWorkers !== null
      ? buildSwarmLaunchPrompt({
          issueUrl: args.linkedWorkItemUrl,
          repoPath: args.repoPath,
          baseRef: args.baseRef,
          maxWorkers: selection.maxWorkers,
          note: args.note
        })
      : null
  if (swarmPrompt) {
    return {
      commandPrompt: '',
      draftPrompt: null,
      pasteAfterReadyPrompt: swarmPrompt,
      deliveredPrompt: swarmPrompt,
      promptDelivery: 'submit-after-ready'
    }
  }
  return {
    commandPrompt: args.singleAgentPrompt,
    draftPrompt: args.singleAgentDraftPrompt,
    pasteAfterReadyPrompt: null,
    deliveredPrompt: args.singleAgentDraftPrompt ?? args.singleAgentPrompt,
    promptDelivery: args.singleAgentDraftPrompt ? 'draft' : 'auto-submit'
  }
}
