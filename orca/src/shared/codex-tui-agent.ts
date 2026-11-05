/** TUI compatibility only; homes, providers, hooks and native-chat backends remain separate. */
export function isCodexTuiAgent(agent: string | null | undefined): agent is 'codex' | 'codex-ark' {
  return agent === 'codex' || agent === 'codex-ark'
}

export const CODEX_TUI_YOLO_ARGS = '--dangerously-bypass-approvals-and-sandbox'
