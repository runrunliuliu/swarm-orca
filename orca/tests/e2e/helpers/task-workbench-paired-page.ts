import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'

export type PairedTaskWorkbenchArgs = {
  /** Repository id carried by the page; it need not exist in the client store. */
  pageRepoId: string
  /** Additional repo ids that must be absent before the task page starts reading history. */
  clientRepoIdsToExclude?: string[]
  /** Repo ids whose first exclusion must wait for catalog publication. Defaults to exclusions. */
  clientRepoIdsToAwait?: string[]
  /** Stable task-source project id used by the page payload. */
  projectId?: string
  issueNumber: number
  title?: string
  tracker?: { state: 'open' | 'closed'; url: string }
}

export type PairedTaskWorkbenchCatalogEvidence = {
  catalogHydrated: boolean
  catalogSettled: boolean
  repoIds: string[]
  statusKnown: boolean
}

const excludedRepoIdsByPage = new WeakMap<Page, Set<string>>()

function githubIdentity(trackerUrl: string): { owner: string; repo: string } {
  const url = new URL(trackerUrl)
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  if (url.hostname !== 'github.com' || !owner || !repo) {
    throw new Error(
      `Task-workbench paired-page helper requires a GitHub tracker URL: ${trackerUrl}`
    )
  }
  return { owner, repo }
}

/**
 * Opens the task-workbench Orca tab in a paired client and waits for its panel.
 *
 * This helper is task-workbench-specific on purpose: it owns the Orca-tab payload, local-profile
 * reset, runtime catalog refresh, and task-workbench DOM ids. The simulation kit stays unaware of
 * pages and features; scenarios compose that feature-agnostic world with this page adapter.
 * The catalog predicate is a happens-before for publications that already landed, not a
 * quiescence proof. Boot-time refresh requests, `reposChanged`, and transport-gap replay
 * invalidation can still republish after the page opens.
 */
export async function openTaskWorkbenchInPairedClient(
  client: PairedElectronClient,
  args: PairedTaskWorkbenchArgs
): Promise<{
  catalogEvidence: PairedTaskWorkbenchCatalogEvidence
  panel: Locator
  history: Locator
  page: Page
}> {
  const tracker =
    args.tracker ??
    ({
      state: 'closed',
      url: `https://github.com/orca-e2e/task-workbench/issues/${args.issueNumber}`
    } as const)
  const identity = githubIdentity(tracker.url)
  const page = client.page
  await page.evaluate(async (environmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    if (!(await store.getState().setActiveRuntimeEnvironmentPreference(null))) {
      throw new Error('Paired client could not return to its local profile')
    }
    store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
      throw new Error('Paired runtime status did not refresh for the task page')
    }
  }, client.environmentId)

  const captureCatalog = (): Promise<PairedTaskWorkbenchCatalogEvidence> =>
    page.evaluate((environmentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      const state = store.getState()
      return {
        catalogHydrated: state.runtimeEnvironmentCatalogHydrated,
        catalogSettled: state.runtimeEnvironmentCatalogSettled,
        repoIds: state.repos.map((repo) => repo.id),
        statusKnown: state.runtimeStatusByEnvironmentId.has(environmentId)
      }
    }, client.environmentId)

  const clientRepoIdsToExclude = args.clientRepoIdsToExclude ?? []
  const previouslyExcludedRepoIds = excludedRepoIdsByPage.get(page) ?? new Set<string>()
  const clientRepoIdsToAwait =
    args.clientRepoIdsToAwait ??
    clientRepoIdsToExclude.filter((repoId) => !previouslyExcludedRepoIds.has(repoId))
  await expect
    .poll(
      async () => {
        const evidence = await captureCatalog()
        // The presence conjunct is the fix; the hydrated, settled, and status flags are a canary.
        return (
          evidence.catalogHydrated &&
          evidence.catalogSettled &&
          evidence.statusKnown &&
          clientRepoIdsToAwait.every((repoId) => evidence.repoIds.includes(repoId))
        )
      },
      {
        message: 'paired repository catalog never settled before the task page opened',
        timeout: 45_000
      }
    )
    .toBe(true)
  const catalogEvidence = await captureCatalog()

  await page.evaluate(
    ({ clientRepoIdsToExclude, identity, issueNumber, pageRepoId, projectId, title, tracker }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      const excludedRepoIds = new Set([pageRepoId, ...clientRepoIdsToExclude])
      store.setState((current) => {
        const worktreesByRepo = { ...current.worktreesByRepo }
        for (const repoId of excludedRepoIds) {
          worktreesByRepo[repoId] = []
        }
        return {
          repos: current.repos.filter((repo) => !excludedRepoIds.has(repo.id)),
          worktreesByRepo
        }
      })
      store.getState().openTaskPage(
        {
          taskSource: 'github',
          preselectedRepoId: pageRepoId,
          openGitHubInitialTab: 'orca',
          openGitHubWorkItem: {
            id: `issue-${issueNumber}`,
            type: 'issue',
            number: issueNumber,
            title,
            state: tracker.state,
            url: tracker.url,
            labels: ['bug'],
            updatedAt: new Date(0).toISOString(),
            author: 'orca-e2e',
            repoId: pageRepoId
          },
          openGitHubSourceContext: {
            kind: 'task-source',
            provider: 'github',
            projectId,
            hostId: 'local',
            repoId: pageRepoId,
            providerIdentity: {
              provider: 'github',
              host: 'github.com',
              owner: identity.owner,
              repo: identity.repo
            }
          }
        },
        { recordTasksInteraction: false }
      )
    },
    {
      clientRepoIdsToExclude,
      identity,
      issueNumber: args.issueNumber,
      pageRepoId: args.pageRepoId,
      projectId: args.projectId ?? 'paired-task-workbench-e2e',
      title: args.title ?? 'Paired task record',
      tracker
    }
  )
  for (const repoId of clientRepoIdsToExclude) {
    previouslyExcludedRepoIds.add(repoId)
  }
  excludedRepoIdsByPage.set(page, previouslyExcludedRepoIds)
  const panel = page.getByTestId('task-workbench-panel')
  const history = panel.getByTestId('task-workbench-history')
  await expect(panel).toBeVisible({ timeout: 45_000 })
  return { catalogEvidence, panel, history, page }
}

type HistoryDetailsState = { compact: boolean; hasDetails: boolean; expanded: string | null }

/** Reads the product's own statement about the history body, never a handle held from an earlier render. */
async function readHistoryDetailsState(history: Locator): Promise<HistoryDetailsState | null> {
  // The strip itself unmounts while the paired read is pending (`history.trace`
  // becomes `none`) and mounts again when the answer arrives: that is "not
  // observable yet", not a failed assertion, so the poll simply re-queries.
  if ((await history.count()) === 0) {
    return null
  }
  try {
    return await history.evaluate((element, detailsSelector) => {
      const details = element.querySelector(detailsSelector)
      return {
        compact: element.getAttribute('data-compact') === 'true',
        hasDetails: details !== null,
        expanded: details?.getAttribute('aria-expanded') ?? null
      }
    }, '[data-testid="task-workbench-history-details"]')
  } catch (error) {
    // The element can be re-mounted between the count above and this evaluate.
    if (
      error instanceof Error &&
      /not attached|detached|resolved to 0 elements/.test(error.message)
    ) {
      return null
    }
    throw error
  }
}

/**
 * Opens the run-history detail body, tolerating the layout measurement that can
 * remove the compact-only control while a click is in flight.
 *
 * `TaskWorkbenchHistory` renders `task-workbench-history-details` only while the
 * measured layout is compact (`data-compact`). `useLiveLayout` starts from 0x0 —
 * compact — until its ResizeObserver callback publishes the tab body's real size;
 * on a wide window the settled layout is `columns: double` / `agentHistory:
 * expanded`, where the body is rendered unconditionally and the control does not
 * exist at all. On an idle host that callback lands long before the paired
 * record read answers, so the test finds no control and clicks nothing. Under
 * load the answer can render first: measured on `ca763c55` with `--workers=4`,
 * the click resolved a real button while the layout still said `columns:single`,
 * the observer published the measured layout 20-861 ms later, and the click spent
 * its whole 30 s budget on a node that no longer existed (`element is not
 * stable` -> `element was detached from the DOM`).
 *
 * So the guard polls the product's own state instead of holding one element
 * handle: when the layout is not compact the body is open by construction and a
 * missing control is the open state; when it is compact the control must be
 * clicked and must report `aria-expanded="true"`. A click is retried only when
 * the resulting state explains the failure as that re-layout (the strip is gone,
 * the layout is no longer compact, or the click landed); any other click failure
 * is rethrown. Bounded by the same 45 s budget as the other preconditions.
 * Returns the number of click attempts so a run can report whether the guard was
 * exercised at all.
 */
export async function expandTaskWorkbenchHistoryDetails(
  history: Locator
): Promise<{ clickAttempts: number }> {
  let clickAttempts = 0
  await expect
    .poll(
      async () => {
        const state = await readHistoryDetailsState(history)
        if (state === null) {
          return false
        }
        if (!state.compact || state.expanded === 'true') {
          return true
        }
        if (!state.hasDetails) {
          return false
        }
        clickAttempts += 1
        try {
          await history.getByTestId('task-workbench-history-details').click({ timeout: 2_000 })
        } catch (error) {
          const after = await readHistoryDetailsState(history)
          const explainedByRelayout = after === null || !after.compact || !after.hasDetails
          if (!explainedByRelayout) {
            throw error
          }
          console.log(
            `[task-workbench] history details click attempt ${clickAttempts} lost the compact-only control to a layout re-render; re-querying`
          )
        }
        const after = await readHistoryDetailsState(history)
        return after !== null && (!after.compact || after.expanded === 'true')
      },
      {
        message: 'run-history details never opened',
        timeout: 45_000,
        intervals: [50, 100, 200, 400]
      }
    )
    .toBe(true)
  return { clickAttempts }
}

/**
 * Opens the Agents section's history fold, tolerating a layout measurement that
 * lands between reading the toggle and clicking it.
 *
 * `TaskWorkbenchAgents` starts the fold from the layout
 * (`aria-expanded={layout.agentHistory === 'expanded'}`) and a click flips that
 * current value into an explicit override. The layout starts compact (0x0 tab
 * body) and becomes `expanded` when the ResizeObserver publishes the real size,
 * so a click whose read happened just before that publication inverts a value
 * that has already moved — collapsing the fold it meant to open. Measured under
 * `--workers=4` on `ca763c55`: the toggle still said `aria-expanded="false"`,
 * the click then closed the already-expanded fold, and the following assertion
 * sat on `false` for its whole 10 s budget. Polling the fold state and clicking
 * only while it is closed converges on the state the assertion wants without
 * assuming which side of the measurement the click lands on; bounded by the same
 * 45 s budget as the other preconditions.
 */
export async function expandTaskWorkbenchAgentHistory(panel: Locator): Promise<void> {
  const toggle = panel.getByTestId('task-workbench-agents-history-toggle')
  await expect
    .poll(
      async () => {
        if ((await toggle.count()) === 0) {
          return false
        }
        if ((await toggle.getAttribute('aria-expanded')) === 'true') {
          return true
        }
        try {
          await toggle.click({ timeout: 2_000 })
        } catch (error) {
          // Only the measured re-render is retried: re-read the fold first and
          // rethrow when the state does not explain the failed click.
          const afterCount = await toggle.count()
          if (afterCount === 0) {
            return false
          }
          if ((await toggle.getAttribute('aria-expanded')) === 'true') {
            return true
          }
          throw error
        }
        const expanded = (await toggle.getAttribute('aria-expanded')) === 'true'
        if (!expanded) {
          console.log(
            '[task-workbench] agent history toggle click inverted a value the layout had already moved; re-querying'
          )
        }
        return expanded
      },
      {
        message: 'agent history fold never expanded',
        timeout: 45_000,
        intervals: [50, 100, 200, 400]
      }
    )
    .toBe(true)
}

/** Asserts the task-workbench archived trace, remote agent row, and locate-trace action. */
export async function expectArchivedRemoteAgentRow(
  panel: Locator,
  opts: { runKind?: RegExp } = {}
): Promise<void> {
  const history = panel.getByTestId('task-workbench-history')
  await expect(history).toHaveAttribute('data-trace', 'archived', { timeout: 45_000 })
  await expandTaskWorkbenchHistoryDetails(history)
  const run = history
    .getByTestId('task-workbench-history-run')
    .filter({ hasText: opts.runKind ?? /codex/i })
  await expect(run).toBeVisible()
  await expect(run).toContainText(/codex/i)
  await expect(history.getByTestId('task-workbench-history-trace-locate')).toBeVisible()
}

/** Asserts that an in-flight or partial read never falls back to the false empty/zero state. */
export async function expectNoFalseEmptyState(page: Page, panel: Locator): Promise<void> {
  await expect(page.getByTestId('task-workbench-empty-state')).toHaveCount(0)
  await expect(panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)
}

/** Asserts unknown token usage remains explicit and is never rendered as zero. */
export async function expectUnknownUsage(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('task-workbench-history-facts')).toContainText('tokens unknown')
  await expect(panel).not.toContainText(/(?:\$0|\b0 tokens\b)/i)
}

/** Asserts the task-workbench record-source notice carrying the scenario's expected text. */
export async function expectSourceNotice(panel: Locator, text: RegExp): Promise<void> {
  await expect(
    panel.getByTestId('task-workbench-history-record-sources').filter({ hasText: text })
  ).toBeVisible()
}
