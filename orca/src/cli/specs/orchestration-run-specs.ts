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
    path: ['orchestration', 'start-grant-mint'],
    summary: 'Mint one start grant from a record the caller persisted',
    usage:
      'orca orchestration start-grant-mint --record-file <path> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'record-file', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'The record must not contain `minter`: the server writes the verified live caller, because a caller cannot read its own launch token. An identical resubmission is a retry; a different record under the same grant id is refused.',
      'Minting is not a gate. It records who approved what, until when; the gate is create and spawn.'
    ]
  },
  {
    path: ['orchestration', 'start-grant-show'],
    summary: 'Read one start grant with its derived state and the Run it covers',
    usage: 'orca orchestration start-grant-show --grant <grant_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'grant'],
    notes: [
      'valid/expired/revoked are derived at read time from the server clock; nothing stores a verdict.'
    ]
  },
  {
    path: ['orchestration', 'start-grant-revoke'],
    summary: 'Withdraw a start grant so no new Run or Worker starts under it',
    usage:
      'orca orchestration start-grant-revoke --grant <grant_id> --reason <text> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'grant', 'reason', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'One withdrawal per grant: the same intent replays, a different reason is refused. A revocation stops new creates and spawns; it does not reach into Workers already running.'
    ]
  },
  {
    path: ['orchestration', 'run-create'],
    summary: 'Create and bind a lightweight orchestration Run',
    usage:
      'orca orchestration run-create --objective <text> [--strict-coordinator] [--grant <grant_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'objective',
      'strict-coordinator',
      'grant',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      '--strict-coordinator is experimental and opt-in: pins a live terminal Coordinator, not a scheduler. No rebind/adoption. Only the original Coordinator can retire after reconciliation; history and reset protection remain. Same-runtime terminal Workers only. Unsupported servers fail closed.',
      '--grant <grant_id> creates the Run under a start grant and requires --strict-coordinator. The objective must equal the one the grant approves, a grant covers one Run, and a repeat from the same live Coordinator returns the existing Run with effectsApplied:false. Refusals are start_grant_* and leave no Run row.',
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
