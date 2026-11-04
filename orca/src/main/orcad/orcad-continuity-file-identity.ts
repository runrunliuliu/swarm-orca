import { lstatSync } from 'node:fs'

export function continuityFileIdentity(path: string, directory = false) {
  const uid = process.getuid?.()
  const info = lstatSync(path, { bigint: true })
  if (
    process.platform !== 'linux' ||
    uid === undefined ||
    !(directory ? info.isDirectory() : info.isFile()) ||
    info.ino <= 0n ||
    (info.mode & 0o077n) !== 0n ||
    info.uid !== BigInt(uid)
  ) {
    throw new Error(
      'orcad_runtime_lineage_refused: private owned regular filesystem object required'
    )
  }
  return { device: info.dev.toString(), inode: info.ino.toString() }
}
