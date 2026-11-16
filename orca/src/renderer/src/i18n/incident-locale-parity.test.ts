/**
 * Incident locale parity (review C2 + D4).
 *
 * # Scope, stated once
 *
 * The gate covers the incident surfaces this branch added under
 * `src/renderer/src/components/right-sidebar/`: the whole `incidents/` directory plus the three files
 * that render incident chrome (`incident-badge.ts`, `use-right-sidebar-activity-items.ts` and
 * `activity-bar-buttons.tsx`). It is deliberately not "every locale" and not "the whole sidebar": at
 * the base commit (`fc011d66`) `en.json` already held 64 keys `zh.json` lacks outside this scope, so a
 * global parity gate would have failed before this branch existed and would have to be silenced.
 *
 * Three checks, because the failure modes are different:
 *
 *  1. English cannot drift. Every `translate('<key>', '<fallback>')` in those files must resolve
 *     against a key whose `en.json` value is *exactly* that inline fallback. That is what makes the
 *     English render independent of the catalog: `en-runtime-required.json` ships none of these keys,
 *     so i18next returns the inline default, and an `en.json` edit that disagreed with it would only
 *     show up months later in a translated build.
 *  2. No new key can be English-only. Every key the incident files ask for must exist in `zh.json`.
 *     `KNOWN_EN_ONLY_INCIDENT_KEYS` records pre-existing gaps instead of widening the scope; it is
 *     empty because the incident namespace was at full parity when this gate was written, and an
 *     entry must still be missing in `zh` and present in `en` or the list is reported as stale.
 *  3. zh cannot lose a placeholder. For the incident namespace, the `{{name}}` set in `zh` must equal
 *     the one in `en`; a value that interpolates `{{published}}` where the code passes `shown` renders
 *     the literal braces in Chinese.
 *
 * Not covered here (and not claimed): translation quality of `zh` values, the `ja/ko/fr/es` catalogs
 * (the `activity.items` family this branch touched is not translated in any of them), and any
 * namespace outside the one named above.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import enRuntimeRequired from './en-runtime-required.json'
import zh from './locales/zh.json'

const RIGHT_SIDEBAR_ROOT = resolve('src/renderer/src/components/right-sidebar')
const INCIDENT_DIR = resolve(RIGHT_SIDEBAR_ROOT, 'incidents')
const INCIDENT_CHROME_FILES = [
  'activity-bar-buttons.tsx',
  'incident-badge.ts',
  'use-right-sidebar-activity-items.ts'
].map((name) => resolve(RIGHT_SIDEBAR_ROOT, name))

const INCIDENT_KEY_PREFIXES = [
  'auto.components.right.sidebar.incidents.',
  'auto.components.right.sidebar.incident.'
]

/** Pre-existing en-only keys we accept. Empty: these files were at full parity when written. */
const KNOWN_EN_ONLY_INCIDENT_KEYS: readonly string[] = []

/** Files allowed to compute a `translate()` key at the call site; each names its own key table. */
const KNOWN_DYNAMIC_CALL_SITE_FILES: readonly string[] = ['IncidentPanel.tsx']

type Catalog = Record<string, unknown>
type CallSite = {
  file: string
  line: number
  key: string | null
  fallback: string | null
}

function lookup(catalog: Catalog, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog
    )
  return typeof value === 'string' ? value : undefined
}

function flatten(catalog: Catalog, prefix = '', keys: string[] = []): string[] {
  for (const [name, value] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') {
      keys.push(key)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Catalog, key, keys)
    }
  }
  return keys
}

const enKeys = flatten(en as Catalog)
const enKeySet = new Set(enKeys)
const zhKeySet = new Set(flatten(zh as Catalog))
const enOnlyIncidentKeys = enKeys.filter(
  (key) => INCIDENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) && !zhKeySet.has(key)
)

/** Reads one `translate(` argument list, respecting nested calls, strings and template literals. */
function readArguments(source: string, openParen: number): string[] {
  const args: string[] = []
  let depth = 1
  let current = ''
  for (let index = openParen + 1; index < source.length && depth > 0; index += 1) {
    const char = source[index]
    if (char === "'" || char === '"' || char === '`') {
      current += char
      index += 1
      while (index < source.length) {
        current += source[index]
        if (source[index] === '\\') {
          current += source[index + 1] ?? ''
          index += 2
          continue
        }
        if (source[index] === char) {
          break
        }
        index += 1
      }
      continue
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        break
      }
    } else if (char === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  args.push(current.trim())
  return args
}

/**
 * The literal text of an argument, or null when the argument is computed. Only string literals,
 * their `+` concatenation and substitution-free templates can be compared to a catalog value.
 */
function literalValue(expression: string): string | null {
  const literalPattern =
    /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)\s*(\+?)/s
  let rest = expression
  let value = ''
  while (rest.trim().length > 0) {
    const match = rest.match(literalPattern)
    if (!match) {
      return null
    }
    const literal = match[1] ?? match[2] ?? match[3] ?? ''
    value += literal.replace(/\\(.)/g, (_whole, escaped: string) =>
      escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
    )
    rest = rest.slice(match[0].length)
    if (match[4] !== '+' && rest.trim().length > 0) {
      return null
    }
  }
  return expression.trim().length === 0 ? null : value
}

function collectTranslateCalls(filePath: string): CallSite[] {
  const source = readFileSync(filePath, 'utf8')
  const calls: CallSite[] = []
  const callPattern = /(^|[^\w.])translate\(/g
  for (const match of source.matchAll(callPattern)) {
    const openParen = (match.index ?? 0) + match[0].length - 1
    const [keyExpression = '', fallbackExpression = ''] = readArguments(source, openParen)
    calls.push({
      file: basename(filePath),
      line: source.slice(0, match.index ?? 0).split('\n').length,
      key: literalValue(keyExpression),
      fallback: literalValue(fallbackExpression)
    })
  }
  return calls
}

function incidentSourceFiles(): string[] {
  const fromDir = readdirSync(INCIDENT_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
    .map((name) => resolve(INCIDENT_DIR, name))
  return [...fromDir, ...INCIDENT_CHROME_FILES]
}

const callSites = incidentSourceFiles().flatMap(collectTranslateCalls)
const staticCallSites = callSites.filter(
  (site): site is CallSite & { key: string; fallback: string } =>
    site.key !== null && site.fallback !== null
)
const dynamicCallSites = callSites.filter((site) => site.key === null || site.fallback === null)
const referencedKeys = [...new Set(staticCallSites.map((site) => site.key))]

describe('incident renderer English catalog parity', () => {
  it('resolves every static translate() key to a catalog value equal to its inline fallback', () => {
    const drifted = staticCallSites
      .map((site) => {
        const value = lookup(en as Catalog, site.key)
        if (value === undefined) {
          return `${site.file}:${site.line} ${site.key} — missing from en.json`
        }
        if (value !== site.fallback) {
          return `${site.file}:${site.line} ${site.key}\n    en.json: ${JSON.stringify(value)}\n    inline : ${JSON.stringify(site.fallback)}`
        }
        return null
      })
      .filter((entry): entry is string => entry !== null)

    expect(drifted).toEqual([])
    expect(staticCallSites.length).toBeGreaterThan(0)
  })

  it('ships none of the incident strings in the pruned English runtime catalog', () => {
    // Why: en-runtime-required.json exists only for strings an inline default cannot produce. Every
    // incident string renders from its fallback, so a pruned-catalog entry would be a second English
    // source that can disagree with the code — the exact drift review C2 found.
    const shipped = enOnlyIncidentKeys.filter(
      (key) => lookup(enRuntimeRequired as Catalog, key) !== undefined
    )
    expect(shipped).toEqual([])
  })

  it('keeps the dynamic call sites to the documented allow-list', () => {
    expect([...new Set(dynamicCallSites.map((site) => site.file))]).toEqual(
      KNOWN_DYNAMIC_CALL_SITE_FILES
    )
  })
})

describe('incident renderer zh parity', () => {
  it('adds no en-only key in the incident namespace beyond the checked-in baseline', () => {
    const unexpected = enOnlyIncidentKeys.filter(
      (key) => !KNOWN_EN_ONLY_INCIDENT_KEYS.includes(key)
    )
    expect(unexpected).toEqual([])
  })

  it('keeps the baseline honest, so an entry cannot outlive the gap it records', () => {
    const stale = KNOWN_EN_ONLY_INCIDENT_KEYS.filter(
      (key) =>
        !INCIDENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        !enKeySet.has(key) ||
        zhKeySet.has(key)
    )
    expect(stale).toEqual([])
  })

  it('has a zh entry for every key the incident files ask for', () => {
    const missing = referencedKeys.filter((key) => !zhKeySet.has(key))
    expect(missing).toEqual([])
  })

  it('keeps the same placeholder names in zh as in en for the incident namespace', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort()
    const mismatched = enKeys
      .filter(
        (key) => INCIDENT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) && zhKeySet.has(key)
      )
      .map((key) => {
        const english = lookup(en as Catalog, key) ?? ''
        const chinese = lookup(zh as Catalog, key) ?? ''
        const enPlaceholders = placeholders(english)
        const zhPlaceholders = placeholders(chinese)
        return enPlaceholders.join(',') === zhPlaceholders.join(',')
          ? null
          : `${key}\n    en: ${enPlaceholders.join(',') || '—'}\n    zh: ${zhPlaceholders.join(',') || '—'}`
      })
      .filter((entry): entry is string => entry !== null)

    expect(mismatched).toEqual([])
  })
})
