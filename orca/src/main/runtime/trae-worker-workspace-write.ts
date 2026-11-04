import { realpath, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { WorkerWritableRoots } from '../../shared/worker-writable-roots'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

function refuse(message: string): never {
  throw new OrchestrationError('invalid_argument', message)
}

function contains(parent: string, child: string): boolean {
  const relative = posix.relative(parent, child)
  return relative === '' || (!relative.startsWith('../') && relative !== '..')
}

export function assertTraeWorkerWorkspaceWriteOptions(
  opts: TerminalCreateOptions,
  workspacePath: string
): void {
  const constraint = opts.traeWorkspaceWrite
  if (!constraint) {
    return
  }
  if (
    opts.startupAgent !== 'trae' ||
    opts.launchSource !== 'orchestration' ||
    opts.requireFreshPane !== true ||
    opts.cwd !== undefined ||
    opts.shellOverride ||
    opts.envToDelete ||
    opts.tabId ||
    opts.leafId ||
    opts.sessionId ||
    opts.agentArgs !== constraint.agentArgs ||
    workspacePath !== constraint.receipt.workspaceRoot
  ) {
    refuse(
      'Worker writable roots require an unchanged fresh Trae launch in the validated workspace.'
    )
  }
}

export async function prepareTraeWorkerWorkspaceWrite(args: {
  platform: NodeJS.Platform
  executionHostId: string
  connectionId: string | null
  commandOverride?: string
  workspacePath: string
  homePath: string
  writableRoots: string[]
}) {
  if (
    !['linux', 'darwin'].includes(args.platform) ||
    args.executionHostId !== 'local' ||
    args.connectionId
  ) {
    refuse(
      'Worker writable roots currently require a local POSIX execution host; SSH, WSL and federation are unsupported.'
    )
  }
  // Embedded flags or shell wrappers can silently reconnect to a differently scoped session.
  if (
    args.commandOverride &&
    !/^(?:(?:\/[A-Za-z0-9_.-]+)*\/)?(?:traex-tui|traecli)$/.test(args.commandOverride)
  ) {
    refuse(
      'Worker writable roots require the default Trae launcher or a plain absolute traecli/traex-tui executable, without embedded arguments.'
    )
  }
  const roots = WorkerWritableRoots.parse(args.writableRoots)
  const workspaceRoot = await realpath(args.workspacePath)
  if (workspaceRoot !== args.workspacePath || !(await stat(workspaceRoot)).isDirectory()) {
    refuse('Worker workspace must use its existing canonical directory path.')
  }
  const homeRoot = await realpath(args.homePath)
  if (contains(workspaceRoot, homeRoot)) {
    refuse('Worker workspace must not be the filesystem root, home, or a home ancestor.')
  }
  for (const root of roots) {
    if (!posix.isAbsolute(root) || posix.normalize(root) !== root) {
      refuse('Worker writable roots must be absolute canonical directory paths.')
    }
    if (
      root === '/' ||
      contains(root, homeRoot) ||
      (root !== workspaceRoot && contains(root, workspaceRoot))
    ) {
      refuse(
        'Worker writable roots must not grant the filesystem root, home, or workspace ancestors.'
      )
    }
    if ((await realpath(root)) !== root || !(await stat(root)).isDirectory()) {
      refuse('Worker writable roots must name existing canonical directories, not symlink aliases.')
    }
  }
  const writableRoots = [...new Set(roots)]
  const argv = [
    '--no-daemon',
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    '-c',
    'sandbox_workspace_write.network_access=true',
    ...writableRoots.flatMap((root) => ['--add-dir', root])
  ]
  return {
    agentArgs: argv.map((arg) => quoteStartupArg(arg, 'posix')).join(' '),
    receipt: {
      source: 'launch_arguments' as const,
      workspaceRoot,
      writableRoots,
      sandbox: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      networkAccess: true,
      independentSession: true,
      actualSessionVerified: false
    }
  }
}
