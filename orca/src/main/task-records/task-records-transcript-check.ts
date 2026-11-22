import { readTranscriptFileVersion } from '../native-chat/transcript-file-version'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { TaskRecordTranscriptCheck } from '../../shared/task-records-types'
import { isWslUncPath } from '../../shared/wsl-paths'

/**
 * The `stat` behind "locate trace" (issue #53, trace row): the record stores a
 * transcript **path** and one check of it — `dev`/`ino`/`mtimeMs`/`size` — never
 * one byte of content. A reader can tell "still the file the snapshot saw" from
 * "a file is there" without the writer shipping content.
 *
 * The presence vocabulary is copied from
 * `orca/src/main/ai-vault-search/session-search-source-presence.ts`: `present`
 * and `unverifiable` are the honest answers to "can this host see it", and
 * `missing` is written only when a local `stat` proved `ENOENT`. Every other
 * outcome — a remote owner whose files are not on this machine, a WSL UNC path
 * answered by the gated process rather than by this host's own syscall, EACCES,
 * an unknown error — is `unverifiable`, because "I could not look" is not
 * evidence that the trace is gone.
 */
export type TranscriptCheckProbe = (args: {
  path: string
  /** The owner of the workspace whose transcript this is. Only the local host can
   *  answer for a path on its own disk. */
  hostId: ExecutionHostId
}) => Promise<TaskRecordTranscriptCheck>

/** The production probe: `readTranscriptFileVersion` routes a WSL UNC path
 *  through the gated fs process and a local path through one `stat`. */
export function createTranscriptCheckProbe(now: () => number = Date.now): TranscriptCheckProbe {
  return async ({ path, hostId }) => {
    const checkedAt = now()
    // A host that does not own the file cannot answer for it: off-local, a `stat`
    // of that path either fails or — worse — hits an unrelated local file that
    // happens to share it, so the check is not attempted at all.
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return { checkedAt, presence: 'unverifiable' }
    }
    try {
      const version = await readTranscriptFileVersion(path)
      const { dev, ino } = parseFileIdentity(version.identity)
      return {
        checkedAt,
        presence: 'present',
        ...(dev === undefined ? {} : { dev }),
        ...(ino === undefined ? {} : { ino }),
        mtimeMs: version.mtimeMs,
        size: version.size
      }
    } catch (error) {
      // `isWslUncPath` first: the gate relays another filesystem's answer, so even
      // its ENOENT is not this host's own syscall (`session-search-source-presence`).
      if (isWslUncPath(path)) {
        return { checkedAt, presence: 'unverifiable' }
      }
      return errorCode(error) === 'ENOENT'
        ? { checkedAt, presence: 'missing' }
        : { checkedAt, presence: 'unverifiable' }
    }
  }
}

/** `<dev>:<ino>` as `readTranscriptFileVersion` renders it. An identity this build
 *  cannot split leaves both values absent, which the type defines as "unknown,
 *  never 0". */
function parseFileIdentity(identity: string): { dev?: number; ino?: number } {
  const separator = identity.indexOf(':')
  if (separator <= 0) {
    return {}
  }
  const dev = Number(identity.slice(0, separator))
  const ino = Number(identity.slice(separator + 1))
  return {
    ...(Number.isFinite(dev) ? { dev } : {}),
    ...(Number.isFinite(ino) ? { ino } : {})
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
