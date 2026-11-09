import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** Minimal row shape the lineage rules need; DashboardAgentRow satisfies it,
 *  and other surfaces (e.g. the Agents thread list) can feed synthetic rows. */
export type AgentLineageSourceRow = {
  paneKey: string
  entry: Pick<AgentStatusEntry, 'terminalHandle' | 'orchestration'>
  lineageParentPaneKey?: string
  lineageSortAt?: number
}

export type AgentRowLineageTree<T extends AgentLineageSourceRow> = {
  rootRows: T[]
  childrenByParentPaneKey: Map<string, T[]>
  childPaneKeys: Set<string>
}

export type AgentLineageAttentionCounts = {
  countedPaneKeys: Set<string>
  count: number
}

function buildPaneKeyByTerminalHandle<T extends AgentLineageSourceRow>(
  rows: readonly T[]
): Map<string, string> {
  const paneKeyByTerminalHandle = new Map<string, string>()
  for (const row of rows) {
    if (row.entry.terminalHandle && !paneKeyByTerminalHandle.has(row.entry.terminalHandle)) {
      paneKeyByTerminalHandle.set(row.entry.terminalHandle, row.paneKey)
    }
  }
  return paneKeyByTerminalHandle
}

export function resolveAgentRowParentPaneKey<T extends AgentLineageSourceRow>(
  row: T,
  rowsByPaneKey: ReadonlyMap<string, T>,
  paneKeyByTerminalHandle: ReadonlyMap<string, string>
): string | undefined {
  const visualParentPaneKey = row.lineageParentPaneKey
  if (
    visualParentPaneKey &&
    visualParentPaneKey !== row.paneKey &&
    rowsByPaneKey.has(visualParentPaneKey)
  ) {
    return visualParentPaneKey
  }

  const explicitParentPaneKey = row.entry.orchestration?.parentPaneKey
  if (
    explicitParentPaneKey &&
    explicitParentPaneKey !== row.paneKey &&
    rowsByPaneKey.has(explicitParentPaneKey)
  ) {
    return explicitParentPaneKey
  }

  const parentTerminalHandles = [
    row.entry.orchestration?.parentTerminalHandle,
    row.entry.orchestration?.coordinatorHandle
  ]
  for (const parentTerminalHandle of parentTerminalHandles) {
    const parentPaneKey = parentTerminalHandle
      ? paneKeyByTerminalHandle.get(parentTerminalHandle)
      : undefined
    if (parentPaneKey && parentPaneKey !== row.paneKey && rowsByPaneKey.has(parentPaneKey)) {
      return parentPaneKey
    }
  }

  return undefined
}

function comparableLineageSortAt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compareLineageSiblings<T extends AgentLineageSourceRow>(
  a: T,
  b: T,
  originalIndexByRow: ReadonlyMap<T, number>
): number {
  const aSortAt = comparableLineageSortAt(a.lineageSortAt)
  const bSortAt = comparableLineageSortAt(b.lineageSortAt)
  if (aSortAt !== undefined && bSortAt !== undefined && aSortAt !== bSortAt) {
    return aSortAt - bSortAt
  }
  return (originalIndexByRow.get(a) ?? 0) - (originalIndexByRow.get(b) ?? 0)
}

export function buildAgentRowLineageTree<T extends AgentLineageSourceRow>(
  rows: readonly T[]
): AgentRowLineageTree<T> {
  const rowsByPaneKey = new Map<string, T>()
  const originalIndexByRow = new Map<T, number>()
  rows.forEach((row, index) => {
    originalIndexByRow.set(row, index)
  })
  for (const row of rows) {
    if (!rowsByPaneKey.has(row.paneKey)) {
      rowsByPaneKey.set(row.paneKey, row)
    }
  }
  const paneKeyByTerminalHandle = buildPaneKeyByTerminalHandle(rows)
  const childrenByParentPaneKey = new Map<string, T[]>()
  const childPaneKeys = new Set<string>()

  for (const row of rows) {
    const parentPaneKey = resolveAgentRowParentPaneKey(row, rowsByPaneKey, paneKeyByTerminalHandle)
    if (!parentPaneKey) {
      continue
    }
    childPaneKeys.add(row.paneKey)
    const siblings = childrenByParentPaneKey.get(parentPaneKey)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParentPaneKey.set(parentPaneKey, [row])
    }
  }
  for (const siblings of childrenByParentPaneKey.values()) {
    siblings.sort((a, b) => compareLineageSiblings(a, b, originalIndexByRow))
  }

  const rootRows = rows.filter((row) => !childPaneKeys.has(row.paneKey))
  if (rootRows.length === 0 && rows.length > 0) {
    // Why: malformed orchestration metadata can form a closed cycle. Keep every
    // row visible as a flat root instead of hiding all participants.
    return { rootRows: [...rows], childrenByParentPaneKey: new Map(), childPaneKeys: new Set() }
  }

  const reachablePaneKeys = new Set<string>()
  for (const rootRow of rootRows) {
    reachablePaneKeys.add(rootRow.paneKey)
  }
  // Set iteration visits newly added descendants once, including cyclic/duplicate edges.
  for (const paneKey of reachablePaneKeys) {
    for (const childRow of childrenByParentPaneKey.get(paneKey) ?? []) {
      reachablePaneKeys.add(childRow.paneKey)
    }
  }

  const unreachableRows = rows.filter((row) => !reachablePaneKeys.has(row.paneKey))
  if (unreachableRows.length === 0) {
    return { rootRows, childrenByParentPaneKey, childPaneKeys }
  }

  const normalizedChildrenByParentPaneKey = new Map(childrenByParentPaneKey)
  const normalizedChildPaneKeys = new Set(childPaneKeys)
  const promotedPaneKeys = new Set<string>()
  for (const row of unreachableRows) {
    if (promotedPaneKeys.has(row.paneKey)) {
      continue
    }
    promotedPaneKeys.add(row.paneKey)
    rootRows.push(row)
    normalizedChildPaneKeys.delete(row.paneKey)
    // Every child of a reachable parent is reachable, so only these parent lists need removal.
    normalizedChildrenByParentPaneKey.delete(row.paneKey)
  }

  return {
    rootRows,
    childrenByParentPaneKey: normalizedChildrenByParentPaneKey,
    childPaneKeys: normalizedChildPaneKeys
  }
}

export function collectAgentLineageAttentionCounts<T extends AgentLineageSourceRow>(
  rows: readonly T[],
  isAttentionRow: (row: T) => boolean
): AgentLineageAttentionCounts {
  const countedPaneKeys = new Set<string>()
  if (rows.length === 0) {
    return { countedPaneKeys, count: 0 }
  }

  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)
  const visitedPaneKeys = new Set<string>()
  const stack = rootRows
    .slice()
    .reverse()
    .map((row) => ({ row, hasAttentionAncestor: false }))

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || visitedPaneKeys.has(current.row.paneKey)) {
      continue
    }
    visitedPaneKeys.add(current.row.paneKey)
    const rowNeedsAttention = isAttentionRow(current.row)
    if (rowNeedsAttention && !current.hasAttentionAncestor) {
      countedPaneKeys.add(current.row.paneKey)
    }

    const children = childrenByParentPaneKey.get(current.row.paneKey) ?? []
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]
      if (child) {
        stack.push({
          row: child,
          hasAttentionAncestor: current.hasAttentionAncestor || rowNeedsAttention
        })
      }
    }
  }

  return { countedPaneKeys, count: countedPaneKeys.size }
}
