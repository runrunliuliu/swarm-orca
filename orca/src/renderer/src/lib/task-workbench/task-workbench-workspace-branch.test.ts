import { describe, expect, it } from 'vitest'
import { workspaceBranchName } from './task-workbench-workspace-branch'

/**
 * The one rule behind a workspace row's identity (README §7.4.2 取舍 2). Every
 * expectation is a literal: a value read back out of the function would prove
 * nothing about what a reviewer can check by hand.
 */

describe('workspaceBranchName', () => {
  it('returns the branch of a git worktree, even when the display name is a title', () => {
    // Orca names a generated worktree after the task title, so `worktreeName`
    // alone would print the page's h1 a second time.
    expect(
      workspaceBranchName('worktree', { branch: 'feature/add-login' })
    ).toBe('feature/add-login')
  })

  it('never turns a folder workspace path into a branch label', () => {
    // A folder workspace's `branch` is the directory it points at. Printing it
    // would put a private path on screen under a label that says "branch".
    expect(
      workspaceBranchName('folder', { branch: '/Users/someone/work/docs' })
    ).toBeUndefined()
  })

  it('treats an empty or missing branch as an absence, not as a name', () => {
    expect(workspaceBranchName('worktree', { branch: '' })).toBeUndefined()
    expect(workspaceBranchName('worktree', { branch: null })).toBeUndefined()
    expect(workspaceBranchName('worktree', {})).toBeUndefined()
  })

  it('keeps a branch when the caller could not classify the workspace', () => {
    // `workspaceKind` is optional in older snapshots; an unknown kind must not
    // throw away a branch the store did report.
    expect(workspaceBranchName(undefined, { branch: 'fix/flaky-checkout' })).toBe(
      'fix/flaky-checkout'
    )
  })
})
