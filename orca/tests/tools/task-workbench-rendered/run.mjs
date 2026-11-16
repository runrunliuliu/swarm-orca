import { _electron as electron } from '@stablyai/playwright-test'
import { build } from 'esbuild'
import { build as buildRenderer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Rendered harness for the P1a task-workbench shell (w6-harness).
 *
 * One fixture and one window size per process: the shared hidden-window host is
 * reused unmodified and its content size is set through the main process, then
 * the page is loaded with `?fixture=`. Every `data-testid` in contract §4.3 is
 * checked by name against an expectation derived from the committed fixture and
 * the pure layout function, so the DOM cannot drift from the data. A failure
 * still writes its report and screenshot (that is the evidence).
 */

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Requires ORCA_BACKGROUND_LAUNCH=1')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureDir = import.meta.dirname
const outputRoot = path.join(root, '.bench-fixtures')
mkdirSync(outputRoot, { recursive: true })

const SCOPE =
  'Production TaskWorkbenchPanel and its seven sections rendered with the committed P1a fixtures. Proves data-testid presence/counts, the rendered layout decision, degradation copy, hidden/unfocused windows, no pageerror and CDP screenshots. It does not exercise a live store, RPC, locale switching or any click path.'

// Contract §4.2, copied by hand: the fixture data is the other side of this
// pin, so a fixture edit that changes a count fails here instead of silently
// moving every layout decision with it.
const CONTRACT_COUNTS = {
  f1_baseline: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f2a_zero_workspace_open: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f2b_zero_workspace_closed: { workspaces: 0, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 },
  f3_many_workspaces_agents: { workspaces: 3, agents: 10, activeAgents: 4, attentionAgents: 1, historyAgents: 5 },
  f4_usage_disabled: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f5_archived_only: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f6_no_tracker: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  f7_remote_workspace: { workspaces: 1, agents: 1, activeAgents: 1, attentionAgents: 0, historyAgents: 0 },
  f8_failure_outcome: { workspaces: 1, agents: 1, activeAgents: 0, attentionAgents: 0, historyAgents: 1 },
  f9_long_labels: { workspaces: 1, agents: 3, activeAgents: 2, attentionAgents: 0, historyAgents: 1 },
  f10_ambiguous_session: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f11_no_matching_session: { workspaces: 1, agents: 2, activeAgents: 1, attentionAgents: 0, historyAgents: 1 },
  f12_new_workspace_no_agents: { workspaces: 1, agents: 0, activeAgents: 0, attentionAgents: 0, historyAgents: 0 }
}

// The single-run path is the only implementation; --all is a sequential loop
// over it, so the peak stays at one Electron window.
const SHOT_MATRIX = [
  { id: 'S1', fixture: 'f1_baseline', width: 1440, height: 900, mandatory: true },
  { id: 'S2', fixture: 'f1_baseline', width: 1100, height: 800, mandatory: true },
  { id: 'S4', fixture: 'f2a_zero_workspace_open', width: 1440, height: 900, mandatory: true },
  { id: 'S3', fixture: 'f1_baseline', width: 1280, height: 480 },
  { id: 'S5', fixture: 'f2b_zero_workspace_closed', width: 1440, height: 900 },
  { id: 'S6', fixture: 'f3_many_workspaces_agents', width: 1440, height: 900 },
  { id: 'S7', fixture: 'f4_usage_disabled', width: 1440, height: 900 },
  { id: 'S8', fixture: 'f7_remote_workspace', width: 1440, height: 900 },
  { id: 'S9a', fixture: 'f10_ambiguous_session', width: 1440, height: 900 },
  { id: 'S9b', fixture: 'f11_no_matching_session', width: 1440, height: 900 },
  { id: 'S10a', fixture: 'f5_archived_only', width: 1440, height: 900 },
  { id: 'S10b', fixture: 'f6_no_tracker', width: 1440, height: 900 },
  { id: 'S10c', fixture: 'f8_failure_outcome', width: 1440, height: 900 },
  { id: 'S10d', fixture: 'f12_new_workspace_no_agents', width: 1440, height: 900 },
  { id: 'F9', fixture: 'f9_long_labels', width: 1440, height: 900 }
]

// Calibration probes, not part of S1-S10: these exercise the branches the
// numbered sizes cannot reach (900 < 1100, 479 < 480). Kept out of --all so the
// required matrix stays a clean gate; run with --calibrate to reproduce.
const CALIBRATION_MATRIX = [
  { id: 'calibration-single-column', fixture: 'f1_baseline', width: 900, height: 700, extra: true },
  { id: 'calibration-short', fixture: 'f1_baseline', width: 1280, height: 479, extra: true }
]

const DERIVE_SOURCE = `
import { getTaskWorkbenchFixture } from './src/renderer/src/components/task-workbench/task-workbench-fixtures'
import { computeTaskWorkbenchLayout } from './src/renderer/src/components/task-workbench/task-workbench-layout'
import { countRowBuckets } from './src/renderer/src/components/task-workbench/task-workbench-row-projection'
import { formatTokens } from './src/renderer/src/components/stats/usage-formatters'

const OUTCOME_TEXT = { success: 'Delivered', failure: 'Failed', cancellation: 'Cancelled' }

export function derive(fixtureKey, width, height) {
  const fixture = getTaskWorkbenchFixture(fixtureKey)
  if (!fixture) return { found: false }
  const view = fixture.view
  const counts = { workspaces: view.workspaces.length, ...countRowBuckets(view.agents) }
  const layout = computeTaskWorkbenchLayout({
    containerWidth: width,
    containerHeight: height,
    counts,
    mode: 'static'
  })

  const active = view.workspaces.filter((workspace) => workspace.archived !== true)
  const archived = view.workspaces.filter((workspace) => workspace.archived === true)
  const resolvedDefault =
    view.defaultWorkspace.source === 'none'
      ? undefined
      : view.workspaces.find(
          (workspace) => workspace.worktreeId === view.defaultWorkspace.workspaceId
        )
  const defaultIsActive = resolvedDefault !== undefined && resolvedDefault.archived !== true
  const primary =
    resolvedDefault !== undefined && resolvedDefault.archived !== true
      ? resolvedDefault
      : (active[0] ?? null)
  const secondary = active.filter((workspace) => workspace !== primary)
  const collapseSecondary = view.workspaces.length > 2 && secondary.length > 0
  const archivedOpen = active.length === 0 && archived.length > 0
  const visibleCards =
    layout.workspaces === 'full'
      ? (primary ? 1 : 0) +
        (collapseSecondary ? 0 : secondary.length) +
        (archivedOpen ? archived.length : 0)
      : 0

  // History rows are unmounted while the group is collapsed, so row counts and
  // row copy are over visible rows, not over every agent in the fixture.
  const historyExpanded = layout.agentHistory === 'expanded'
  const visibleRows = view.agents.filter((row) => {
    const bucket = row.base.bucket
    return bucket === 'working' || bucket === 'attention' || historyExpanded
  })
  const hasWorkspaces = view.workspaces.length > 0
  const spend = view.spend
  const delivery = view.delivery
  const outcomes = visibleRows.flatMap((row) => (row.outcome ? [row.outcome] : []))
  const successOutcomes = outcomes.filter((outcome) => outcome === 'success').length

  const expectedTestIds = {
    'task-workbench-panel': 1,
    'task-workbench-panel-layout': 1,
    'task-workbench-empty-state': hasWorkspaces ? 0 : 1,
    'task-workbench-header': 1,
    'task-workbench-header-title': 1,
    'task-workbench-header-provider': view.identity.kind === 'tracker' ? 1 : 0,
    'task-workbench-header-local-badge': view.identity.kind === 'workspace' ? 1 : 0,
    'task-workbench-header-branch': hasWorkspaces ? 1 : 0,
    'task-workbench-header-pr': delivery && delivery.pullRequest ? 1 : 0,
    'task-workbench-header-primary-action': hasWorkspaces ? 1 : 0,
    'task-workbench-agents': 1,
    'task-workbench-agents-empty': counts.agents === 0 ? 1 : 0,
    'task-workbench-agents-active':
      counts.activeAgents + counts.attentionAgents > 0 ? 1 : 0,
    'task-workbench-agents-attention': counts.attentionAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-toggle': counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-count': counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agents-history-empty': counts.historyAgents === 0 ? 1 : 0,
    'task-workbench-agents-history-records':
      historyExpanded && counts.historyAgents > 0 ? 1 : 0,
    'task-workbench-agent-row': visibleRows.length,
    'task-workbench-agent-row-tokens': visibleRows.length,
    'task-workbench-agent-row-outcome': outcomes.length,
    'task-workbench-agent-row-workspace-pill':
      view.workspaces.length > 1
        ? visibleRows.filter((row) => row.workspaceLabel !== undefined).length
        : 0,
    'task-workbench-workspaces': hasWorkspaces ? 1 : 0,
    'task-workbench-workspace-card': visibleCards,
    'task-workbench-workspace-card-default': defaultIsActive ? 1 : 0,
    'task-workbench-workspaces-create': 1,
    // Contract §4.3 says >2; the compact branch renders "+N more" instead of a
    // toggle. No run below pairs compact with >2 workspaces, so this stays the
    // contract condition rather than encoding that branch.
    'task-workbench-workspaces-secondary-toggle': view.workspaces.length > 2 ? 1 : 0,
    'task-workbench-workspaces-archived-toggle': archived.length > 0 ? 1 : 0,
    'task-workbench-spend': 1,
    'task-workbench-spend-total': spend.kind === 'available' ? 1 : 0,
    'task-workbench-spend-status': spend.kind === 'unavailable' ? 1 : 0,
    'task-workbench-spend-unattributed':
      spend.kind === 'available' && spend.unattributedSessions > 0 ? 1 : 0,
    // Provider detail is Spend detail: layout 'summary' is one line by design
    // (contract §4.1), so the rows exist only in the full form.
    'task-workbench-spend-provider-row':
      spend.kind === 'available' && layout.spend === 'full' ? spend.byProvider.length : 0,
    'task-workbench-spend-cta':
      spend.kind === 'unavailable' && spend.reason === 'disabled' ? 1 : 0,
    'task-workbench-delivery': 1,
    'task-workbench-delivery-toggle': delivery !== undefined ? 1 : 0,
    'task-workbench-delivery-body':
      delivery !== undefined && layout.delivery === 'expanded' ? 1 : 0,
    'task-workbench-delivery-commits':
      delivery !== undefined && delivery.commits.count > 0 ? 1 : 0,
    'task-workbench-delivery-checks': delivery && delivery.checks ? 1 : 0,
    'task-workbench-delivery-review': delivery && delivery.review ? 1 : 0
  }

  const semantic = {
    tokenChips: visibleRows
      .map((row) =>
        row.tokens.kind === 'unavailable' ? '—' : formatTokens(row.tokens.tokens) + ' tok'
      )
      .sort(),
    outcomeBadges: outcomes.map((outcome) => OUTCOME_TEXT[outcome]).sort(),
    spendStatusReason: spend.kind === 'unavailable' ? spend.reason : null,
    spendTotal:
      spend.kind === 'available'
        ? {
            tokens: formatTokens(spend.tokens) + ' tokens',
            cost: spend.costUsd === null ? '—' : 'est. $' + spend.costUsd.toFixed(2)
          }
        : null,
    deliveredExpected: successOutcomes > 0,
    archivedVisibleCards:
      layout.workspaces === 'full' && archivedOpen ? archived.length : 0,
    remoteHint:
      layout.workspaces === 'full' &&
      view.workspaces.some((workspace) => workspace.hostKind !== 'local'),
    headerTitle: view.title,
    localBadge: view.identity.kind === 'workspace'
  }

  return {
    found: true,
    label: fixture.label,
    summary: fixture.summary,
    counts,
    layout,
    expectedTestIds,
    semantic
  }
}
`

function parseArgs(argv) {
  const options = { all: false, calibrate: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--all':
        options.all = true
        break
      case '--calibrate':
        options.calibrate = true
        break
      case '--fixture':
        options.fixture = argv[(index += 1)]
        break
      case '--width':
        options.width = Number(argv[(index += 1)])
        break
      case '--height':
        options.height = Number(argv[(index += 1)])
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (options.help || options.all) {
    return options
  }
  if (!options.fixture) {
    throw new Error('--fixture <key> is required (or --all)')
  }
  if (!/^[a-z0-9_]+$/.test(options.fixture)) {
    throw new Error(`Fixture keys are lowercase snake_case: ${options.fixture}`)
  }
  if (!Number.isInteger(options.width) || options.width <= 0) {
    throw new Error('--width must be a positive integer')
  }
  if (!Number.isInteger(options.height) || options.height <= 0) {
    throw new Error('--height must be a positive integer')
  }
  return options
}

const SPARSE_ASSET_PREFIX = '\0sparse-resource:'
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

/** The sparse task checkout omits `orca/resources`, and `agent-catalog.tsx`
 *  imports the OpenClaude logo from it. No fixture renders that icon, so the
 *  harness build resolves the import to a transparent pixel instead of editing
 *  a component or adding the missing tree. */
function sparseResources() {
  return {
    name: 'task-workbench-sparse-resources',
    enforce: 'pre',
    resolveId(id) {
      if (/\/resources\/[^/]+\.(?:png|jpe?g|svg|webp|gif)(?:\?.*)?$/.test(id)) {
        return SPARSE_ASSET_PREFIX + id
      }
      return null
    },
    load(id) {
      if (id.startsWith(SPARSE_ASSET_PREFIX)) {
        return `export default ${JSON.stringify(TRANSPARENT_PNG)}`
      }
      return null
    }
  }
}

async function prepareBuilds() {
  const output = mkdtempSync(path.join(outputRoot, 'task-workbench-build-'))
  const main = path.join(output, 'main.cjs')
  await build({
    entryPoints: [path.join(root, 'tests/tools/benchmarks/spinner-rendering/main.ts')],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  await buildRenderer({
    configFile: false,
    root: fixtureDir,
    base: './',
    logLevel: 'silent',
    plugins: [react(), tailwindcss(), sparseResources()],
    resolve: { alias: { '@': path.join(root, 'src/renderer/src') } },
    build: { outDir: path.join(output, 'renderer'), emptyOutDir: true }
  })
  const deriveOutput = path.join(output, 'derive.mjs')
  await build({
    stdin: {
      contents: DERIVE_SOURCE,
      resolveDir: root,
      sourcefile: 'task-workbench-derive.js',
      loader: 'js'
    },
    outfile: deriveOutput,
    bundle: true,
    platform: 'node',
    format: 'esm'
  })
  const { derive } = await import(pathToFileURL(deriveOutput).href)
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  return { main, renderer: path.join(output, 'renderer'), derive, env }
}

function readPngSize(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Screenshot is not a PNG')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function compare(failures, name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push({ name, expected, actual })
  }
}

async function collectDom(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const texts = (selector) => [...document.querySelectorAll(selector)].map((element) => text(element))
    const testIds = {}
    for (const element of document.querySelectorAll('[data-testid]')) {
      const id = element.getAttribute('data-testid')
      testIds[id] = (testIds[id] ?? 0) + 1
    }
    const layoutElement = document.querySelector('[data-testid="task-workbench-panel-layout"]')
    const layoutJson = layoutElement?.getAttribute('data-wb-layout-json')
    return {
      testIds,
      layout: layoutElement
        ? {
            columns: layoutElement.getAttribute('data-wb-columns'),
            json: layoutJson === null || layoutJson === undefined ? null : JSON.parse(layoutJson)
          }
        : null,
      tokenChips: texts('[data-testid="task-workbench-agent-row-tokens"]'),
      outcomeBadges: texts('[data-testid="task-workbench-agent-row-outcome"]'),
      spendStatus: text(document.querySelector('[data-testid="task-workbench-spend-status"]')),
      spendTotal: text(document.querySelector('[data-testid="task-workbench-spend-total"]')),
      headerTitle: text(document.querySelector('[data-testid="task-workbench-header-title"]')),
      archivedCards: document.querySelectorAll(
        '[data-testid="task-workbench-workspace-card"][data-archived="true"]'
      ).length,
      bodyText: document.body.innerText,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }
    }
  })
}

async function runOne(entry, builds) {
  const startedAt = Date.now()
  const report = {
    run: entry.id ?? null,
    fixture: entry.fixture,
    requested: { width: entry.width, height: entry.height },
    extraCalibration: entry.extra === true,
    mandatory: entry.mandatory === true,
    scope: SCOPE
  }
  const failures = []
  const pageErrors = []
  const consoleErrors = []
  let app
  try {
    const expectation = builds.derive(entry.fixture, entry.width, entry.height)
    report.expected = expectation.found
      ? { label: expectation.label, summary: expectation.summary, counts: expectation.counts, layout: expectation.layout, semantic: expectation.semantic }
      : { found: false }
    const contractCounts = CONTRACT_COUNTS[entry.fixture]
    if (expectation.found && !contractCounts) {
      failures.push({ name: 'counts:missing-contract-row', expected: 'a §4.2 row', actual: entry.fixture })
    }
    if (expectation.found && contractCounts) {
      compare(failures, 'counts:contract', expectation.counts, contractCounts)
      compare(
        failures,
        'counts:sum',
        expectation.counts.activeAgents + expectation.counts.attentionAgents + expectation.counts.historyAgents,
        expectation.counts.agents
      )
    }

    app = await electron.launch({ args: [builds.main], env: { ...builds.env, ORCA_BACKGROUND_LAUNCH: '1' } })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
      console.error(error)
    })
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })
    await app.evaluate(({ BrowserWindow }, size) => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length !== 1) {
        throw new Error(`Expected one window, found ${windows.length}`)
      }
      windows[0].setContentSize(size.width, size.height)
    }, { width: entry.width, height: entry.height })
    const url = `${pathToFileURL(path.join(builds.renderer, 'index.html')).href}?fixture=${encodeURIComponent(entry.fixture)}`
    await page.goto(url)
    await page.waitForSelector(
      '[data-testid="task-workbench-panel"], [data-testid="task-workbench-fixture-error"]',
      { timeout: 30000 }
    )
    await page.evaluate(() =>
      Promise.race([
        document.fonts.ready,
        new Promise((resolve) => {
          setTimeout(resolve, 2000)
        })
      ])
    )
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {}))
      )
    })

    const dom = await collectDom(page)
    report.viewport = dom.viewport
    report.counts = expectation.found ? expectation.counts : null
    report.layout = { expected: expectation.found ? expectation.layout : null, actual: dom.layout }
    report.testIds = { expected: expectation.found ? expectation.expectedTestIds : null, actual: dom.testIds }
    report.semantic = {
      expected: expectation.found ? expectation.semantic : null,
      actual: {
        tokenChips: dom.tokenChips,
        outcomeBadges: dom.outcomeBadges,
        spendStatus: dom.spendStatus,
        spendTotal: dom.spendTotal,
        headerTitle: dom.headerTitle,
        archivedCards: dom.archivedCards
      }
    }

    compare(
      failures,
      'viewport:size',
      { width: dom.viewport.width, height: dom.viewport.height },
      { width: entry.width, height: entry.height }
    )

    if (expectation.found) {
      compare(failures, 'panel:layout-columns', dom.layout?.columns ?? null, expectation.layout.columns)
      compare(failures, 'panel:layout-json', dom.layout?.json ?? null, expectation.layout)
      for (const [id, expectedCount] of Object.entries(expectation.expectedTestIds)) {
        const actualCount = dom.testIds[id] ?? 0
        if (actualCount !== expectedCount) {
          failures.push({ name: `testid:${id}`, expected: expectedCount, actual: actualCount })
        }
      }
      for (const [id, actualCount] of Object.entries(dom.testIds)) {
        if (!(id in expectation.expectedTestIds)) {
          failures.push({ name: `testid:${id}:unexpected`, expected: 0, actual: actualCount })
        }
      }
      const semantic = expectation.semantic
      compare(failures, 'semantic:token-chips', [...dom.tokenChips].sort(), semantic.tokenChips)
      compare(failures, 'semantic:outcome-badges', [...dom.outcomeBadges].sort(), semantic.outcomeBadges)
      const statusText = dom.spendStatus === '' ? null : dom.spendStatus
      if (semantic.spendStatusReason === null) {
        compare(failures, 'semantic:spend-status-reason', statusText, null)
      } else {
        compare(
          failures,
          'semantic:spend-status-reason',
          statusText !== null && statusText.includes(semantic.spendStatusReason),
          true
        )
      }
      if (semantic.spendTotal) {
        compare(failures, 'semantic:spend-total-tokens', dom.spendTotal.includes(semantic.spendTotal.tokens), true)
        compare(failures, 'semantic:spend-total-cost', dom.spendTotal.includes(semantic.spendTotal.cost), true)
      }
      compare(failures, 'semantic:header-title', dom.headerTitle, semantic.headerTitle)
      compare(failures, 'semantic:archived-cards', dom.archivedCards, semantic.archivedVisibleCards)
      compare(failures, 'semantic:remote-hint', dom.bodyText.includes('Remote host · usage and actions stay local'), semantic.remoteHint)
      compare(failures, 'semantic:local-badge', dom.bodyText.includes('No tracker'), semantic.localBadge)
      compare(failures, 'semantic:no-fake-zero', /\$0(?:\.00)?(?![\d.])/.test(dom.bodyText), false)
      compare(failures, 'semantic:delivered-text', dom.bodyText.includes('Delivered'), semantic.deliveredExpected)
    } else {
      const errorNode = dom.testIds['task-workbench-fixture-error'] ?? 0
      compare(failures, 'fixture:error-node', errorNode, 1)
      failures.push({ name: 'fixture:unknown', expected: 'a known fixture key', actual: entry.fixture })
    }

    const cdp = await page.context().newCDPSession(page)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(data, 'base64')
    const screenshotFile = `task-workbench-${entry.fixture}-${entry.width}x${entry.height}.png`
    writeFileSync(path.join(outputRoot, screenshotFile), buffer)
    const png = readPngSize(buffer)
    report.screenshot = { file: screenshotFile, ...png }
    compare(
      failures,
      'screenshot:size',
      png,
      {
        width: Math.round(dom.viewport.width * dom.viewport.devicePixelRatio),
        height: Math.round(dom.viewport.height * dom.viewport.devicePixelRatio)
      }
    )

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    report.windows = windows
    compare(failures, 'windows:count', windows.length, 1)
    compare(failures, 'windows:hidden-unfocused', windows.every((window) => !window.visible && !window.focused), true)
    compare(failures, 'pageerror:count', pageErrors.length, 0)
  } catch (error) {
    failures.push({
      name: 'run:exception',
      expected: 'a completed run',
      actual: error instanceof Error ? error.message : String(error)
    })
  } finally {
    report.pageErrors = pageErrors
    report.consoleErrors = consoleErrors
    report.failures = failures
    report.pass = failures.length === 0
    report.durationMs = Date.now() - startedAt
    const reportFile = `task-workbench-${entry.fixture}-${entry.width}x${entry.height}.report.json`
    report.reportFile = reportFile
    writeFileSync(path.join(outputRoot, reportFile), `${JSON.stringify(report, null, 2)}\n`)
    if (app) {
      await app.close().catch(() => {})
    }
  }
  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node tests/tools/task-workbench-rendered/run.mjs --fixture <key> --width <n> --height <n>')
    console.log('       node tests/tools/task-workbench-rendered/run.mjs --all [--calibrate]')
    return
  }
  const startedAt = Date.now()
  const builds = await prepareBuilds()
  const runs = options.all
    ? [...SHOT_MATRIX, ...(options.calibrate ? CALIBRATION_MATRIX : [])]
    : [{ id: 'single', fixture: options.fixture, width: options.width, height: options.height }]
  const reports = []
  for (const entry of runs) {
    const report = await runOne(entry, builds)
    reports.push(report)
    const label = entry.id === null ? 'single' : entry.id
    const verdict = report.pass ? 'PASS' : 'FAIL'
    console.log(
      `${verdict} ${label} ${entry.fixture} ${entry.width}x${entry.height} (${report.durationMs} ms)`
    )
    if (!report.pass) {
      console.error(`  failures: ${report.failures.map((failure) => failure.name).join(', ')}`)
    }
  }
  if (options.all) {
    const summary = {
      scope: SCOPE,
      runs: reports.map((report) => ({
        run: report.run,
        fixture: report.fixture,
        size: `${report.requested.width}x${report.requested.height}`,
        extraCalibration: report.extraCalibration,
        mandatory: report.mandatory,
        pass: report.pass,
        failures: report.failures.map((failure) => failure.name),
        reportFile: report.reportFile,
        screenshot: report.screenshot ?? null
      })),
      passed: reports.filter((report) => report.pass).length,
      failed: reports.filter((report) => !report.pass).length,
      totalWallMs: Date.now() - startedAt
    }
    writeFileSync(path.join(outputRoot, 'task-workbench-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`summary: ${summary.passed}/${summary.runs.length} passed, ${summary.totalWallMs} ms`)
  }
  if (reports.some((report) => !report.pass)) {
    process.exitCode = 1
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
