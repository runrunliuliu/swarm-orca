import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveIncidentRuntimeTarget } from '@/runtime/incident-runtime-target'
import type { IncidentRuntimeTarget } from '@/runtime/incident-runtime-target'

export function useIncidentRuntimeTarget(): IncidentRuntimeTarget {
  return useAppStore(useShallow(resolveIncidentRuntimeTarget))
}
