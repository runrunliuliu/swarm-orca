import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { parse as parseYaml } from 'yaml'
import { PR_E2E_SOURCE_ROUTES } from './pr-e2e-source-routing.mjs'

export const projectDir = resolve(import.meta.dirname, '../..')
export const prWorkflow = parseYaml(
  readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8')
)
export const e2eWorkflow = parseYaml(
  readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8')
)
export const reliabilityManifest = parseJsonc(
  readFileSync(join(projectDir, 'config/reliability-gates.jsonc'), 'utf8')
)
export const playwrightConfig = readFileSync(join(projectDir, 'tests/playwright.config.ts'), 'utf8')
export const sshDockerRunner = readFileSync(
  join(projectDir, 'config/scripts/run-ssh-docker-terminal-parking-e2e.mjs'),
  'utf8'
)
export const nativeImeWorkflow = parseYaml(
  readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
)
export const nativeImeRunner = readFileSync(
  join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
  'utf8'
)
export const nativeImeSpec = readFileSync(
  join(projectDir, 'tests/e2e/terminal-ibus-hangul-native.spec.ts'),
  'utf8'
)

export const filterStep = prWorkflow.jobs.code_paths.steps.find(
  (step) => step.name === 'Filter changed E2E specs'
)
export const rollbackStep = prWorkflow.jobs.static_analysis.steps.find(
  (step) => step.name === 'Check VM runtime rollback compatibility'
)
export const verifyStep = prWorkflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)

/** The route that sends a change to the two-Electron restart-survival spec. */
export const restartSurvivalRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'client-hosted-browser.restart-survival'
)
export const remoteOnlyTaskRecordRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'task-workbench.remote-only-record'
)
export const simRemoteKitRoute = PR_E2E_SOURCE_ROUTES.find((route) => route.id === 'sim-remote.kit')
export const remoteHistoryScenariosRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'task-workbench.remote-history-scenarios'
)

/**
 * How many specs one representative task-workbench change may select.
 *
 * Fresh W16 measurements on `3115ea9e` plus the final simulation deliverable, at `--workers=1`
 * with `SKIP_BUILD=1` reusing one `--mode e2e` build: the six selected files passed in 221.446 s
 * in one Playwright invocation and in 228.090 s as six separate invocations. The budget remains
 * exactly 6 because it guards route breadth, not a wall-time SLA; raising it means re-measuring
 * both shapes and updating these figures so a route addition cannot widen the lane invisibly.
 */
export const REPRESENTATIVE_CHANGE_SPEC_BUDGET = 6
