import { getRepoMainWorktreeId } from '../../../../../../shared/worktree/id'
import { requireWorktreeCreateRoute } from '../../../../../worktree-create-execution-host-route'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  nativeOrchestrationCliCommand,
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand
} from '../../../../orchestration/cli-command'

/** Resolve on the target host before a terminal exists, never from the coordinator's PTY. */
export async function buildWorkerMailboxBootstrap(args: {
  runtime: OrcaRuntimeService
  target: { worktreeId: string } | { repoSelector: string }
  dispatchId: string
  taskId: string
}): Promise<string> {
  const { runtime, target } = args
  let worktreeId: string
  let connectionId: string | null
  if ('repoSelector' in target) {
    const repo = await runtime.showRepo(target.repoSelector)
    const route = requireWorktreeCreateRoute(repo)
    worktreeId = getRepoMainWorktreeId(repo)
    connectionId = route.kind === 'ssh' ? route.connectionId : null
  } else {
    const workspace = await runtime.showTerminalWorkspaceLaunchScope(`id:${target.worktreeId}`)
    worktreeId = workspace.id
    connectionId = workspace.connectionId
  }
  const cli = resolveTerminalOrchestrationCliCommand({
    connectionId,
    worktreeId,
    isWsl: undefined,
    projectRuntime: connectionId ? undefined : runtime.resolveProjectRuntimeForWorktree(worktreeId),
    runtimeCliCommand: runtimeOrchestrationCliCommand(),
    nativeCliCommand: nativeOrchestrationCliCommand
  })
  return [
    'You are a newly launched Orca Worker. Your complete task is in your durable Dispatch inbox.',
    `Expected Task: ${args.taskId}; expected Dispatch: ${args.dispatchId}.`,
    'Before doing any task work, use your shell tool to run this exact command:',
    `${cli} orchestration check --wait --timeout-ms 1000 --json`,
    'Keep the injected ORCA_TERMINAL_HANDLE and ORCA_PANE_KEY unchanged. Do not use --run,',
    '--terminal, run-use, another profile, or another CLI: check must address your own inbox.',
    'If a successful check returns no messages, repeat it; binding and setup may still be pending.',
    'Only during initial registration, stable_pane_required may be retried with the same identity',
    'after one second, at most 20 times. Stop on other errors, cancellation or connection loss;',
    'do not change permissions, identity or transport to bypass an error.',
    'Find the dispatch message whose payload taskId and dispatchId match the expected IDs.',
    'Read its entire body as your task instructions. Require a deliveryId for this message.',
    'Before executing those instructions, acknowledge the returned deliveryId with:',
    `${cli} orchestration check --ack <deliveryId> --json`,
    'Process any additional messages returned by that acknowledgment too. A replay of the same',
    'message/delivery is not a new task: never execute it twice. Do not acknowledge unread mail.',
    'Then execute the STARTUP CHECK command in the task body, followed by the task itself.',
    'Do not send a startup callback before reading and acknowledging the complete task.'
  ].join('\n')
}
