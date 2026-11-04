import { createHash } from 'node:crypto'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../../shared/wsl-hook-relay-contract'

const LAUNCH_TOKEN_HASH_RE = /^[a-f0-9]{64}$/

function hashLaunchToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim()
  return trimmed ? createHash('sha256').update(trimmed).digest('hex') : null
}

export function launchTokenHashForStatusRow(status: unknown): string | null {
  if (!status || typeof status !== 'object') {
    return null
  }
  const launchToken = Reflect.get(status, 'launchToken')
  const tokenHash = hashLaunchToken(typeof launchToken === 'string' ? launchToken : null)
  if (tokenHash) {
    return tokenHash
  }
  const hash = Reflect.get(status, 'launchTokenHash')
  return typeof hash === 'string' && LAUNCH_TOKEN_HASH_RE.test(hash.trim()) ? hash.trim() : null
}

export function launchTokenHashMatchesStatusRow(
  status: AgentStatusIpcPayload,
  launchTokenHash: string | null | undefined
): boolean {
  const expected = launchTokenHash?.trim()
  return (
    !!expected &&
    LAUNCH_TOKEN_HASH_RE.test(expected) &&
    launchTokenHashForStatusRow(status) === expected
  )
}

export function launchTokenMatchesStatusRow(
  status: AgentStatusIpcPayload,
  launchToken: string | null | undefined
): boolean {
  const tokenHash = hashLaunchToken(launchToken)
  if (!tokenHash) {
    return false
  }
  if (status.launchToken) {
    return status.launchToken === launchToken
  }
  return launchTokenHashForStatusRow(status) === tokenHash
}

export function selectExactWorkerProviderSession(args: {
  paneKey: string
  processIncarnation: string
  connectionId: string | null | undefined
  wslDistro?: string | null
  launchToken: string | null | undefined
  launchTokenHash?: string | null | undefined
  observedAfter: number
  statuses: readonly AgentStatusIpcPayload[]
}): ExactWorkerProviderSession | null {
  const status = args.statuses
    .filter(
      (entry) =>
        entry.paneKey === args.paneKey &&
        connectionMatches(entry.connectionId, args.connectionId, args.wslDistro) &&
        // Trae accounting has no legacy attribution lane without execution-host launch metadata.
        (entry.agentType === 'trae'
          ? args.connectionId !== undefined &&
            (launchTokenMatchesStatusRow(entry, args.launchToken) ||
              launchTokenHashMatchesStatusRow(entry, args.launchTokenHash))
          : !args.launchToken || entry.launchToken === args.launchToken) &&
        entry.providerSessionOnly !== true &&
        entry.providerSession !== undefined &&
        entry.agentType !== undefined &&
        entry.receivedAt >= args.observedAfter
    )
    .sort((left, right) => right.receivedAt - left.receivedAt)[0]
  if (!status?.providerSession || !status.agentType) {
    return null
  }
  const wslDistro = attestedWslDistro(status.connectionId, args.wslDistro)
  const selectedLaunchTokenHash =
    hashLaunchToken(args.launchToken) ??
    (launchTokenHashMatchesStatusRow(status, args.launchTokenHash)
      ? args.launchTokenHash?.trim() ?? null
      : null)
  const selected: ExactWorkerProviderSession = {
    paneKey: args.paneKey,
    processIncarnation: args.processIncarnation,
    connectionId: status.connectionId,
    ...(wslDistro ? { wslDistro } : {}),
    ...(status.agentType === 'trae' && selectedLaunchTokenHash
      ? { launchTokenHash: selectedLaunchTokenHash }
      : {}),
    agent: status.agentType,
    providerSession: { ...status.providerSession },
    observedAt: status.receivedAt
  }
  return selected
}

function attestedWslDistro(
  connectionId: string | null,
  expectedDistro: string | null | undefined
): string | undefined {
  const distro = expectedDistro?.trim()
  return distro && connectionId === wslHookRelayConnectionId(distro) ? distro : undefined
}

function connectionMatches(
  entryConnectionId: string | null,
  expectedConnectionId: string | null | undefined,
  wslDistro: string | null | undefined
): boolean {
  if (expectedConnectionId === undefined || entryConnectionId === expectedConnectionId) {
    return true
  }
  // WSL hook relays stamp their distro on the event, while the host PTY stays
  // local (connectionId null). Require the PTY's known distro to avoid mixing
  // same-pane events from another WSL transport.
  return (
    expectedConnectionId === null &&
    typeof wslDistro === 'string' &&
    wslDistro.trim().length > 0 &&
    isWslHookRelayConnectionId(entryConnectionId) &&
    entryConnectionId === wslHookRelayConnectionId(wslDistro.trim())
  )
}
