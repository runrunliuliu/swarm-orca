import Database from '../../sqlite/sync-database'
import { getRun, getRunRaw } from './db/runs/run-lookup'

/** Internal sealed-DB inspection: no schema initialization, writer hooks or resume capability. */
export function openStrictContinuityInspection(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  const raw = { db, getRunRaw: (id: string) => getRunRaw.call({ db }, id) }
  return {
    db,
    getRun: (id: string) => getRun.call(raw, id),
    close: () => db.close()
  }
}
