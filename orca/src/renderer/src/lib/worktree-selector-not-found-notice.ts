import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { translate } from '@/i18n/i18n'

/** The host's "could not answer for this workspace right now" code, not a verdict that it is gone. */
const WORKTREE_SELECTOR_NOT_FOUND_CODE = 'selector_not_found'

export function worktreeSelectorNotFoundNotice(): string {
  return translate(
    'auto.lib.worktree.selector.not.found.worktreeUnresolved',
    "Orca couldn't resolve this workspace on its host right now. It may have been deleted; refresh the workspace list, or remove it from Orca if it is gone."
  )
}

/** Whether a terminal/toast line is the host's unresolved-selector answer rather than prose about it. */
export function isWorktreeSelectorNotFoundMessage(message: string): boolean {
  return message
    .split('\n')
    .some((line) => hasRuntimeRpcErrorCode(line, WORKTREE_SELECTOR_NOT_FOUND_CODE))
}

/**
 * Why replace the whole line: the raw form reaches the UI IPC-wrapped, and keeping the wrapper
 * would still show the machine code instead of the sentence the user needs.
 */
export function replaceWorktreeSelectorNotFoundCode(message: string): string {
  const notice = worktreeSelectorNotFoundNotice()
  return message
    .split('\n')
    .map((line) => (hasRuntimeRpcErrorCode(line, WORKTREE_SELECTOR_NOT_FOUND_CODE) ? notice : line))
    .join('\n')
}
