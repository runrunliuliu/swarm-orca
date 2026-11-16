import { GLOBAL_FLAGS } from '../args'

// The operator acceptance override (issue-sedimentation.md §8, M5 C1): `--override-acceptance` plus the
// `--actor` and `--reason` it requires. Two commands can settle a dispatch without its worker reporting
// — `orchestration task-update` and `orchestration gate-create` — and both handlers read the flags from
// `handlers/orchestration/acceptance-override.ts`.
//
// Why the lists live here rather than inline in `orchestration.ts`: that file is at the `max-lines`
// budget, and these two arrays are the same capability declared twice. Keeping the flag list and the
// help note in one place is what stops the handlers' flags from becoming unreachable again — they were
// parsed by both handlers but absent from both `allowedFlags`, so `cli/args.ts` refused them as unknown
// and the whole bypass was dead from the CLI (review C1).

/** The flags `acceptanceOverrideFromFlags` consumes. */
const ACCEPTANCE_OVERRIDE_FLAGS = ['override-acceptance', 'actor', 'reason']

/** `--actor`/`--reason` are required with the override, and the bypass is recorded as an incident. */
export const OVERRIDE_NOTE =
  '--override-acceptance settles a dispatch whose acceptance rule blocked it; --actor and --reason are required with it, and the bypass is recorded as an acceptance_overridden incident.'

export const TASK_UPDATE_FLAGS = [
  ...GLOBAL_FLAGS,
  'id',
  'status',
  'result',
  ...ACCEPTANCE_OVERRIDE_FLAGS,
  'run',
  'from',
  'retry-request'
]

export const GATE_CREATE_FLAGS = [
  ...GLOBAL_FLAGS,
  'task',
  'question',
  'options',
  ...ACCEPTANCE_OVERRIDE_FLAGS,
  'from',
  'retry-request'
]
