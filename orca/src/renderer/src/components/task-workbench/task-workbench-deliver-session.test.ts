import { describe, expect, it } from 'vitest'
import {
  TASK_WORKBENCH_DELIVER_SESSION_LABEL,
  isTaskWorkbenchDeliverSessionName
} from './task-workbench-deliver-session'

describe('isTaskWorkbenchDeliverSessionName', () => {
  it('accepts the marker, with the whitespace a tab label may carry', () => {
    expect(TASK_WORKBENCH_DELIVER_SESSION_LABEL).toBe('DELIVER')
    expect(isTaskWorkbenchDeliverSessionName('DELIVER')).toBe(true)
    expect(isTaskWorkbenchDeliverSessionName('  DELIVER\n')).toBe(true)
  })

  it('rejects a rename, a different case and a name that merely contains the word', () => {
    // D2's reopen condition: a user renaming the tab stops it being the session
    // rather than being guessed back into one.
    expect(isTaskWorkbenchDeliverSessionName('DELIVER fix-431')).toBe(false)
    expect(isTaskWorkbenchDeliverSessionName('deliver')).toBe(false)
    expect(isTaskWorkbenchDeliverSessionName('My DELIVER')).toBe(false)
  })

  it('rejects the absences a row can carry instead of a name', () => {
    expect(isTaskWorkbenchDeliverSessionName(undefined)).toBe(false)
    expect(isTaskWorkbenchDeliverSessionName(null)).toBe(false)
    expect(isTaskWorkbenchDeliverSessionName('')).toBe(false)
    expect(isTaskWorkbenchDeliverSessionName('   ')).toBe(false)
  })
})
