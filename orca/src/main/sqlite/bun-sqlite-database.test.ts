/**
 * The handle Bun is given (issue found by the §17 item 25 live check).
 *
 * The incident read paths open a quiescent store as `file://…?immutable=1`. Encoding that string as a
 * path escapes the `?`, SQLite then opens a filename that does not exist, and every bun build —
 * including the deployed one — answered `orca incident list` with "unable to open database file".
 * These are the only two shapes the driver sees; both must reach SQLite byte-for-byte.
 */
import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { sqliteTarget } from './bun-sqlite-database'

describe('sqliteTarget', () => {
  it('passes an in-memory or empty handle through untouched', () => {
    expect(sqliteTarget(':memory:')).toBe(':memory:')
    expect(sqliteTarget('')).toBe('')
  })

  it('encodes a plain filesystem path as a file URI', () => {
    const target = sqliteTarget('/var/lib/orca/incidents/incidents.db')
    expect(target).toBe('file:///var/lib/orca/incidents/incidents.db')
  })

  it('leaves a caller-supplied file URI — including its query — unescaped', () => {
    const immutable = `${pathToFileURL('/var/lib/orca/incidents/incidents.db').href}?immutable=1`
    expect(sqliteTarget(immutable)).toBe(immutable)
    expect(sqliteTarget(immutable)).not.toContain('%3F')
  })
})
