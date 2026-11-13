/**
 * Optional help grouping (simplify S5).
 *
 * Display only: it never changes a command path, a flag or dispatch. A group that prints headings is
 * one whose commands declare a group; every other group keeps the flat list it always had, so this
 * vocabulary cannot leak into unrelated help output.
 */
export type CommandSpecGroup = 'daily' | 'diagnostic' | 'config' | 'maintenance'

export const COMMAND_SPEC_GROUP_ORDER: readonly CommandSpecGroup[] = [
  'daily',
  'diagnostic',
  'config',
  'maintenance'
]

export const COMMAND_SPEC_GROUP_LABELS: Record<CommandSpecGroup, string> = {
  daily: 'Daily',
  diagnostic: 'Diagnostic',
  config: 'Config',
  maintenance: 'Maintenance'
}

export type CommandSpec = {
  path: string[]
  // Why: conventional alternate verbs should resolve without duplicating specs or handlers.
  aliases?: string[][]
  argumentMode?: 'parsed' | 'passthrough'
  // Why: typo recovery must never steer a benign mistake into destructive state changes.
  destructive?: boolean
  hidden?: boolean
  summary: string
  /** Show this command under a heading in `--help` for its group (see CommandSpecGroup). */
  group?: CommandSpecGroup
  usage: string
  allowedFlags: string[]
  // Why: repeatability is per-command vocabulary. `--agent` repeats for `search`
  // and is single-valued for `worktree create`, which one global set cannot say.
  repeatableFlags?: string[]
  positionalArgs?: string[]
  examples?: string[]
  notes?: string[]
  // Why: `--from`/`--terminal` names either the acting caller or a target, and only the spec can
  // say which. An agent session refuses a caller flag naming anyone else before dispatch.
  identityFlagRoles?: Partial<Record<IdentityFlag, 'caller' | 'target'>>
}

export type IdentityFlag = 'from' | 'terminal'

export function specPaths(spec: CommandSpec): string[][] {
  return spec.aliases ? [spec.path, ...spec.aliases] : [spec.path]
}
