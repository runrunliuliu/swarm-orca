import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

function project(name) {
  const file = path.join(root, 'config', name)
  const config = ts.readConfigFile(file, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file))
}

describe('incident typecheck boundaries', () => {
  it('includes the incident read dependencies in the plain Node CLI project', () => {
    const files = new Set(project('tsconfig.tc.cli.json').fileNames)
    for (const file of [
      'src/main/incidents/incident-counts.ts',
      'src/main/incidents/incident-read-service.ts',
      'src/main/ipc/incident-mirror-coverage.ts'
    ]) {
      expect(files.has(ts.normalizePath(path.join(root, file))), file).toBe(true)
    }
  })

  it('keeps the main-side badge seam inside its declared renderer leaves', () => {
    const config = project('tsconfig.node.json')
    const included = new Set(config.fileNames)
    const renderer = `${ts.normalizePath(path.join(root, 'src/renderer'))}/`
    const pending = [
      ts.normalizePath(path.join(renderer, 'src/components/right-sidebar/incident-badge.ts'))
    ]
    const visited = new Set()
    const missing = []
    while (pending.length > 0) {
      const file = pending.pop()
      if (visited.has(file)) {
        continue
      }
      visited.add(file)
      if (!included.has(file)) {
        missing.push(path.relative(root, file))
      }
      for (const imported of ts.preProcessFile(readFileSync(file, 'utf8')).importedFiles) {
        const resolved = ts.resolveModuleName(imported.fileName, file, config.options, ts.sys)
          .resolvedModule?.resolvedFileName
        if (resolved?.startsWith(renderer) && /\.tsx?$/.test(resolved)) {
          pending.push(resolved)
        }
      }
    }
    expect(missing).toEqual([])
    expect([...visited]).not.toContain(ts.normalizePath(path.join(renderer, 'src/store/index.ts')))
  })
})
