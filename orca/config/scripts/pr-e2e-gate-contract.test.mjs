import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'
import {
  projectDir,
  remoteHistoryScenariosRoute,
  remoteOnlyTaskRecordRoute,
  REPRESENTATIVE_CHANGE_SPEC_BUDGET,
  restartSurvivalRoute,
  simRemoteKitRoute
} from './pr-e2e-gate-contract-fixtures.mjs'

describe('remote-only task record E2E routing', () => {
  it.each([
    'src/main/runtime/orca-runtime-pty-foreground-process-reads.ts',
    'src/main/runtime/rpc/methods/task-records.ts',
    'src/renderer/src/components/task-workbench/TaskWorkbenchHistory.tsx',
    'src/renderer/src/components/task-workbench/TaskWorkbenchPanel.tsx',
    'src/renderer/src/components/task-workbench/task-workbench-record-source-notice.tsx',
    'src/renderer/src/components/task-workbench/task-workbench-view.ts',
    'src/renderer/src/hooks/task-record-repo-catalog-cache.ts',
    'src/renderer/src/hooks/use-task-record-repo-candidates.ts',
    'src/renderer/src/hooks/use-task-record-sources.ts',
    'src/renderer/src/hooks/use-task-records-remote.ts',
    'src/renderer/src/hooks/use-task-workbench-view.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-history-merge.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-repo-candidates.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-repo-match.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-source-view.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-sources.ts'
  ])('routes issue-67 product source %s to the paired-runtime acceptance', (path) => {
    expect(remoteOnlyTaskRecordRoute.matches(path)).toBe(true)
  })

  it.each([
    'src/main/runtime/rpc/methods/task-records.test.ts',
    'src/renderer/src/components/task-workbench/TaskWorkbenchHistory.test.tsx',
    'src/renderer/src/hooks/use-task-record-sources.test.tsx',
    'src/renderer/src/lib/task-workbench/task-workbench-history-merge.test.ts',
    'src/main/git/git-status.ts'
  ])('does not route exact non-product or adjacent path %s', (path) => {
    expect(remoteOnlyTaskRecordRoute.matches(path)).toBe(false)
  })
})

describe('sim-remote kit E2E routing', () => {
  // Every file below is a kit primitive or the paired-page helper a consumer imports; a fix in
  // any of them can strand a scenario's runtime, proxy, identity or DOM wait.
  it.each([
    'tests/e2e/helpers/sim-remote/index.ts',
    'tests/e2e/helpers/sim-remote/network-proxy.ts',
    'tests/e2e/helpers/sim-remote/runtime-host.ts',
    'tests/e2e/helpers/sim-remote/record-seeder.ts',
    'tests/e2e/helpers/sim-remote/identity.ts',
    'tests/e2e/helpers/sim-remote/world.ts',
    'tests/e2e/helpers/sim-remote/README.md',
    'tests/e2e/helpers/task-workbench-paired-page.ts'
  ])('routes kit source %s to every consumer spec', (path) => {
    expect(simRemoteKitRoute.matches(path)).toBe(true)
    const specs = selectPrE2eSpecs([path])
    for (const spec of simRemoteKitRoute.specs) {
      expect(specs, `${path} must select ${spec}`).toContain(spec)
    }
  })

  it('sweeps the issue-67 spec from the paired-page helper it imports', () => {
    // Why named: the helper is the one consumer outside `sim-remote/`, and it is shared with the
    // pre-kit acceptance. Routing the kit without it would leave that spec's DOM waits pinned to
    // helper bytes nothing re-ran.
    expect(simRemoteKitRoute.specs).toContain('tests/e2e/task-workbench-remote-only-record.spec.ts')
    expect(selectPrE2eSpecs(['tests/e2e/helpers/task-workbench-paired-page.ts'])).toContain(
      'tests/e2e/task-workbench-remote-only-record.spec.ts'
    )
  })

  it('covers every sim-* scenario spec that exists on disk', () => {
    // Why derive from disk: `specs` claims "every sim-* spec", and the cheapest way for that
    // claim to go false is a sixth scenario that nobody registers.
    const simSpecs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => /^sim-.*\.spec\.ts$/.test(file))
      .map((file) => `tests/e2e/${file}`)
    expect(simSpecs.length).toBeGreaterThanOrEqual(5)
    for (const spec of simSpecs) {
      expect(simRemoteKitRoute.specs, spec).toContain(spec)
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
    for (const spec of simRemoteKitRoute.specs) {
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
  })

  it('keeps the kit unit tests in the lane that can run them', () => {
    // Why this shape: the kit has vitest unit tests, and Playwright cannot collect one —
    // `playwright test --list <unit file>` answers "Error: No tests found", so listing them in a
    // route would redden changed-e2e on every kit edit. They belong to the unit lane
    // (`tests/e2e/**/*.unit.test.ts`), which this asserts instead of assuming; a kit edit still
    // sweeps the specs because the route matches the whole directory.
    const kitUnitTests = discoverUnitFiles(projectDir).filter(
      (file) => file.startsWith('tests/e2e/helpers/sim-remote/') && file.endsWith('.unit.test.ts')
    )
    expect(kitUnitTests.length).toBeGreaterThan(0)
    for (const file of kitUnitTests) {
      expect(simRemoteKitRoute.matches(file), file).toBe(true)
      expect(simRemoteKitRoute.specs, file).not.toContain(file)
    }
  })

  it.each([
    // A sibling helper the kit does not own.
    'tests/e2e/helpers/paired-electron-client.ts',
    'tests/e2e/helpers/orca-app.ts',
    // A lookalike that is not inside the kit directory.
    'tests/e2e/helpers/sim-remote-notes.md',
    // A scenario spec is selected by its own `*.spec.ts` path, not by this route.
    'tests/e2e/sim-record-shapes.spec.ts'
  ])('does not treat %s as kit source', (path) => {
    expect(simRemoteKitRoute.matches(path)).toBe(false)
  })
})

describe('remote-history scenario E2E routing', () => {
  // The seams the five scenarios exist to pin: what a merge keeps when a host answered, what it
  // does with a binding whose worktree is not in the client catalog, what it refuses for a
  // lookalike identity, and how a read degrades when the link is slow, cut, or gone.
  it.each([
    'src/renderer/src/lib/task-workbench/task-workbench-history-merge.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-source-view.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-repo-candidates.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-repo-match.ts',
    'src/renderer/src/hooks/use-task-records-remote.ts',
    'src/renderer/src/hooks/use-task-record-sources.ts',
    'src/renderer/src/hooks/use-task-record-repo-candidates.ts',
    'src/main/runtime/rpc/methods/task-records.ts'
  ])('routes remote-history seam %s to the five scenarios', (path) => {
    expect(remoteHistoryScenariosRoute.matches(path)).toBe(true)
    const specs = selectPrE2eSpecs([path])
    for (const spec of remoteHistoryScenariosRoute.specs) {
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
      expect(specs, `${path} must select ${spec}`).toContain(spec)
    }
  })

  it.each([
    // Neighbours in the same directory with unit coverage but no scenario.
    'src/renderer/src/lib/task-workbench/task-workbench-usage.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-archived-settlement.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-history-settlement.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-row-activity.ts',
    // A routing neighbour that the issue-67 route owns, not this one.
    'src/renderer/src/components/task-workbench/TaskWorkbenchHistory.tsx',
    // Unit tests beside a seam must not summon a two-minute scenario lane.
    'src/renderer/src/lib/task-workbench/task-workbench-history-merge.test.ts',
    'src/renderer/src/lib/task-workbench/task-workbench-record-repo-match.test.ts',
    'src/renderer/src/hooks/use-task-records-remote.test.ts',
    // Unrelated product source.
    'src/main/git/git-status.ts'
  ])('does not route %s', (path) => {
    expect(remoteHistoryScenariosRoute.matches(path)).toBe(false)
    expect(selectPrE2eSpecs([path])).not.toContain('tests/e2e/sim-record-shapes.spec.ts')
  })

  it('keeps the seam list closed rather than a task-workbench directory prefix', () => {
    // Why: the closed list is the whole cost argument. A `task-workbench-` prefix would select
    // these five scenarios for most edits in that directory; this pins the seam set so widening
    // it is a visible change to this file, not a side effect of a new neighbour.
    expect(remoteHistoryScenariosRoute.matches.length).toBeGreaterThan(0)
    const routedNeighbours = readdirSync(join(projectDir, 'src/renderer/src/lib/task-workbench'))
      .filter((file) => /^task-workbench-.*\.ts$/.test(file) && !file.includes('.test.'))
      .map((file) => `src/renderer/src/lib/task-workbench/${file}`)
    expect(routedNeighbours.length).toBeGreaterThan(5)
    expect(routedNeighbours.filter(remoteHistoryScenariosRoute.matches)).toEqual([
      'src/renderer/src/lib/task-workbench/task-workbench-history-merge.ts',
      'src/renderer/src/lib/task-workbench/task-workbench-record-repo-candidates.ts',
      'src/renderer/src/lib/task-workbench/task-workbench-record-repo-match.ts',
      'src/renderer/src/lib/task-workbench/task-workbench-record-source-view.ts'
    ])
  })
})

describe('PR E2E lane cost', () => {
  it('keeps a representative task-workbench change at the measured spec budget', () => {
    // Why exact and not a ceiling: a route table can only grow, and the cost of this lane is a
    // function of the spec count, not of intent. Equality means an addition has to be seen here
    // and priced in REPRESENTATIVE_CHANGE_SPEC_BUDGET.
    for (const file of [
      'src/renderer/src/lib/task-workbench/task-workbench-history-merge.ts',
      'src/renderer/src/hooks/use-task-records-remote.ts',
      'src/main/runtime/rpc/methods/task-records.ts'
    ]) {
      const specs = selectPrE2eSpecs([file])
      expect(specs.length, `${file} selects ${specs.join(', ')}`).toBe(
        REPRESENTATIVE_CHANGE_SPEC_BUDGET
      )
    }

    // The kit lane is priced from disk, not from a hard-coded lane size: every `sim-*` spec on disk
    // is a kit scenario, plus the issue-67 consumer that imports the paired-page helper. A new
    // scenario or a new recording spec therefore changes the count here rather than hiding behind a
    // constant.
    const kitSpecs = selectPrE2eSpecs(['tests/e2e/helpers/sim-remote/index.ts'])
    const simScenarioSpecs = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => /^sim-.*\.spec\.ts$/.test(file))
      .map((file) => `tests/e2e/${file}`)
    expect(kitSpecs.length, `kit selects ${kitSpecs.join(', ')}`).toBe(
      simScenarioSpecs.length + 1
    )
  })
})

describe('restart-survival E2E routing', () => {
  // Every file below carries behavior the restart spec is the only test that exercises end to end.
  it.each([
    'src/main/runtime/orca-runtime.ts',
    'src/main/runtime/orca-runtime-browser.ts',
    'src/main/runtime/client-hosted-page-reconciliation-window.ts',
    'src/main/runtime/runtime-browser-client-page-adoption.ts',
    'src/main/runtime/runtime-browser-client-page-recovery.ts',
    'src/main/runtime/browser-host-client-page-adoption.ts',
    'src/main/runtime/browser-host-page-reconciliation-orchestration.ts',
    'src/main/runtime/rpc/methods/browser-client-host.ts',
    'src/main/browser/browser-client-host-authority-replacement-wait.ts',
    'src/main/browser/paired-runtime-browser-client-host-composition.ts',
    'src/renderer/src/runtime/web-session-tabs-sync.ts',
    'src/renderer/src/runtime/host-session-snapshot-authority.ts',
    'src/renderer/src/runtime/restored-client-hosted-browser-host-attach.ts',
    'src/renderer/src/store/slices/runtime-status.ts',
    'src/shared/runtime-types.ts',
    'src/shared/browser-client-host-protocol.ts'
  ])('routes %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(true)
  })

  // The pattern is deliberately not "anything under src": routing every PR at a two-Electron spec
  // is the cost the filter exists to avoid.
  it.each([
    'src/main/git/git-status.ts',
    'src/renderer/src/components/tab-bar/BrowserTab.tsx',
    'src/main/terminal/pty-manager.ts',
    // The status/types entries name whole files, not a suffix any longer name may end with.
    'src/shared/computer-use-runtime-types.ts'
  ])('does not route %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(false)
  })
})
