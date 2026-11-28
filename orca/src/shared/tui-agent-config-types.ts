export type AgentPromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'hermes-query'
  | 'stdin-after-start'

export type DraftPasteReadySignal =
  | 'render-quiet-after-bracketed-paste'
  | 'codex-composer-prompt'
  | 'render-cursor-after-bracketed-paste'
  | 'grok-composer-prompt'
  | 'dsh-composer-prompt'
  | 'zcode-composer-prompt'

export type TuiAgentDetectionRuntime = NodeJS.Platform | 'wsl'

export type TuiAgentConfig = {
  detectCmd: string
  /** Additional executable names that identify the same agent on PATH. */
  detectCmdAliases?: readonly string[]
  /** Other commands that must also be present before this agent counts as installed. */
  detectRequiredCommands?: readonly string[]
  /** Detection runtimes where this launch mode is not available as a detected agent. */
  detectUnsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
  launchCmd: string
  /** Platform-specific launch command when the public binary name differs. */
  launchCmdByPlatform?: Partial<Record<NodeJS.Platform, string>>
  expectedProcess: string
  /**
   * Other foreground `comm` names that mean this same `expectedProcess` binary. The kernel
   * reports the basename of the path used to exec, not the resolved symlink target, so one
   * launcher reaches Orca under more than one name (e.g. `traecli` -> `traex`).
   */
  expectedProcessAliases?: readonly string[]
  promptInjectionMode: AgentPromptInjectionMode
  /** Option terminator required before positional prompts that may look like CLI syntax. */
  argvPromptSeparator?: '--'
  /** Native CLI flag that seeds the input without submitting (e.g. Claude's `--prefill <text>`); preferred over the paste-after-ready path. */
  draftPromptFlag?: string
  /** Startup env var that seeds the input without submitting, for agents with no `--prefill`-style flag (e.g. pi); avoids the paste-after-ready race. */
  draftPromptEnvVar?: string
  /**
   * Companion flag for `draftPromptEnvVar`: a launch that sets it to `1` asks the agent's own
   * startup hook to submit the seeded prompt instead of leaving it editable. Only agents whose
   * prefill hook can start a turn may declare it (see `agentSupportsSubmittedPrefill`).
   */
  draftPromptSubmitEnvVar?: string
  /** Claude Code follows pasted text only where the user's typed words ask, so dispatch briefs need a typed lead line. */
  pasteNeedsTypedRequest?: boolean
  /** Trust Orca pre-writes at PTY spawn (agent-workspace-trust.ts) so the agent's first-launch "trust this folder?" menu doesn't consume the bracketed paste. */
  preflightTrust?:
    | 'claude'
    | 'cursor'
    | 'copilot'
    | 'codex'
    | 'antigravity'
    | 'qoder'
    | 'trae'
    | 'codex-ark'
  /** Agent-specific signal that the composer is ready for paste, stronger than the default quiet-render window. */
  draftPasteReadySignal?: DraftPasteReadySignal
  /** Hard deadline for the agent's composer readiness signal. */
  draftPasteReadyTimeoutMs?: number
  /** Delay before one extra blind submit Enter, for agents that render their composer before Enter is live (codex); a no-op if the first Enter landed. */
  submitRetryDelayMs?: number
  /** Extra ms per logical prompt line before Enter, for TUIs that expand multiline paste slowly (antigravity). */
  submitLineSettleMsPerLine?: number
  /** Windows Shift+Enter encoding override; omitted agents keep the legacy Esc+CR path. */
  windowsShiftEnterEncoding?: 'csi-u'
  /** Paste newlines for TUIs that read Windows console input records instead of VT paste frames. */
  windowsInputRecordPasteNewline?: 'alt-enter' | 'csi-u'
  /** Ctrl+Enter encoding for agents that consume CSI-u without active kitty flags. */
  ctrlEnterEncoding?: 'csi-u'
}
