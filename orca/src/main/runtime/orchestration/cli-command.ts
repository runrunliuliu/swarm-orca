import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { prependOrcaCliDirToChildPath } from '../../cli/orca-cli-child-path'
import { quoteShell } from '../../cli/cli-install-path-format'

/** Shell-ready command prefix, including quoting for an owning runtime's absolute launcher. */
export type OrchestrationCliCommand = string

/** Dev builds run the CLI as `orca-dev`; a packaged app, or a process with no app, must not advertise it. */
export function runtimeOrchestrationCliCommand(): OrchestrationCliCommand | undefined {
  return hasAppEnvironment() && !getAppEnvironment().isPackaged() ? 'orca-dev' : undefined
}

/** What a local, non-WSL terminal is told to run; a structured session is always one. */
export function localOrchestrationCliCommand(): OrchestrationCliCommand {
  return nativeOrchestrationCliCommand() ?? runtimeOrchestrationCliCommand() ?? 'orca'
}

export function nativeOrchestrationCliCommand(): OrchestrationCliCommand | undefined {
  // Windows shells need different invocation syntax; keep their existing command-name contract.
  if (process.platform === 'win32' || !hasAppEnvironment()) {
    return undefined
  }
  const app = getAppEnvironment()
  const launcher = prependOrcaCliDirToChildPath(
    {},
    {
      isPackaged: app.isPackaged(),
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath ?? null
    }
  )
  return launcher ? quoteShell(launcher) : undefined
}

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  runtimeCliCommand?: OrchestrationCliCommand
  nativeCliCommand?: () => OrchestrationCliCommand | undefined
}): OrchestrationCliCommand {
  if (args.connectionId) {
    return 'orca'
  }
  const worktreePath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath
  const isWsl =
    args.isWsl ??
    ((args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') ||
      Boolean(worktreePath && isWslUncPath(worktreePath)))
  if (isWsl) {
    return args.runtimeCliCommand ?? 'orca-ide'
  }
  return args.nativeCliCommand?.() ?? args.runtimeCliCommand ?? 'orca'
}
