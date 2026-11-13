// Pulling incident facts from other hosts (issue-sedimentation.md §11.1, M7-C).
//
// THE BOUNDARY, stated once where the code is: the host that holds the PTY writes its own incident
// facts; this host only mirrors what the origin exported. It assigns no new meaning to a remote row,
// rewrites no `host_id`, and never records its own guess as a remote fact. The only facts it asserts
// on its own are about the *link*, and those live in `incident_mirror_links` (see
// incident-mirror-store.ts) and reach the read model through `readIncidentMirrorCoverage`.
//
// THE WIRE IS THE SHADOW LINE. A page carries `v: 2` shadow lines — the format the origin already
// validated and the local replay already parses (`incident-shadow-line.ts`). Reusing it means one
// validation path, one version gate, and no second schema to keep in step with §6.2.
//
// THE CURSOR IS THE ORIGIN'S `seq`, the same monotonic watermark the local replay uses. It is a
// progress marker and an optimization, never a correctness requirement: the store's
// `UNIQUE(source_kind, source_id, facet)` absorbs a re-offered page, so losing the cursor costs time,
// not records. A reconnect therefore just calls this again with the same feed.
//
// FAILURE VISIBILITY. Every way a pull can stop is named in `MirrorStopReason`, written to the link
// row, and printed by `orca incident mirror`. A failed probe keeps the last cursor and the last
// origin-stated unsynced count instead of zeroing them.

import type Database from '../sqlite/sync-database'
import { incidentRecordFromShadowLine, ShadowRecordError, shadowLineSeq } from './incident-shadow-line'
import type { IncidentStore } from './incident-store'
import {
  ensureMirrorLink,
  insertMirroredIncident,
  readMirrorCursor,
  recordMirrorProbeFailure,
  recordMirrorProbeSuccess,
  type MirrorProbeOutcome
} from './incident-mirror-store'

/** How many lines one request may return. A big backlog is many pages, not one blob. */
export const DEFAULT_MIRROR_PAGE_SIZE = 200

/**
 * Per-host work budget for one pass.
 *
 * Same reasoning as the shadow replay's budget (M2-C6): a reconnect after a long offline period must
 * not synchronously chew through a huge backlog on the path that is also handling window startup. The
 * pass stops with `budget`, keeps its cursor, and the next reconnect continues.
 */
export const DEFAULT_MIRROR_MAX_LINES_PER_HOST = 5_000

/**
 * Page budget for one pass, the backstop for the line budget: a feed whose pages keep advancing the
 * cursor without offering any line cannot be stopped by a line count, and "the origin keeps saying
 * hasMore" must not become "the startup turn never ends".
 */
export const DEFAULT_MIRROR_MAX_PAGES_PER_HOST = 200

/** One page of origin rows, in the origin's export order. */
export type MirrorPage = {
  /** `v: 2` shadow lines, oldest first. Each line carries its own origin `seq`. */
  lines: string[]
  /** Highest origin seq this page covers; the next request starts strictly after it. */
  nextSeq: number
  /** The origin has rows past `nextSeq` that this page did not include. */
  hasMore: boolean
  /**
   * The origin's own count of its rows with `seq > nextSeq`. `null` when it cannot say — the read
   * model reports that as unknown rather than as 0.
   */
  pending: number | null
}

/**
 * A remote origin as this client sees it.
 *
 * `read` is allowed to be asynchronous because a real transport (SSH relay, local socket) is. No
 * transport ships with this change: a feed is registered by whatever owns the link (the relay, when
 * it lands), so this module never opens a connection on its own and never reads a path it was not
 * handed. A feed may only speak for the host in its `hostId`.
 */
export type MirrorFeed = {
  hostId: string
  read: (request: { afterSeq: number; limit: number }) => MirrorPage | Promise<MirrorPage>
}

export type MirrorStopReason =
  /** The feed threw (link down, timeout, transport error). */
  | 'feed_error'
  /** A line is not JSON, or not an object. */
  | 'unparsable_json'
  /** The origin wrote a format version this build does not know: stop, never guess. */
  | 'unsupported_version'
  /** The line cannot be rebuilt into a record (missing key, unknown class/status). */
  | 'invalid_record'
  /** The page contradicts itself (nextSeq behind the cursor, a line past nextSeq). */
  | 'page_mismatch'
  /** The feed offered a record whose `host_id` is not this feed's host. Refused, not re-filed. */
  | 'foreign_host'
  /** The store cannot take the write (read-only, or a crash row the capacity gate refused). */
  | 'store_refused'
  /** Per-host line budget reached; the cursor is kept and the next pass continues. */
  | 'budget'

export type MirrorStop = { reason: MirrorStopReason; detail?: string }

export type MirrorHostSync = {
  hostId: string
  /** Cursor before / after this pass. */
  cursorBefore: number
  cursorAfter: number
  inserted: number
  duplicates: number
  /** Duplicate deliveries that came from a different origin than the first one. */
  crossOriginDuplicates: number
  /** Keys this host already owns locally; the mirror refused and counted them. */
  rejected: number
  /** Facts this link mirrored before and an operator pruned; not resurrected. */
  pruned: number
  /** Non-crash rows the capacity gate refused; counted on the link, not inserted. */
  dropped: number
  /** Origin-stated rows still past the cursor after this pass; NULL = not stated. */
  pending: number | null
  stopped: MirrorStop | null
  /** `false` when no page was read at all (the link was never reached). */
  reachedOrigin: boolean
  error: string | null
}

export type MirrorSyncSummary = {
  /** `false` when nothing was registered, so nothing was attempted (not a success, not a failure). */
  ran: boolean
  hosts: MirrorHostSync[]
  inserted: number
  duplicates: number
  rejected: number
  pruned: number
  dropped: number
  elapsedMs: number
}

const MAX_ERROR_CHARS = 300

function errorText(error: unknown): string {
  if (error instanceof ShadowRecordError) {
    return `${error.reason}: ${error.message}`.slice(0, MAX_ERROR_CHARS)
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, MAX_ERROR_CHARS)
  }
  return 'unknown_error'
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

type PageValidation =
  | { ok: true; seqs: number[] }
  | {
      ok: false
      stop: MirrorStop
      /**
       * The lines of this page that may still be applied before stopping.
       *
       * A line this build cannot read (bad JSON, unknown version, unrebuildable record) does not
       * invalidate the lines before it: they were read and ordered, so applying them keeps the same
       * "stop at the last good seq" behaviour the shadow replay has (§11.2).
       *
       * A page that lies about its own order or bounds invalidates ALL of it: if `[3, 1, 2]` were
       * half-applied the cursor would sit on 3 and 1/2 would be skipped forever, so the page is
       * discarded whole.
       */
      apply: number[]
    }

/**
 * Validate a whole page BEFORE applying any of it.
 *
 * Two rules, both about the one failure the cursor must not have — jumping past rows that were never
 * read, because a skipped range is invisible:
 *
 *   * the page's `seq`s must be strictly increasing and start after the cursor. `afterSeq` is the
 *     request, so a page that re-offers an old row or reorders rows is not "harmless overlap": with
 *     an apply-as-you-go loop, `[3, 1, 2]` would move the cursor to 3 and then skip 1 and 2 forever;
 *   * a page that claims `hasMore` must cover at least one new seq. A feed that answers
 *     `{lines: [], hasMore: true, nextSeq: cursor}` is a livelock: no line budget can ever stop it
 *     because no line is handled.
 *
 * Validating the whole page first is what makes "stop without a partial apply" true: a bad page costs
 * its own range, never half of it.
 */
function validatePage(page: MirrorPage, cursor: number): PageValidation {
  if (!Array.isArray(page.lines) || page.lines.some((line) => typeof line !== 'string')) {
    return { ok: false, stop: { reason: 'page_mismatch', detail: 'lines_not_strings' }, apply: [] }
  }
  if (!Number.isSafeInteger(page.nextSeq) || page.nextSeq < cursor) {
    return {
      ok: false,
      stop: {
        reason: 'page_mismatch',
        detail: `next_seq_${String(page.nextSeq)}_behind_cursor_${cursor}`
      },
      apply: []
    }
  }
  if (page.pending !== null && !isCount(page.pending)) {
    return { ok: false, stop: { reason: 'page_mismatch', detail: 'pending_not_a_count' }, apply: [] }
  }
  const seqs: number[] = []
  let previous = cursor
  for (const line of page.lines) {
    let seq: number
    try {
      seq = shadowLineSeq(line)
    } catch (error) {
      // A line-level failure: everything before it is still ordered and readable.
      return {
        ok: false,
        stop: {
          reason: error instanceof ShadowRecordError ? error.reason : 'unparsable_json',
          detail: errorText(error)
        },
        apply: seqs
      }
    }
    if (seq <= previous) {
      return {
        ok: false,
        stop: { reason: 'page_mismatch', detail: `seq_${seq}_not_after_${previous}` },
        apply: []
      }
    }
    if (seq > page.nextSeq) {
      return {
        ok: false,
        stop: {
          reason: 'page_mismatch',
          detail: `line_seq_${seq}_past_next_${page.nextSeq}`
        },
        apply: []
      }
    }
    previous = seq
    seqs.push(seq)
  }
  if (page.hasMore && seqs.length === 0) {
    return { ok: false, stop: { reason: 'page_mismatch', detail: 'no_progress_page' }, apply: [] }
  }
  return { ok: true, seqs }
}

type PullState = {
  cursor: number
  inserted: number
  duplicates: number
  crossOriginDuplicates: number
  rejected: number
  pruned: number
  dropped: number
  handled: number
  pagesRead: number
  pending: number | null
  lastRejectedReason: string | null
  stop: MirrorStop | null
}

/**
 * Pull one origin host.
 *
 * Returned rather than logged: the caller owns the durable write and the caller's test owns the
 * assertion. Side effects here are the store insert, the provenance row and the link-row update.
 */
async function pullHost(options: {
  store: IncidentStore
  db: Database.Database
  feed: MirrorFeed
  now: () => number
  pageSize: number
  maxLines: number
  maxPages: number
}): Promise<MirrorHostSync> {
  const { store, db, feed, now, pageSize, maxLines, maxPages } = options
  const probeAt = now()
  const cursorBefore = readMirrorCursor(db, feed.hostId)
  const state: PullState = {
    cursor: cursorBefore,
    inserted: 0,
    duplicates: 0,
    crossOriginDuplicates: 0,
    rejected: 0,
    pruned: 0,
    dropped: 0,
    handled: 0,
    pagesRead: 0,
    pending: null,
    lastRejectedReason: null,
    stop: null
  }

  while (state.stop === null) {
    if (state.handled >= maxLines) {
      state.stop = { reason: 'budget', detail: `handled=${state.handled}` }
      break
    }
    if (state.pagesRead >= maxPages) {
      state.stop = { reason: 'budget', detail: `pages=${state.pagesRead}` }
      break
    }
    let page: MirrorPage
    try {
      page = await feed.read({ afterSeq: state.cursor, limit: pageSize })
    } catch (error) {
      state.stop = { reason: 'feed_error', detail: errorText(error) }
      break
    }
    // The origin answered: it was reached even if the page is later refused.
    state.pagesRead += 1
    const validation = validatePage(page, state.cursor)
    const seqs = validation.ok ? validation.seqs : validation.apply
    // Held until the loop is done: the readable prefix is applied in THIS pass, and the page's own
    // verdict becomes the stop reason only if no earlier stop (the line budget) already fired.
    const pageStop = validation.ok ? null : validation.stop
    for (const [index, line] of page.lines.entries()) {
      if (index >= seqs.length) {
        // Past the lines this page is allowed to contribute (see `PageValidation.apply`).
        break
      }
      const seq = seqs[index]
      if (state.handled >= maxLines) {
        // Budget reached mid-page. Everything from this line on is unapplied and known, so the
        // unsynced count is a real number when the origin also stated its own remainder. A page
        // already refused for a protocol reason keeps that reason: it is why we cannot go on.
        if (state.stop === null) {
          const unappliedHere = page.lines.length - index
          state.pending = page.pending === null ? null : unappliedHere + page.pending
          state.stop = { reason: 'budget', detail: `handled=${state.handled}` }
        }
        break
      }
      let record: ReturnType<typeof incidentRecordFromShadowLine>
      try {
        record = incidentRecordFromShadowLine(line)
      } catch (error) {
        state.stop = {
          reason: error instanceof ShadowRecordError ? error.reason : 'invalid_record',
          detail: errorText(error)
        }
        break
      }
      let result: ReturnType<typeof insertMirroredIncident>
      try {
        result = insertMirroredIncident({
          store,
          db,
          record,
          originHostId: feed.hostId,
          originSeq: seq,
          pulledAt: probeAt
        })
      } catch (error) {
        // A throwing store is a store failure, not a fact: stop and keep the cursor where it was.
        state.stop = { reason: 'store_refused', detail: errorText(error) }
        break
      }
      switch (result.outcome) {
        case 'inserted':
          state.inserted += 1
          state.cursor = seq
          state.handled += 1
          break
        case 'duplicate':
          state.duplicates += 1
          if (result.mirroredByHostId !== null && result.mirroredByHostId !== undefined &&
              result.mirroredByHostId !== feed.hostId) {
            // Two origins exported the same fact. One row (as it should be), but the overlap is a
            // real observation, so it is counted rather than hidden inside "duplicates".
            state.crossOriginDuplicates += 1
          }
          state.cursor = seq
          state.handled += 1
          break
        case 'local_owner_conflict':
          // The key is already a row this host wrote. One fact, one row: skip it durably instead of
          // blocking the whole host on a line that will never become insertable.
          state.rejected += 1
          state.lastRejectedReason = `key_owned_locally:${record.sourceKind}/${record.facet}`
          state.cursor = seq
          state.handled += 1
          break
        case 'pruned_locally':
          // An operator deleted this fact here. A mirror must not resurrect it; the tombstone is the
          // provenance row, and the refusal is counted so "why is this origin row absent" is answerable.
          state.pruned += 1
          state.lastRejectedReason = `pruned_locally:${record.sourceKind}/${record.facet}`
          state.cursor = seq
          state.handled += 1
          break
        case 'host_mismatch':
          // A protocol violation, not a data point: stop before advancing so the cursor does not
          // claim a range the store refused to take.
          state.stop = { reason: 'foreign_host', detail: result.reason ?? 'host_mismatch' }
          break
        case 'invalid_record':
          state.stop = { reason: 'invalid_record', detail: result.reason ?? 'invalid_record' }
          break
        case 'capacity_limited':
          if (record.class === 'crash') {
            // Crash rows bypass the noise gate, so this means the store cannot write at all.
            state.stop = {
              reason: 'store_refused',
              detail: `capacity_limited:${result.limitedBy ?? 'unknown'}`
            }
            break
          }
          // Same policy as the shadow replay (M2-C3): a refused noise line is dropped durably and the
          // pull continues, so a noisy backlog cannot hide a later crash.
          state.dropped += 1
          state.cursor = seq
          state.handled += 1
          break
        case 'read_only':
          state.stop = { reason: 'store_refused', detail: 'read_only' }
          break
        case 'provenance_failed':
          // The incident row landed but its provenance did not. Stopping here (instead of advancing)
          // keeps the line retryable, and the retry recognises the row by its origin host_id and
          // heals the provenance rather than misreporting it as a local conflict.
          state.stop = {
            reason: 'store_refused',
            detail: `provenance_failed:${result.reason ?? 'unknown'}`
          }
          break
      }
      if (state.stop !== null) {
        break
      }
    }
    if (state.stop === null && pageStop !== null) {
      state.stop = pageStop
    }
    if (state.stop !== null) {
      break
    }
    // The page was consumed. `nextSeq` may be ahead of the last line's seq when the origin chose not
    // to export a row (e.g. its own capacity drop); it is the origin's progress marker, and the next
    // request starts strictly after it.
    state.cursor = Math.max(state.cursor, page.nextSeq)
    state.pending = page.pending
    if (!page.hasMore) {
      break
    }
  }

  const reachedOrigin = state.pagesRead > 0
  const operational = state.stop === null || state.stop.reason === 'budget'
  const ms = Math.max(0, now() - probeAt)
  const error =
    reachedOrigin && operational
      ? null
      : `${state.stop?.reason ?? 'unreachable'}${
          state.stop?.detail ? `: ${state.stop.detail}` : ''
        }`
  const outcome: MirrorProbeOutcome = {
    hostId: feed.hostId,
    now: now(),
    cursor: state.cursor,
    pending: state.pending,
    inserted: state.inserted,
    duplicates: state.duplicates,
    rejected: state.rejected,
    dropped: state.dropped,
    pruned: state.pruned,
    lastRejectedReason: state.lastRejectedReason,
    lines: state.handled,
    ms
  }
  if (reachedOrigin && operational) {
    recordMirrorProbeSuccess(db, outcome)
  } else {
    // A stop before the first page is a link failure; a stop after some pages is a protocol or store
    // failure. Both keep the cursor and the retained unsynced count where they were.
    recordMirrorProbeFailure(db, {
      hostId: feed.hostId,
      now: outcome.now,
      error: error ?? 'unreachable',
      lines: state.handled,
      ms,
      cursor: state.cursor
    })
  }
  return {
    hostId: feed.hostId,
    cursorBefore,
    cursorAfter: state.cursor,
    inserted: state.inserted,
    duplicates: state.duplicates,
    crossOriginDuplicates: state.crossOriginDuplicates,
    rejected: state.rejected,
    pruned: state.pruned,
    dropped: state.dropped,
    pending: state.pending,
    stopped: state.stop,
    reachedOrigin,
    error
  }
}

/**
 * One sync pass over every registered origin.
 *
 * Safe to call on startup and again on every reconnect: the second call starts at the stored cursor
 * and the store's UNIQUE key makes a re-offered range a no-op. One broken feed never blocks another —
 * hosts are independent, and each host's outcome is reported separately.
 */
export async function syncIncidentMirror(options: {
  store: IncidentStore
  db: Database.Database
  feeds: readonly MirrorFeed[]
  now?: () => number
  pageSize?: number
  maxLinesPerHost?: number
  maxPagesPerHost?: number
}): Promise<MirrorSyncSummary> {
  const now = options.now ?? (() => Date.now())
  const pageSize = options.pageSize ?? DEFAULT_MIRROR_PAGE_SIZE
  const maxLinesPerHost = options.maxLinesPerHost ?? DEFAULT_MIRROR_MAX_LINES_PER_HOST
  const maxPagesPerHost = options.maxPagesPerHost ?? DEFAULT_MIRROR_MAX_PAGES_PER_HOST
  const startedAt = now()
  const hosts: MirrorHostSync[] = []
  for (const feed of options.feeds) {
    // Register before the first read so a probe that dies mid-flight is still a known host with a
    // link row (`not_probed`), never a host that silently does not exist.
    ensureMirrorLink(options.db, feed.hostId, now())
    hosts.push(
      await pullHost({
        store: options.store,
        db: options.db,
        feed,
        now,
        pageSize,
        maxLines: maxLinesPerHost,
        maxPages: maxPagesPerHost
      })
    )
  }
  return {
    ran: hosts.length > 0,
    hosts,
    inserted: hosts.reduce((total, host) => total + host.inserted, 0),
    duplicates: hosts.reduce((total, host) => total + host.duplicates, 0),
    rejected: hosts.reduce((total, host) => total + host.rejected, 0),
    pruned: hosts.reduce((total, host) => total + host.pruned, 0),
    dropped: hosts.reduce((total, host) => total + host.dropped, 0),
    elapsedMs: Math.max(0, now() - startedAt)
  }
}

/**
 * The registry of origin feeds.
 *
 * Deliberately process-local and empty in production today: no transport ships with M7-C, so nothing
 * registers a feed and the read model answers `unsupported`. The SSH relay that owns a remote pane is
 * the component that will register here; it is the only thing that can prove which host a pane's facts
 * belong to. Nothing in this module opens a connection on its own.
 */
const feeds = new Map<string, MirrorFeed>()

export function registerMirrorFeed(feed: MirrorFeed): void {
  feeds.set(feed.hostId, feed)
}

export function unregisterMirrorFeed(hostId: string): void {
  feeds.delete(hostId)
}

export function listMirrorFeeds(): MirrorFeed[] {
  return [...feeds.values()]
}

/** Test seam (house pattern). */
export function __resetMirrorFeedsForTests(): void {
  feeds.clear()
}
