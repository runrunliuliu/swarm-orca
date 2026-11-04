import { parsePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationMailboxLeaf } from './orchestration/mailbox-owner'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export type MailboxPaneTarget = {
  leaf: OrchestrationMailboxLeaf
  terminalHandle: string
  evidence: RuntimeLeafRecord | RuntimePtyWorktreeRecord
  rendererLeaf?: RuntimeLeafRecord
}

// A PTY-owned mailbox does not need a renderer, but must own one unambiguous exact pane.
export function resolveMailboxPaneTarget(
  leafKey: string,
  state: {
    leaves: ReadonlyMap<string, RuntimeLeafRecord>
    ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
    handleByLeafKey: ReadonlyMap<string, string>
    handleByPtyId: ReadonlyMap<string, string>
    getLeafKey: (tabId: string, leafId: string) => string
  }
): MailboxPaneTarget | undefined {
  const rendererLeaf = state.leaves.get(leafKey)
  if (rendererLeaf) {
    const terminalHandle = state.handleByLeafKey.get(leafKey)
    return terminalHandle
      ? { leaf: rendererLeaf, terminalHandle, evidence: rendererLeaf, rendererLeaf }
      : undefined
  }
  let target: MailboxPaneTarget | undefined
  for (const pty of state.ptysById.values()) {
    const pane = parsePaneKey(pty.paneKey ?? '')
    if (
      !pty.connected ||
      !pane ||
      pane.tabId !== pty.tabId ||
      state.getLeafKey(pane.tabId, pane.leafId) !== leafKey
    ) {
      continue
    }
    const terminalHandle = state.handleByPtyId.get(pty.ptyId)
    if (target || !terminalHandle) {
      return undefined
    }
    target = {
      terminalHandle,
      evidence: pty,
      leaf: {
        tabId: pane.tabId,
        leafId: pane.leafId,
        ptyId: pty.ptyId,
        writable: true,
        lastAgentStatus: pty.lastAgentStatus,
        lastAgentStatusObservedLive: pty.lastAgentStatusObservedLive,
        lastOscTitle: pty.lastOscTitle
      }
    }
  }
  return target
}
