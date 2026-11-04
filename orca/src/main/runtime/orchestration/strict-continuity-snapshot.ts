import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { hashCanonical } from '../rpc/orchestration-mutation-receipt'
import { OrchestrationError } from './orchestration-error'

const Row = z.object({ name: z.string(), sql: z.string().nullable() })
const EXCLUDED_TABLES = new Set(['strict_continuity_database', 'strict_continuity_seals'])
const MAX_ROWS = 100_000
const MAX_BYTES = 64 * 1024 * 1024

function tooLarge(): never {
  throw new OrchestrationError(
    'strict_continuity_required',
    'Database snapshot exceeds continuity limits'
  )
}

// Conservative first stage: any unrelated database write invalidates the seal too.
export function strictContinuitySnapshot(db: Pick<OrchestrationDb, 'db'>): string {
  const schema = z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        tbl_name: z.string(),
        sql: z.string().nullable()
      })
    )
    .parse(
      db.db
        .prepare(`SELECT type, name, tbl_name, sql FROM main.sqlite_master
      WHERE name NOT GLOB 'sqlite_*' OR name = 'sqlite_sequence' ORDER BY type, name`)
        .all()
    )
  const tables = z
    .array(Row)
    .parse(schema.filter((row) => row.type === 'table' && !EXCLUDED_TABLES.has(row.name)))
  const shapes = z
    .array(z.object({ schema: z.string(), name: z.string(), wr: z.number(), type: z.string() }))
    .parse(db.db.pragma('table_list'))
  let bytes = 0
  let count = 0
  const contents = tables.map(({ name }) => {
    const identifier = `"${name.replaceAll('"', '""')}"`
    const shape = shapes.find((table) => table.schema === 'main' && table.name === name)
    if (!shape || shape.type !== 'table') {
      throw new OrchestrationError('strict_continuity_required', 'Unsupported snapshot table')
    }
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(db.db.pragma(`main.table_xinfo(${identifier})`))
    const names = new Set(columns.map((column) => column.name.toLowerCase()))
    const rowid = ['rowid', '_rowid_', 'oid'].find((candidate) => !names.has(candidate))
    if (!shape.wr && (!rowid || names.has('__continuity_rowid__'))) {
      throw new OrchestrationError('strict_continuity_required', 'Snapshot rowid is shadowed')
    }
    const statement = db.db.prepare(
      `SELECT ${shape.wr ? '' : `${rowid} AS __continuity_rowid__, `}* FROM main.${identifier}`
    )
    statement.setReadBigInts(true)
    const rows: string[] = []
    for (const row of statement.iterate()) {
      // Type tags preserve SQLite integer/blob identity without JSON bigint loss.
      const fields = Object.keys(row)
        .sort()
        .map((key) => {
          const value = row[key]
          return [
            key,
            typeof value,
            value instanceof Uint8Array
              ? { blobHex: Buffer.from(value).toString('hex') }
              : typeof value === 'bigint'
                ? value.toString()
                : value
          ]
        })
      bytes += Buffer.byteLength(JSON.stringify(fields))
      if (++count > MAX_ROWS || bytes > MAX_BYTES) {
        tooLarge()
      }
      rows.push(hashCanonical(fields))
    }
    return { table: name, rows: rows.sort() }
  })
  return hashCanonical({ schema, contents })
}
