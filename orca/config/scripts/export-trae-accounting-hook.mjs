#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [destination, ...extra] = process.argv.slice(2)
if (process.platform === 'win32' || !destination || !isAbsolute(destination) || extra.length) {
  throw new Error(
    'Usage (POSIX only): node config/scripts/export-trae-accounting-hook.mjs /absolute/new-directory'
  )
}
const root = fileURLToPath(new URL('../..', import.meta.url))
const bundle = await build({
  entryPoints: [join(root, 'src/main/trae/accounting-hook-package.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { buildTraeAccountingHookPackage } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)
// Refuse an existing destination; never overwrite an installed/trusted hook package.
await mkdir(destination, { mode: 0o700 })
const directory = await realpath(destination)
for (const file of buildTraeAccountingHookPackage(directory)) {
  const path = join(directory, file.path)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, file.content, { flag: 'wx', mode: file.mode })
}
console.log(
  `Exported ${directory}; not installed or trusted. Keep this directory at its current path.`
)
console.log(
  'Requires local Trae 0.209.1 --no-daemon, native hook trust, and a patched Orca runtime.'
)
