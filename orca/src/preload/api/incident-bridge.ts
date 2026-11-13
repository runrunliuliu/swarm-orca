import { ipcRenderer } from 'electron'
import type {
  IncidentCountsDto,
  IncidentCountsRequest,
  IncidentDecideRequest,
  IncidentDetailRequest,
  IncidentListRequest
} from '../../shared/incident-api-types'
import type { PreloadApi } from '../api-types'

/**
 * One `invoke` per channel; the main handler owns validation and returns a closed result.
 *
 * `onCountsChanged` follows the push-bridge shape used by `agent-status-bridge`: register on the
 * channel, return a remover that detaches exactly that listener (not `removeAllListeners`, which would
 * also drop another component's subscription).
 */
export const incidentApi = {
  snapshot: (request?: IncidentListRequest) => ipcRenderer.invoke('incidents:snapshot', request),
  detail: (request: IncidentDetailRequest) => ipcRenderer.invoke('incidents:detail', request),
  decide: (request: IncidentDecideRequest) => ipcRenderer.invoke('incidents:decide', request),
  counts: (request?: IncidentCountsRequest) => ipcRenderer.invoke('incidents:counts', request),
  paneClocks: () => ipcRenderer.invoke('incidents:paneClocks'),
  toolFailures: () => ipcRenderer.invoke('incidents:toolFailures'),
  onCountsChanged: (callback: (counts: IncidentCountsDto) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, counts: IncidentCountsDto) =>
      callback(counts)
    ipcRenderer.on('incidents:countsChanged', listener)
    return () => ipcRenderer.removeListener('incidents:countsChanged', listener)
  }
} satisfies PreloadApi['incidents']
