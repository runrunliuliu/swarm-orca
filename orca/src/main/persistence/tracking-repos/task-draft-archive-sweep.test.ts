import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
import {
  archiveInactiveTaskDrafts,
  TASK_DRAFT_INACTIVE_ARCHIVE_MS
} from './task-draft-archive-sweep'

const NOW = 1_800_000_000_000
const LINKED_TASK: WorkspaceLinkedItem = {
  provider: 'github',
  type: 'issue',
  number: 42,
  title: 'draft',
  url: 'https://example.test/issues/42'
}

function makeDraft(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'draft-1',
    projectGroupId: 'group-1',
    name: 'draft',
    folderPath: '/userData/task-drafts/key-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    taskDraft: true,
    ...overrides
  }
}

function makeState(drafts: FolderWorkspace[]) {
  const state = getDefaultPersistedState('/home/test')
  state.folderWorkspaces = drafts
  return state
}

describe('archiveInactiveTaskDrafts', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-task-draft-sweep-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('archives a linked draft idle past the grace period', () => {
    const draft = makeDraft({
      linkedTask: LINKED_TASK,
      lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1
    })

    expect(archiveInactiveTaskDrafts(makeState([draft]), NOW)).toBe(1)

    expect(draft.isArchived).toBe(true)
  })

  it('leaves the draft directory and every other field untouched', () => {
    const draftDir = path.join(tempRoot, 'key-1')
    mkdirSync(draftDir, { recursive: true })
    const draft = makeDraft({
      folderPath: draftDir,
      linkedTask: LINKED_TASK,
      lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1,
      updatedAt: 123
    })

    archiveInactiveTaskDrafts(makeState([draft]), NOW)

    expect(existsSync(draftDir)).toBe(true)
    expect(draft.folderPath).toBe(draftDir)
    expect(draft.updatedAt).toBe(123)
    expect(draft.linkedTask).toBe(LINKED_TASK)
  })

  it('skips unlinked, already-archived, recent, unknown-activity and non-draft rows', () => {
    const rows = [
      makeDraft({ id: 'unlinked', lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1 }),
      makeDraft({
        id: 'archived',
        isArchived: true,
        linkedTask: LINKED_TASK,
        lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1
      }),
      makeDraft({
        id: 'recent',
        linkedTask: LINKED_TASK,
        lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS
      }),
      makeDraft({ id: 'missing-activity', linkedTask: LINKED_TASK, lastActivityAt: 0 }),
      makeDraft({
        id: 'not-a-draft',
        taskDraft: undefined,
        linkedTask: LINKED_TASK,
        lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1
      })
    ]

    expect(archiveInactiveTaskDrafts(makeState(rows), NOW)).toBe(0)

    // Only the fixture's already-archived row is archived; nothing else flipped.
    expect(rows.filter((row) => row.isArchived).map((row) => row.id)).toEqual(['archived'])
  })

  it('stops at the cap', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeDraft({
        id: `draft-${index}`,
        linkedTask: LINKED_TASK,
        lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1
      })
    )

    expect(archiveInactiveTaskDrafts(makeState(rows), NOW, 3)).toBe(3)

    expect(rows.filter((row) => row.isArchived).length).toBe(3)
  })

  it('defaults the cap to 100', () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      makeDraft({
        id: `draft-${index}`,
        linkedTask: LINKED_TASK,
        lastActivityAt: NOW - TASK_DRAFT_INACTIVE_ARCHIVE_MS - 1
      })
    )

    expect(archiveInactiveTaskDrafts(makeState(rows), NOW)).toBe(100)
  })

  it('runs once from the load-time pass, right after gcStaleWorktreeMeta', () => {
    const source = readFileSync(
      path.join(__dirname, '../loading-store/loaded-state-parsing.ts'),
      'utf8'
    )
    const callSites = source.match(/archiveInactiveTaskDrafts\(/g) ?? []

    expect(callSites).toHaveLength(1)
    expect(source.indexOf('archiveInactiveTaskDrafts(result)')).toBeGreaterThan(
      source.indexOf('gcStaleWorktreeMeta(result)')
    )
  })
})
