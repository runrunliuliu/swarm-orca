import { ipcRenderer } from 'electron'
import type {
  IncidentDecideRequest,
  IncidentDetailRequest,
  IncidentListRequest
} from '../../shared/incident-api-types'
import type { PreloadApi } from '../api-types'

/** One `invoke` per channel; the main handler owns validation and returns a closed result. */
export const incidentApi = {
  snapshot: (request?: IncidentListRequest) => ipcRenderer.invoke('incidents:snapshot', request),
  detail: (request: IncidentDetailRequest) => ipcRenderer.invoke('incidents:detail', request),
  decide: (request: IncidentDecideRequest) => ipcRenderer.invoke('incidents:decide', request)
} satisfies PreloadApi['incidents']
