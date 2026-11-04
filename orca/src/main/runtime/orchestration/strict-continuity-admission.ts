import { lstatSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import { assertStrictContinuitySchema } from './db/schema/strict-continuity-schema'

export class StrictContinuityAdmissionError extends Error {
  readonly code = 'strict_continuity_required'

  constructor(message: string, options?: ErrorOptions) {
    super(`strict_continuity_required: ${message}`, options)
    this.name = 'StrictContinuityAdmissionError'
  }
}

/** Run before migrations, backfills or runtime restoration, including expired seals. */
export function assertStrictContinuityDatabaseWritable(db: Database.Database): void {
  try {
    assertStrictContinuitySchema(db, true)
  } catch (error) {
    throw new StrictContinuityAdmissionError('Continuity schema changed or incomplete', {
      cause: error
    })
  }
  for (const table of ['strict_continuity_database', 'strict_continuity_seals']) {
    const schema = db.prepare('SELECT type FROM main.sqlite_master WHERE name = ?').get(table)
    if (
      schema &&
      (schema.type !== 'table' || db.prepare(`SELECT 1 FROM main.${table} LIMIT 1`).get())
    ) {
      throw new StrictContinuityAdmissionError(
        'Database is sealed; normal startup is disabled. Preserve its history; reviewed cross-runtime resume is not yet available.'
      )
    }
  }
}

/** Read-only admission does not initialize a missing database or grant continuity. */
export function assertStrictContinuityStartup(dbPath: string): void {
  try {
    lstatSync(dbPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw new StrictContinuityAdmissionError('Cannot inspect the database path', { cause: error })
  }
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    assertStrictContinuityDatabaseWritable(db)
  } catch (error) {
    if (error instanceof StrictContinuityAdmissionError) {
      throw error
    }
    throw new StrictContinuityAdmissionError('Read-only database admission failed', {
      cause: error
    })
  } finally {
    db?.close()
  }
}
