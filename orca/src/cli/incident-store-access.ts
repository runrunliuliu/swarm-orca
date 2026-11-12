// How the CLI reaches the incident store (§12 M1).
//
// The M1 CLI opens the SQLite file directly instead of going through runtime RPC. That is a
// deliberate trade: `list`/`show`/`decide` must work on a host whose desktop app is not running —
// which is when triage actually happens — and adding an RPC surface is M2's read model. WAL mode
// already serializes a second writer across processes, so the runtime can be writing crashes while a
// human triages.

import { existsSync } from 'node:fs'
import { RuntimeClientError } from './runtime/types'
import { getDefaultUserDataPath } from './runtime/metadata'
import { openIncidentsDatabase } from '../main/incidents/incidents-database'
import {
  DEFAULT_INCIDENT_RETENTION_DAYS,
  DEFAULT_INCIDENT_STORE_LIMITS,
  createIncidentStore,
  type IncidentStore
} from '../main/incidents/incident-store'
import { incidentsDatabaseFileFor } from '../main/incidents/incidents-paths'

export type OpenedIncidentStore = {
  store: IncidentStore
  path: string
  close: () => void
}

export function incidentsDatabaseFile(): string {
  return incidentsDatabaseFileFor(getDefaultUserDataPath())
}

/**
 * A stand-in for "no store yet": an empty list with the real coverage shape, so `list` still prints
 * the `remote_incident_capture` gap instead of pretending an empty host has nothing to report.
 */
function unavailableStore(): IncidentStore {
  const coverage = {
    remoteIncidentCapture: 'unsupported' as const,
    capacityLatchSet: false,
    currentlyLimited: false,
    capacity: {
      rows: 0,
      bytes: 0,
      maxRows: DEFAULT_INCIDENT_STORE_LIMITS.maxRows,
      maxBytes: DEFAULT_INCIDENT_STORE_LIMITS.maxBytes
    },
    shadowReplay: {
      lastSeq: 0,
      incomplete: false,
      lastStopReason: null,
      failures: 0,
      lastError: null,
      dropped: 0,
      lastDroppedReason: null,
      lastRun: null
    }
  }
  return {
    insertIncident: () => ({ outcome: 'read_only', id: null }),
    appendDecision: () => ({ outcome: 'read_only' }),
    getIncident: () => null,
    listIncidents: () => ({ incidents: [], total: 0, coverage }),
    coverage: () => coverage,
    countIncidents: () => 0,
    pruneIncidents: () => ({
      dryRun: true,
      olderThanDays: DEFAULT_INCIDENT_RETENTION_DAYS,
      cutoff: 0,
      candidates: 0,
      deleted: 0,
      byStatus: {},
      candidateIds: [],
      candidateIdsTruncated: false,
      deletedIds: [],
      deletedIdsTruncated: false
    }),
    readOnly: true
  }
}

/**
 * Open the store for one command.
 *
 * `requireExisting` is what separates "no incidents on this host yet" (an empty `list`, which is a
 * real answer) from "you asked about an incident that cannot exist here" (an error naming the path).
 */
export function openIncidentStore(options: {
  requireExisting: boolean
  readOnly: boolean
  /** `incident report` creates the store: the first report on a host is the first row. */
  createIfMissing?: boolean
}): OpenedIncidentStore {
  const path = incidentsDatabaseFile()
  if (!existsSync(path)) {
    if (options.createIfMissing === true && options.readOnly === false) {
      // Falls through to the writable open below, which makes the directory and migrates an empty
      // file. Only a write command may do this; `list` must leave the disk untouched (M1 C4).
    } else if (!options.requireExisting) {
      return { store: unavailableStore(), path, close: () => undefined }
    } else {
      throw new RuntimeClientError(
        'invalid_argument',
        `No incident store on this host (${path}). Incidents are recorded by the running Orca runtime; ` +
          'start Orca on this host and let it record one, or check that you are on the host you meant.'
      )
    }
  }
  const opened = openIncidentsDatabase(path, { readOnly: options.readOnly })
  return {
    store: createIncidentStore({
      db: opened.db,
      fileSizeBytes: opened.fileSizeBytes,
      readOnly: opened.readOnly
    }),
    path,
    close: () => opened.db.close()
  }
}
