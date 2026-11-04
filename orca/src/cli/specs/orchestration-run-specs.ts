import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ORCHESTRATION_RUN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'planned-restart'],
    summary: 'Prepare, seal or independently review a same-host planned Server restart',
    usage: 'orca orchestration planned-restart --request-file <json> [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'request-file', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: ['Experimental Server-only maintenance. Seal freezes writes; errors preserve the freeze. Requires live native caller evidence. Unsupported servers refuse.']
  },
  {
    path: ['orchestration', 'strict-caller-check'],
    summary: 'Check live native caller proof without creating or binding a Run',
    usage: 'orca orchestration strict-caller-check [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Run inside the native Coordinator process. A terminal handle or an earlier success is not proof for a later call. Does not grant authority or support takeover. Unsupported servers fail closed.'
    ]
  },
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--strict-coordinator] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'objective', 'strict-coordinator', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      '--strict-coordinator is experimental and opt-in: pins a live terminal Coordinator, not a scheduler. No rebind/adoption. Only the original Coordinator can retire after reconciliation; history and reset protection remain. Same-runtime terminal Workers only. Unsupported servers fail closed.',
      '--retry-request is only for exact recovery after an unknown mutation result.'
    ]
  },
  {
    path: ['orchestration', 'run-retire-strict'],
    summary: 'Retire a reconciled strict Run from its original live Coordinator',
    usage:
      'orca orchestration run-retire-strict --run <id> --generation <n> --decision <reference> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'generation', 'decision', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Requires settled work, no pending mutations and host-proven exit of every Worker. No takeover, deletion or external Job verification.'
    ]
  }
]
