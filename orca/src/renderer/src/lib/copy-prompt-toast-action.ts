import { translate } from '@/i18n/i18n'

/**
 * The "Copy prompt" action attached to a failed or unconfirmed launch delivery.
 *
 * Shared because two launch surfaces now report the same failure: the session-continuation
 * hand-off and the task workbench delivery entry. Copying the text back is the one repair either
 * of them can offer the reader without retyping the instruction or re-running the launch.
 */
export function copyPromptToastAction(prompt: string): {
  action: { label: string; onClick: () => void }
} {
  return {
    action: {
      label: translate('components.agentSessionContinuation.copyPrompt', 'Copy prompt'),
      onClick: () => {
        void window.api.ui.writeClipboardText(prompt)
      }
    }
  }
}
