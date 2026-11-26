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

/** Asserts the task-workbench archived trace, remote agent row, and locate-trace action. */
export async function expectArchivedRemoteAgentRow(
  panel: Locator,
  opts: { runKind?: RegExp } = {}
): Promise<void> {
  const history = panel.getByTestId('task-workbench-history')
  await expect(history).toHaveAttribute('data-trace', 'archived', { timeout: 45_000 })
  const details = history.getByTestId('task-workbench-history-details')
  if ((await details.count()) > 0 && (await details.getAttribute('aria-expanded')) !== 'true') {
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true')
  }
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
