import { getAppEnvironment } from '../../shared/app-environment'
import { ServeReadinessPublisher, type ServeReadiness } from '../server/serve-readiness'
import { collectOrcadHealth } from './orcad-health'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { OrcadOptions } from './orcad-entry'

export function buildOrcadReadiness(
  runtimeId: string,
  rpc: OrcaRuntimeRpcServer,
  options: Pick<OrcadOptions, 'noPairing' | 'pairingAddress'>
): ServeReadiness {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : rpc.createPairingOffer({
        address: options.pairingAddress,
        name: `CLI ${new Date().toLocaleDateString()}`,
        scope: 'runtime'
      })
  return {
    runtimeId,
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    // WSL CLI reconciliation is a desktop-launch concern, not a pending orcad repair.
    managedWslCliReconciliation: 'settled',
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: 'runtime',
          qr: null
        }
      : offer
  }
}

/** Once serving, reporting failure cannot reopen an old restart credential. */
export async function publishOrcadStartup(
  readiness: ServeReadiness,
  json: boolean | undefined,
  committed: boolean,
  authority: Parameters<typeof collectOrcadHealth>[1]
) {
  const publish = async () => {
    if (committed) {
      readiness.health = await collectOrcadHealth(getAppEnvironment().getVersion(), authority)
    }
    await new ServeReadinessPublisher().publish(readiness, { mode: json ? 'json' : 'human' })
  }
  return committed
    ? publish().catch((error) =>
        console.error('[orcad] committed startup reporting failed:', error)
      )
    : publish()
}
