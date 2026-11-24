import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema,
  type HistoryBackfillResponse
} from '../../shared/history-backfill-command'
import { EMPTY_TASK_RECORDS, type TaskRecordsState } from '../../shared/task-records-types'
import { upsertTaskRecordBinding } from '../../shared/task-records-updates'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'

/**
 * The settlement half of F3, checked where it actually happened: in a real process.
 *
 * `orca history backfill` runs in a headless preflight launch, and on a server-only host
 * that process has no window, no server and — while the scan is pending — no ref'd
 * handle. The AI Vault client unrefs every timer it owns (the ready deadline, the call
 * deadline, the restart delay), so a scan that never answers used to let Node drain the
 * event loop and exit 0 with no result line: a fake success for a write that never
 * happened. The two arms below pin both halves of the fix:
 *
 * - the preflight now refuses, with the prefixed result line the CLI parses and a
 *   non-zero exit, because a missing scan entry is typed and the deadline is ref'd;
 * - a client request that cannot spawn now settles instead of outliving the process.
 *
 * The harness runs through jiti because it has to import these sources as they are; it is
 * written into a temp dir and executed with the install root (argv[1]'s directory, which
 * is where orcad looks for the scanner entry) pointing at a directory that has none.
 *
 * Baseline for the record, measured on `HEAD` before this change with the same harness:
 * arm 1 exited **0** with empty stdout and an unchanged database, and arm 3 exited **0**
 * with empty stdout (the request was requeued behind an unref'd restart timer and never
 * settled). That is the defect; these assertions are the regression.
 */

const REPO_ROOT = process.cwd()
const JITI_CLI = join(REPO_ROOT, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/repos/app'
const TASK_ID = 'task:github:repo-1:issue:53'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-backfill-exit-')))
  directories.push(directory)
  return directory
}

function stateWithArchivedBinding(): TaskRecordsState {
  const written = upsertTaskRecordBinding(EMPTY_TASK_RECORDS, {
    taskId: TASK_ID,
    hostId: 'local',
    repoId: REPO_ID,
    worktreeId: `${REPO_ID}::${WORKTREE_PATH}`,
    path: WORKTREE_PATH,
    isArchived: true,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 53 },
    now: 1_000,
    boundBy: 'user'
  })
  if (!written.ok) {
    throw new Error('fixture could not bind the workspace')
  }
  const record = written.state.byId[TASK_ID]
  return {
    ...written.state,
    byId: { ...written.state.byId, [TASK_ID]: { ...record, schemaVersion: 1 } }
  }
}

/** A throwaway userData tree with the archived binding this command backfills. */
function userData(): { root: string; databaseFile: string; profileId: string; before: string } {
  const root = workspace()
  const profileId = 'p'
  mkdirSync(join(root, 'profiles', profileId), { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const databaseFile = join(root, 'profiles', profileId, 'profile-state.db')
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    importProfileStateJson(
      opened.db,
      JSON.stringify({
        repos: [{ id: REPO_ID, path: WORKTREE_PATH }],
        taskRecords: stateWithArchivedBinding()
      })
    )
  } finally {
    opened.db.close()
  }
  return { root, databaseFile, profileId, before: stored(databaseFile, profileId) }
}

function stored(databaseFile: string, profileId: string): string {
  const opened = openProfileStateDatabaseReadOnly(databaseFile, profileId)
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

/** The harness that runs the real orcad preflight. It lives in the install root, which is
 *  where orcad resolves `argv[1]` from and therefore where it looks for the scanner entry
 *  (`<root>/out/main/session-scanner-service-entry.js`) — a directory with no `out/`. */
function writeBackfillHarness(): string {
  const harness = join(workspace(), 'orcad.js.ts')
  writeFileSync(
    harness,
    [
      "import process from 'node:process'",
      `const REPO = ${JSON.stringify(REPO_ROOT)}`,
      'const { installOrcadHostAdapters } = await import(`${REPO}/src/main/orcad/orcad-entry.ts`)',
      'const { runOrcadHistoryBackfillPreflight } = await import(',
      '  `${REPO}/src/main/orcad/orcad-history-backfill-preflight.ts`',
      ')',
      'installOrcadHostAdapters()',
      'const [userDataPath] = process.argv.slice(2)',
      'runOrcadHistoryBackfillPreflight([',
      "  'node',",
      '  process.argv[1],',
      "  '--serve',",
      "  '--history-backfill',",
      '  JSON.stringify({',
      '    userDataPath,',
      "    task: { repo: { kind: 'auto', value: 'repo-1' }, number: 53 }",
      '  })',
      '])',
      ''
    ].join('\n')
  )
  return harness
}

/** The harness that asks the real client for one scan through the real spawner. It never
 *  writes a result line; only its exit code says whether the request settled with the
 *  missing-entry answer (3) or not at all (0, the pre-fix drain). */
function writeClientHarness(): string {
  const harness = join(workspace(), 'client-harness.ts')
  writeFileSync(
    harness,
    [
      "import process from 'node:process'",
      `const REPO = ${JSON.stringify(REPO_ROOT)}`,
      'const { AiVaultScannerServiceClient } = await import(',
      '  `${REPO}/src/main/ai-vault/session-scanner-service-client.ts`',
      ')',
      'const { spawnAiVaultServiceProcess } = await import(',
      '  `${REPO}/src/main/ai-vault/session-scanner-service-spawn.ts`',
      ')',
      'const client = new AiVaultScannerServiceClient({',
      '  processFactory: spawnAiVaultServiceProcess,',
      '  init: () => ({ sessionParseCache: null, sessionSearch: null })',
      '})',
      "void client.request({ type: 'request', operation: 'titles', requests: [] }).then(",
      '  () => {',
      '    process.exitCode = 2',
      '  },',
      '  (error: unknown) => {',
      '    const message = String((error as Error | undefined)?.message)',
      "    process.exitCode = message.includes('entry not found') ? 3 : 4",
      '  }',
      ')',
      ''
    ].join('\n')
  )
  return harness
}

/** jiti has to be importable, or the process-level check cannot run at all. */
function runHarness(
  harness: string,
  args: string[],
  env: NodeJS.ProcessEnv
): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(process.execPath, [JITI_CLI, harness, ...args], {
    // The harness's own directory is the install root: no `out/main/`, exactly like a
    // server-only install that ships no scanner entry.
    cwd: dirname(harness),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function refusalLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.startsWith(HISTORY_BACKFILL_RESULT_PREFIX))
}

function refusal(stdout: string): HistoryBackfillResponse {
  const lines = refusalLines(stdout)
  expect(lines).toHaveLength(1)
  return historyBackfillResponseSchema.parse(
    JSON.parse(lines[0]!.slice(HISTORY_BACKFILL_RESULT_PREFIX.length))
  )
}

describe('history backfill preflight on a server-only host', () => {
  it('refuses a missing scan entry with a prefixed line and a non-zero exit', () => {
    const item = userData()
    const harness = writeBackfillHarness()

    const result = runHarness(harness, [item.root], {
      ORCA_AI_VAULT_SERVICE_PROCESS: '1'
    })

    // The defect was exit 0 + empty stdout here. Now the CLI has a result line to
    // print and a failure code to honor.
    expect(result.status).toBe(1)
    expect(refusalLines(result.stdout)).toHaveLength(1)
    const refused = refusal(result.stdout)
    expect(refused).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining(
        `AI Vault service entry not found: ${join(dirname(harness), 'out', 'main', 'session-scanner-service-entry.js')}`
      )
    })
    if (refused.ok) {
      throw new Error('expected a refusal')
    }
    expect(refused.message).toContain('Nothing was written')
    // And the refusal is honest: the stored payload is byte-for-byte what it was.
    expect(stored(item.databaseFile, item.profileId)).toBe(item.before)
  }, 60_000)

  it('refuses the same way through the legacy worker backend', () => {
    const item = userData()

    const result = runHarness(writeBackfillHarness(), [item.root], {
      ORCA_AI_VAULT_SERVICE_PROCESS: '0'
    })

    // One refusal vocabulary, whichever scan backend the host selects: both spawners
    // throw the same typed answer, so the backfill cannot be "successful" on one.
    expect(result.status).toBe(1)
    expect(refusal(result.stdout)).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('AI Vault scanner worker entry not found')
    })
    expect(stored(item.databaseFile, item.profileId)).toBe(item.before)
  }, 60_000)

  it('settles a request that cannot spawn instead of outliving the process', () => {
    const result = runHarness(writeClientHarness(), [], {})

    // Baseline was 0 (the request was requeued behind an unref'd restart timer and the
    // loop drained). 3 means the rejection reached the caller before the process ended;
    // a headless caller can therefore never wait on a promise nothing will settle.
    expect(result.status).toBe(3)
    // The client writes no result line of its own — silence here is not success.
    expect(result.stdout).toBe('')
  }, 60_000)
})
