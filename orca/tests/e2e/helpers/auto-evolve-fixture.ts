import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { visibleCommand } from './worktree-create-cli'
import { shellQuote } from './shell-quote'

/** Source-tree location of the skill's only execution entry. */
export const SKILL_RPC_PATH = path.resolve(
  process.cwd(),
  '..',
  'swarm',
  'skills',
  'auto-evolve',
  'scripts',
  'rpc.py'
)

export type AutoEvolveCreateParams = {
  repo: string
  name: string
  baseBranch: string
  linkedIssue: number
  linkedWorkItem: {
    provider: 'github'
    type: 'issue'
    number: number
    title: string
    url: string
    repoId: string
  }
  linkedTaskSourceContext: {
    kind: 'task-source'
    provider: 'github'
    projectId: string
    hostId: 'local'
    repoId: string
    providerIdentity: { provider: 'github'; host: string; owner: string; repo: string }
  }
  noParent: true
  setupDecision: 'skip'
  activate: false
  startupAgent: string
  startupPrompt: string
  clientMutationId: string
}

/**
 * The fixed create request SKILL.md describes: pinned base SHA, the issue identity kept in both
 * fields the runtime checks, and the agent plus prompt as the only delivery. Fixture values stay
 * obviously synthetic; no tracker request is made.
 */
export function buildAutoEvolveCreateParams(args: {
  repoId: string
  baseSha: string
  name: string
  clientMutationId: string
  startupAgent: string
  startupPrompt: string
  issue?: number
}): AutoEvolveCreateParams {
  const issue = args.issue ?? 77
  const host = 'github.com'
  const owner = 'example'
  const repo = 'project'
  return {
    repo: `id:${args.repoId}`,
    name: args.name,
    baseBranch: args.baseSha,
    linkedIssue: issue,
    linkedWorkItem: {
      provider: 'github',
      type: 'issue',
      number: issue,
      title: `Issue ${String(issue)} E2E`,
      url: `https://${host}/${owner}/${repo}/issues/${String(issue)}`,
      repoId: args.repoId
    },
    linkedTaskSourceContext: {
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-e2e',
      hostId: 'local',
      repoId: args.repoId,
      providerIdentity: { provider: 'github', host, owner, repo }
    },
    noParent: true,
    setupDecision: 'skip',
    activate: false,
    startupAgent: args.startupAgent,
    startupPrompt: args.startupPrompt,
    clientMutationId: args.clientMutationId
  }
}

export function writeAutoEvolveCreateParams(file: string, params: AutoEvolveCreateParams): string {
  writeFileSync(file, `${JSON.stringify(params, null, 2)}\n`)
  return file
}

/** The skill's only execution entry, run exactly as its operator would. */
export function autoEvolveCommand(args: {
  metadataPath: string
  runtimeId: string
  paramsPath: string
  stateDir: string
  outputPath: string
}): string {
  return visibleCommand({
    command: [
      'echo AUTO_EVOLVE_SKILL_EXECUTE',
      `; python3 ${shellQuote(SKILL_RPC_PATH)}`,
      '--metadata',
      shellQuote(args.metadataPath),
      '--runtime-id',
      shellQuote(args.runtimeId),
      '--method',
      'worktree.create',
      '--params-file',
      shellQuote(args.paramsPath),
      '--execute',
      '--state-dir',
      shellQuote(args.stateDir),
      '--timeout',
      '180'
    ].join(' '),
    outputPath: args.outputPath,
    grepPattern: '"ok"|"agentTerminalHandle"|"createdWithAgent"',
    doneMarker: 'AUTO_EVOLVE_END'
  })
}
