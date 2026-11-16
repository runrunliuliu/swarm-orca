// Incident reads over runtime RPC (A-fix, 2026-11-16).
//
// Why this exists: the desktop panel read only its own machine's store, because the preload bridge
// has no runtime target. A paired runtime now serves the same three reads, so a client can show the
// host it is actually looking at — and, crucially, say *which* host answered.
//
// What is deliberately absent: no `decide`, no prune, no archive retry. Triage mutates a store that a
// person owns on that host, and the CLI remains the local-only surface for it (§19.1). A read here
// cannot write: the store is opened read-only and a host without one answers `store-not-created`
// instead of creating it.

import { defineMethod } from '../core'
import {
  IncidentCountsParams,
  IncidentDetailParams,
  IncidentSnapshotParams
} from '../../../../shared/rpc-contract/incidents-params'
import type {
  IncidentCountsDto,
  IncidentDetailDto,
  IncidentSnapshotDto
} from '../../../../shared/incident-api-types'
import { RuntimeClientError } from '../../../computer/runtime-client-error'
import { openIncidentReadService, type IncidentReadOutcome } from '../../../incidents/incident-read-service'

/**
 * The host's own view of "where these bytes came from".
 *
 * The host says `local` because for it the store is local; the client re-stamps the answer with the
 * environment it dialled (it is the only side that knows the pairing name). Two stamps, one field, so
 * a panel can never present one host's rows as another's by accident.
 */
const HOST_SOURCE = { kind: 'local' as const }

function unwrap<T>(outcome: IncidentReadOutcome<T>, what: string): T {
  if (outcome.availability === 'supported') {
    return outcome.value
  }
  if (outcome.availability === 'store-not-created') {
    // Reachable for a detail only: snapshot/counts answer a missing store with a real empty view.
    throw new RuntimeClientError('not_found', `No incident store on this host (${what}).`)
  }
  throw new RuntimeClientError('internal_error', outcome.error)
}

export const INCIDENT_METHODS = [
  defineMethod({
    name: 'incidents.snapshot',
    params: IncidentSnapshotParams,
    handler: async (params): Promise<IncidentSnapshotDto> => {
      const reader = openIncidentReadService()
      try {
        return unwrap(reader.snapshot(params ?? undefined, HOST_SOURCE), 'snapshot')
      } finally {
        reader.close()
      }
    }
  }),
  defineMethod({
    name: 'incidents.detail',
    params: IncidentDetailParams,
    handler: async (params): Promise<IncidentDetailDto> => {
      const reader = openIncidentReadService()
      try {
        const detail = unwrap(reader.detail(params.incidentId, HOST_SOURCE), 'detail')
        if (detail === null) {
          throw new RuntimeClientError('not_found', `Incident ${params.incidentId} not found.`)
        }
        return detail
      } finally {
        reader.close()
      }
    }
  }),
  defineMethod({
    name: 'incidents.counts',
    params: IncidentCountsParams,
    handler: async (params): Promise<IncidentCountsDto> => {
      const reader = openIncidentReadService()
      try {
        return unwrap(reader.counts(params ?? undefined, HOST_SOURCE), 'counts')
      } finally {
        reader.close()
      }
    }
  })
]
