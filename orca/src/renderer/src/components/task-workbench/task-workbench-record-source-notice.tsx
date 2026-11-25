import React from 'react'
import { translate } from '@/i18n/i18n'
import type {
  TaskWorkbenchRecordSource,
  TaskWorkbenchRecordSourceUnavailable
} from './task-workbench-view'

/**
 * What the history's record could not be read from (issue #31).
 *
 * Why this exists as interface copy and not a tooltip: reading a task's history
 * now means reading several profiles, and "this page shows what this computer
 * had" is only honest if the page says which environments it could not read. The
 * failure this text prevents is the one the issue is about — an empty result
 * rendered as "this task never ran". A line here is never a substitute for the
 * content: the local history stays on screen, and every sentence says so.
 *
 * Why the version is printed only for `unsupported`: it is the one verdict where
 * the number is actionable (that host needs to update). For a timeout or a scope
 * refusal the version would be noise.
 */

function sourceKeys(key: string): string {
  return `auto.components.TaskWorkbenchRecordSourceNotice.${key}`
}

function environmentLabel(entry: TaskWorkbenchRecordSourceUnavailable): string {
  return entry.label ?? entry.environmentId
}

function unavailableSentence(entry: TaskWorkbenchRecordSourceUnavailable): string {
  const label = environmentLabel(entry)
  if (entry.failure === 'unsupported') {
    return entry.appVersion
      ? translate(
          sourceKeys('unsupportedWithVersion'),
          'Could not read history from {{value0}}: it runs Orca {{value1}}, which has no task-history method. Showing what this computer has; retry after that environment updates.',
          { value0: label, value1: entry.appVersion }
        )
      : translate(
          sourceKeys('unsupported'),
          'Could not read history from {{value0}}: that environment runs an older Orca without the task-history method. Showing what this computer has; retry after it updates.',
          { value0: label }
        )
  }
  if (entry.failure === 'forbidden') {
    return translate(
      sourceKeys('forbidden'),
      'Could not read history from {{value0}}: this app is not allowed to read that environment. Showing what this computer has.',
      { value0: label }
    )
  }
  if (entry.failure === 'repo-unknown') {
    return translate(
      sourceKeys('repoUnknownCurrentRegistration'),
      'Could not read history from {{value0}}: that runtime does not currently know this repository registration, so it could not answer the task-history request. Showing what this computer has.',
      { value0: label }
    )
  }
  if (entry.failure === 'repo-unmatched') {
    return translate(
      sourceKeys('repoUnmatched'),
      "Could not read history from {{value0}}: that environment's repository catalog has no matching registration for this page, so no remote repository id was guessed. Showing what this computer has.",
      { value0: label }
    )
  }
  if (entry.failure === 'repo-ambiguous') {
    return translate(
      sourceKeys('repoAmbiguous'),
      'Could not read history from {{value0}}: several repository registrations match this page, so none was guessed. Showing what this computer has.',
      { value0: label }
    )
  }
  return translate(
    sourceKeys('unreachable'),
    'Could not read history from {{value0}}: it did not answer (timeout or lost connection). Showing what this computer has; this is retryable.',
    { value0: label }
  )
}

export function RecordSourceNotice({
  source
}: {
  source: TaskWorkbenchRecordSource
}): React.JSX.Element | null {
  const rows: { key: string; testId: string; text: string; kind: string }[] = []
  if (source.candidateFailure === 'undetermined') {
    rows.push({
      key: 'candidate-undetermined',
      testId: 'task-workbench-history-source-undetermined',
      text: translate(
        sourceKeys('candidateUndetermined'),
        "Remote task history could not be read because this page's repository could not be matched to a paired environment. No remote repository id was guessed."
      ),
      kind: 'undetermined'
    })
  }
  for (const entry of source.unavailable) {
    rows.push({
      key: `unavailable:${entry.environmentId}`,
      testId: 'task-workbench-history-source-unavailable',
      text: unavailableSentence(entry),
      kind: entry.failure
    })
  }
  for (const conflict of source.conflicts) {
    rows.push({
      key: `conflict:${conflict.worktreeId}`,
      testId: 'task-workbench-history-source-conflict',
      text: translate(
        sourceKeys('conflict'),
        'Two profiles describe workspace {{value0}} differently ({{value1}}); showing {{value2}}.',
        {
          value0: conflict.worktreeId,
          value1: conflict.fields.join(', '),
          value2: conflict.kept ?? translate(sourceKeys('keptLocal'), 'this computer')
        }
      ),
      kind: 'conflict'
    })
  }
  if (source.answered.length > 0) {
    rows.push({
      key: 'included',
      testId: 'task-workbench-history-source-included',
      text: translate(
        sourceKeys('included'),
        'History also includes what {{value0}} environment(s) recorded.',
        { value0: String(source.answered.length) }
      ),
      kind: 'included'
    })
  }
  if (source.pending && source.environmentIds.length > 0) {
    rows.push({
      key: 'pending',
      testId: 'task-workbench-history-source-pending',
      text: translate(
        sourceKeys('pending'),
        'Still reading {{value0}} environment(s); more history may arrive.',
        { value0: String(source.environmentIds.length) }
      ),
      kind: 'pending'
    })
  }
  if (rows.length === 0) {
    return null
  }
  return (
    <ul
      data-testid="task-workbench-history-record-sources"
      className="flex flex-col gap-0.5 text-[12px] text-muted-foreground"
    >
      {rows.map((row) => (
        <li key={row.key} data-testid={row.testId} data-source-state={row.kind}>
          {row.text}
        </li>
      ))}
    </ul>
  )
}
