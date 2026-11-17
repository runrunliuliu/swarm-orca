import { describe, expect, it } from 'vitest'
import { getDraftContextMenuState } from './worktree-context-menu-draft-actions'

describe('getDraftContextMenuState', () => {
  it('detects a draft folder workspace', () => {
    expect(getDraftContextMenuState({ taskDraft: true })).toEqual({ isDraft: true })
  })

  it('keeps the generic copy for a plain folder workspace', () => {
    expect(getDraftContextMenuState({ taskDraft: false })).toEqual({ isDraft: false })
    expect(getDraftContextMenuState({})).toEqual({ isDraft: false })
  })

  it('treats a missing workspace as a non-draft', () => {
    expect(getDraftContextMenuState(null).isDraft).toBe(false)
    expect(getDraftContextMenuState(undefined).isDraft).toBe(false)
  })
})
