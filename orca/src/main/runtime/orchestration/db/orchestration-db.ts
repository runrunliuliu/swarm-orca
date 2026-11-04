import Database from '../../../sqlite/sync-database'
import { attachOrchestrationDbMethods } from './attach-orchestration-db-methods'
import { hardenOrchestrationDatabaseFiles } from './database-file-permissions'
import { backfillFederatedStubHomeRuns } from './federation/federated-stub-home-run-backfill'
import type { OrchestrationDbMethods } from './orchestration-db-methods'
import {
  createCoordinatorMailRoutingTrigger,
  rememberCurrentRunCoordinatorHandles
} from './runs/run-coordinator-mail-routing'
import { createTables } from './schema/create-tables'
import { migrate } from './schema/migrate'
import { STRICT_COORDINATOR_SCHEMA_SQL } from './schema/strict-coordinator-schema'
import { STRICT_RETIREMENT_SCHEMA_SQL } from './schema/strict-retirement-schema'
import { STRICT_CONTINUITY_SCHEMA_SQL } from './schema/strict-continuity-schema'
import { ADMINISTRATIVE_HISTORY_SCHEMA_SQL } from './schema/administrative-history-schema'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'
import { assertStrictContinuityDatabaseWritable } from '../strict-continuity-admission'
import { hasStrictContinuityResume } from '../strict-continuity-resume'

class OrchestrationDbCore {
  db: Database.Database

  // Why: the orchestration DB is created lazily for ALL users, but only the
  // small minority who dispatch work ever have dispatch_contexts rows. The
  // renderer graph publish rebuilds orchestration context on every 16ms tick
  // (buildAgentOrchestrationByPaneKey), issuing 2 queries per terminal. Cache
  // emptiness so the non-orchestration majority short-circuits the whole
  // per-terminal fan-out. Only createDispatchContext flips this false→true.
  hasAnyDispatchContextsCache: boolean | undefined
  // Strict pins are immutable; initialize on open and update only after createRun commits.
  hasStrictCoordinatorRunsCache: boolean
  hasAdministrativeHistoryFences: boolean
  localMutationCallerFingerprint: string | undefined

  constructor(dbPath: (string & {}) | ':memory:', resume?: (db: Database.Database) => void) {
    this.db = new Database(dbPath, resume ? { fileMustExist: true } : undefined)
    try {
      if (resume) {
        if (this.db.prepare('SELECT 1 FROM administrative_history_permits LIMIT 1').get()) {
          throw new Error('administrative_history_unfinished_permit')
        }
        resume(this.db)
        if (!hasStrictContinuityResume(this.db, true)) throw new Error('strict_continuity_resume_required')
        this.db.pragma('synchronous = FULL')
        this.db.pragma('busy_timeout = 5000')
        // A sealed database is already migrated; restoration must not rewrite its snapshot.
        this.hasAdministrativeHistoryFences = Boolean(
          this.db.prepare('SELECT 1 FROM administrative_history_fences LIMIT 1').get()
        )
        this.hasStrictCoordinatorRunsCache = true
        return
      }
      assertStrictContinuityDatabaseWritable(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    createTables.call(this as unknown as OrchestrationDb)
    migrate.call(this as unknown as OrchestrationDb)
    this.db.exec(STRICT_COORDINATOR_SCHEMA_SQL)
    this.db.exec(STRICT_RETIREMENT_SCHEMA_SQL)
    this.db.exec(STRICT_CONTINUITY_SCHEMA_SQL)
    this.db.exec(ADMINISTRATIVE_HISTORY_SCHEMA_SQL)
    if (this.db.prepare('SELECT 1 FROM administrative_history_permits LIMIT 1').get()) {
      this.db.close()
      throw new Error('administrative_history_unfinished_permit')
    }
    this.hasAdministrativeHistoryFences = Boolean(
      this.db.prepare('SELECT 1 FROM administrative_history_fences LIMIT 1').get()
    )
    this.hasStrictCoordinatorRunsCache = Boolean(
      this.db.prepare('SELECT 1 FROM strict_run_coordinators LIMIT 1').get()
    )
    backfillFederatedStubHomeRuns(this.db)
    backfillStructuredWorkerOrcaSessionIds(this.db)
    createCoordinatorMailRoutingTrigger.call(this as unknown as OrchestrationDb)
    rememberCurrentRunCoordinatorHandles.call(this as unknown as OrchestrationDb)
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  close(): void {
    this.db.close()
  }
}

export type OrchestrationDb = OrchestrationDbCore & OrchestrationDbMethods

attachOrchestrationDbMethods(OrchestrationDbCore)

// Why: attach adds methods on the prototype; oxlint forbids class/interface merging, so the construct type is asserted.
export const OrchestrationDb = OrchestrationDbCore as new (
  dbPath: (string & {}) | ':memory:',
  resume?: (db: Database.Database) => void
) => OrchestrationDb
