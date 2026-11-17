import { describe, expect, it } from 'vitest'
import { getTaskDraftName } from './task-draft-name'

describe('getTaskDraftName', () => {
  it('derives the display and seed names from an English instruction', () => {
    expect(
      getTaskDraftName({
        instruction: 'improve login page retry behaviour today',
        provider: 'github',
        existingNames: []
      })
    ).toEqual({
      displayName: 'Improve Login Page Retry Behaviour',
      seedName: 'improve-login-page-retry-behaviour'
    })
  })

  it('falls back to the provider draft name for a pure-Chinese instruction', () => {
    expect(
      getTaskDraftName({
        instruction: '给登录页加一个重试按钮',
        provider: 'github',
        existingNames: []
      })
    ).toEqual({ displayName: 'draft-github', seedName: 'draft-github' })
  })

  it('falls back to the provider draft name for a whitespace-only instruction', () => {
    expect(getTaskDraftName({ instruction: '   ', provider: 'linear', existingNames: [] })).toEqual(
      { displayName: 'draft-linear', seedName: 'draft-linear' }
    )
  })

  it('adds -1, then -2, to a display name already in use', () => {
    expect(
      getTaskDraftName({
        instruction: '给登录页加一个重试按钮',
        provider: 'github',
        existingNames: ['draft-github']
      })
    ).toEqual({ displayName: 'draft-github-1', seedName: 'draft-github-1' })
    expect(
      getTaskDraftName({
        instruction: '给登录页加一个重试按钮',
        provider: 'github',
        existingNames: ['draft-github', 'draft-github-1']
      })
    ).toEqual({ displayName: 'draft-github-2', seedName: 'draft-github-2' })
  })

  it('dedupes a derived display name before slugging it', () => {
    expect(
      getTaskDraftName({
        instruction: 'improve login page retry behaviour today',
        provider: 'github',
        existingNames: ['Improve Login Page Retry Behaviour']
      })
    ).toEqual({
      displayName: 'Improve Login Page Retry Behaviour-1',
      seedName: 'improve-login-page-retry-behaviour-1'
    })
  })

  it('matches existing names case-sensitively', () => {
    expect(
      getTaskDraftName({
        instruction: 'improve login page retry behaviour today',
        provider: 'github',
        existingNames: ['improve login page retry behaviour']
      })
    ).toEqual({
      displayName: 'Improve Login Page Retry Behaviour',
      seedName: 'improve-login-page-retry-behaviour'
    })
  })

  it('returns only the display and seed names', () => {
    const name = getTaskDraftName({
      instruction: 'fix login',
      provider: 'jira',
      existingNames: []
    })
    expect(name).toEqual({ displayName: 'Fix Login', seedName: 'fix-login' })
    expect(Object.keys(name)).toEqual(['displayName', 'seedName'])
  })
})
