/**
 * Recorded-lane guard: the properties the recorded/evidence lane actually enforces.
 *
 * Why this is its own file: `pr-e2e-gate-contract.test.mjs` reads `.github/workflows/pr.yml` at
 * module load, and this checkout has no tracked `.github/`, so every case in that file is
 * uncollectable here (pre-existing). Everything below reads only files in this checkout, so it can
 * run — and did, in the report that introduced it. It is part of the unit lane
 * (`config/scripts/**\/*.test.mjs`), so CI collects it without a new registration.
 *
 * What it does NOT do: assert a wall-clock overhead measured on one host. Those numbers live in the
 * recorded-lane report and in prose. A test that asserts its own measurement literals cannot fail on
 * a regression, which is what this file replaces.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPT_IN_E2E_LANES,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

/** Every `*.spec.ts` under `tests/e2e`, as a repository-relative path with forward slashes. */
function specFilesOnDisk() {
  const specs = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        specs.push(fullPath.slice(projectDir.length + 1).replaceAll('\\', '/'))
      }
    }
  }
  walk(join(projectDir, 'tests/e2e'))
  return specs.sort()
}

function readSource(relativePath) {
  return readFileSync(join(projectDir, relativePath), 'utf8')
}

function route(id) {
  const found = PR_E2E_SOURCE_ROUTES.find((candidate) => candidate.id === id)
  expect(found, `route ${id} must exist`).toBeDefined()
  return found
}

/** Integer literals declared as `const NAME = 123` or `export const NAME = 1_234`. */
function numericConstants(source) {
  const constants = {}
  for (const match of source.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = ([0-9][0-9_]*)$/gmu)) {
    constants[match[1]] = Number(match[2].replaceAll('_', ''))
  }
  return constants
}

const allSpecs = specFilesOnDisk()
const allRoutedSpecs = [...new Set(PR_E2E_SOURCE_ROUTES.flatMap((candidate) => candidate.specs))]

describe('recorded evidence lane registration', () => {
  it('registers every opted-in spec with who runs it and how often', () => {
    // Why derive the tagged set from the files: an opt-in spec that nobody registered is green
    // everywhere and rots silently (`swarm/docs/testing/e2e-evidence.md` §1 rule 3), and a
    // registration whose spec was renamed is the same failure with a tidier table.
    const tagged = allSpecs.filter((spec) => readSource(spec).includes('@sim-recording'))
    expect(tagged.length).toBeGreaterThan(0)
    for (const spec of tagged) {
      const lane = OPT_IN_E2E_LANES.find((candidate) => candidate.spec === spec)
      expect(lane, `${spec} carries @sim-recording but has no OPT_IN_E2E_LANES entry`).toBeDefined()
      expect(lane.optIn, `${spec} registration must name the literal opt-in`).toBe(
        `${lane.envVar}=1`
      )
      expect(
        lane.cadence.length,
        `${spec} registration must say when the lane runs`
      ).toBeGreaterThan(20)
      const source = readSource(spec)
      // The spec must actually be gated, not merely tagged: deleting the gate would put a real
      // encoder pass back into the default lane while the table still claimed otherwise.
      expect(source, `${spec} must gate on the registered opt-in`).toContain(
        `process.env.${lane.envVar} !== '1'`
      )
      expect(source, `${spec} must still exercise the recorder it exists for`).toContain(
        'startRecording('
      )
      expect(existsSync(join(projectDir, lane.spec)), lane.spec).toBe(true)
      // And a registered spec must be reachable from a route, or a change to its subject never
      // selects it.
      expect(allRoutedSpecs, `${spec} is not listed by any route`).toContain(spec)
    }
  })

  it('selects the recording spec from the kit lane, whose members are counted on disk', () => {
    const kit = route('sim-remote.kit')
    const simSpecsOnDisk = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => /^sim-.*\.spec\.ts$/u.test(file))
      .map((file) => `tests/e2e/${file}`)
    expect(simSpecsOnDisk.length).toBeGreaterThanOrEqual(5)
    for (const spec of simSpecsOnDisk) {
      expect(kit.specs, `${spec} exists on disk but is unregistered`).toContain(spec)
    }
    for (const spec of kit.specs) {
      expect(existsSync(join(projectDir, spec)), `${spec} is routed but absent`).toBe(true)
    }
    expect(selectPrE2eSpecs(['tests/e2e/helpers/sim-remote/index.ts']).sort()).toEqual(
      [...kit.specs].sort()
    )
  })

  it('routes the capture helper to exactly the specs that import it', () => {
    // F6: the helper used to select six kit specs that never import it while the two lineage specs
    // that do were unselected. Both directions are asserted, so neither a stale list nor a new
    // consumer can pass unnoticed.
    const importers = allSpecs.filter((spec) =>
      /from ['"]\.\/helpers\/evidence-capture['"]/u.test(readSource(spec))
    )
    expect(importers.length).toBeGreaterThan(0)
    expect(
      selectPrE2eSpecs(['tests/e2e/helpers/evidence-capture.ts']).sort(),
      'a change to evidence-capture.ts must select its importers and nothing else'
    ).toEqual([...importers].sort())
  })

  it('enforces one capture deadline that the recording spec ceiling can afford', () => {
    // F7: the old guard asserted 0.23–0.29 s literals against themselves and certified a 75 s worst
    // case against a 60 s spec ceiling. What is actually enforced is one whole-capture deadline,
    // and the property worth pinning is that its own worst-case work fits inside it.
    const recorder = numericConstants(readSource('tests/e2e/helpers/sim-remote/recorder.ts'))
    const encoder = numericConstants(readSource('tests/e2e/helpers/sim-remote/screencast-encoder.ts'))
    const deadlineMs = recorder.CAPTURE_DEADLINE_MS
    const probeMs = encoder.PROBE_TIMEOUT_MS
    const encodeMs = encoder.ENCODE_TIMEOUT_MS
    expect(deadlineMs, 'the recorder must enforce a capture deadline literal').toBeGreaterThan(0)
    expect(probeMs).toBeGreaterThan(0)
    expect(encodeMs).toBeGreaterThan(0)
    // A healthy encoder — up to three discovery probes and one encode — must finish inside the
    // deadline. Otherwise the deadline would fire on an ordinary slow host and every capture would
    // degrade by construction.
    expect(
      encodeMs + 3 * probeMs,
      'the recorder deadline must cover its own discovery and encode timeouts'
    ).toBeLessThanOrEqual(deadlineMs)

    // R2: the ceiling is a sum of named parts, not a floor someone picked. Boot + capture + the
    // spec's own post-capture probe all happen inside one Playwright timeout, so the guard reads
    // the three addends out of the two sources and requires the spec to add exactly those.
    const specSource = readSource('tests/e2e/sim-remote-recording.spec.ts')
    const specConstants = numericConstants(specSource)
    const ceiling = specSource.match(
      /timeout:\s*CAPTURE_DEADLINE_MS\s*\+\s*([A-Z][A-Z0-9_]*)\s*\+\s*([A-Z][A-Z0-9_]*)/u
    )
    expect(
      ceiling,
      'the recording spec ceiling must be CAPTURE_DEADLINE_MS + APP_ALLOWANCE_MS + PROBE_TIMEOUT_MS'
    ).not.toBeNull()
    const [appConstant, probeConstant] = [ceiling[1], ceiling[2]]
    expect(appConstant, 'the middle addend is the app boot + scenario allowance').toBe(
      'APP_ALLOWANCE_MS'
    )
    expect(probeConstant, 'the last addend is the spec probe\'s own timeout').toBe(
      'PROBE_TIMEOUT_MS'
    )
    const appAllowanceMs = specConstants.APP_ALLOWANCE_MS
    expect(appAllowanceMs, 'the spec must declare its app allowance').toBeGreaterThan(0)
    expect(
      specConstants.PROBE_TIMEOUT_MS,
      'the spec must declare its probe timeout (the encoder has its own, smaller, per-call cap)'
    ).toBeGreaterThan(0)
    // The bootstrap measurement from W7: 21.9–25.3 s of app boot and scenario before the capture
    // even starts. A boot regression means this constant has to grow, and this assertion is what
    // notices; the old `allowance >= 30 s` floor could not, because it never compared the two.
    const measuredBootMs = 25_300
    expect(
      appAllowanceMs,
      'the spec allowance must exceed the measured app boot and scenario in reports/run4-w7-recorder-fix.md'
    ).toBeGreaterThan(measuredBootMs)
    const ceilingMs = deadlineMs + appAllowanceMs + specConstants.PROBE_TIMEOUT_MS
    expect(
      ceilingMs,
      'the ceiling must be the sum that covers measured boot + the capture deadline + the probe'
    ).toBeGreaterThanOrEqual(measuredBootMs + deadlineMs + probeMs)

    // And the probe has to actually spend that timeout: a ceiling that adds a constant the call
    // site never receives is the same floor bug with more arithmetic.
    expect(specSource, 'measureVideo must take its timeout from the caller').toMatch(
      /function measureVideo\([^)]*timeoutMs: number\)/u
    )
    expect(specSource, 'measureVideo must pass timeoutMs to execFile').toMatch(
      /timeout:\s*timeoutMs/u
    )
    expect(specSource, 'the probe call must use the declared probe timeout').toMatch(
      /measureVideo\([^)]*PROBE_TIMEOUT_MS\)/u
    )
    expect(specSource, 'no fixed literal ceiling may survive beside the derived one').not.toMatch(
      /timeout:\s*[0-9][0-9_]*\s*\+\s*[0-9]/u
    )
  })

  it('keeps capture opt-in by the literal and reports a skip instead of silence', () => {
    // F10: a disabled gate is expected (no signal), but an invalid name or a failed screenshot must
    // not return an empty result and look written.
    const capture = readSource('tests/e2e/helpers/evidence-capture.ts')
    expect(capture).toContain("process.env.ORCA_CAPTURE_EVIDENCE === '1'")
    expect(capture, 'captureEvidence must return a skipped reason').toMatch(/skipped/u)
  })

  it('does not re-introduce a self-certifying recorded-lane budget', () => {
    // The failure this replaces: three measured decimals asserted `<= 1`, and a lane size asserted
    // against the same constant that defined it. Neither can fail on a real regression.
    const contract = readSource('config/scripts/pr-e2e-gate-contract.test.mjs')
    expect(
      contract,
      'observed overhead belongs in prose, not in an assertion on its own literals'
    ).not.toMatch(/RECORDED_LANE_MEASURED_OVERHEAD/u)
    expect(
      contract,
      'lane sizes must be derived from disk, not asserted against a literal'
    ).not.toMatch(/toBe\(6\)/u)
  })
})
