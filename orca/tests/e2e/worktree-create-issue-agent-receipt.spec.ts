import { expect, test as base } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  GOLDEN_STUB_READY_MARKER,
  getGoldenStubAgentLaunchEnv
} from './helpers/golden-stub-agent'
import { startScenarioEvidence } from './helpers/evidence-capture'
import {
  autoEvolveCommand,
  buildAutoEvolveCreateParams,
  writeAutoEvolveCreateParams
} from './helpers/auto-evolve-fixture'
import {
  agentTail,
  cliPrefix,
  openWorkspace,
  runCreateInTerminal,
  waitForJsonFile,
  worktreeTab,
  type CliReceipt
} from './helpers/worktree-create-cli'
import { shellQuote } from './helpers/shell-quote'
import { prepareWorktreeCreateHarness, seededBaseSha } from './helpers/worktree-create-harness'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

/**
 * Two ways an issue-linked workspace can be created, and the one thing both must prove: a created
 * workspace is not a started agent.
 *
 * - CLI (`worktree create --issue`): no `--agent` yields `agentStarted: false` plus a warning and
 *   an interactive shell; `--agent codex` yields `agentStarted: true`, `createdWithAgent`, a tab
 *   and a running PTY.
 * - Skill (`auto-evolve/scripts/rpc.py --execute`): the receipt keeps the issue/work-item/task
 *   source bindings, names the requested agent, and its own assertion turns a create without an
 *   agent into `agent_not_started` instead of a pass.
 *
 * Negative claim: the no-agent workspace never runs an agent, so its pane must answer a shell
 * command. That fact is invisible in a receipt and in a sidebar that lists both workspaces.
 */

const test = base.extend({
  launchEnv: [getGoldenStubAgentLaunchEnv(), { option: true }]
})

const ISSUE = 77
const CLI_COMMAND =
  'npx playwright test --config tests/playwright.config.ts --project=electron-headless tests/e2e/worktree-create-issue-agent-receipt.spec.ts --workers=1 -g "issue create distinguishes"'
const SKILL_COMMAND =
  'npx playwright test --config tests/playwright.config.ts --project=electron-headless tests/e2e/worktree-create-issue-agent-receipt.spec.ts --workers=1 -g "auto_evolve execute"'

const NOT_CAPTURED_AGENT = [
  'A real codex/claude model turn: the agent is the golden stub, so launch is proven, model work is not.',
  'The agent tab renders blank in this build because a silently adopted background PTY does not replay scrollback into a newly mounted pane; liveness is proven by terminal.read.',
  'GitHub issue resolution and any deploy/install/merge step.'
]

test('issue create distinguishes a bare shell from a started agent', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const harness = await prepareWorktreeCreateHarness({
    page: orcaPage,
    electronApp,
    seededRepoPath
  })
  const evidence = await startScenarioEvidence({
    page: orcaPage,
    electronApp,
    slug: 'issue-77-cli-receipt'
  })
  const runTag = String(Date.now())
  try {
    await evidence.capture(
      '01-scenario-app-ready.png',
      'Seeded repo active and the CLI terminal ready before any create.'
    )

    // ── No --agent: workspace plus issue link, no agent, and the receipt says so ─────────────
    const noAgent = await runCreateInTerminal(
      orcaPage,
      harness.shellPtyId,
      harness.userDataDir,
      [
        'worktree',
        'create',
        '--repo',
        `id:${harness.repoId}`,
        '--name',
        `issue-77-no-agent-${runTag}`,
        '--issue',
        String(ISSUE),
        '--no-parent',
        '--json'
      ],
      testInfo.outputPath(`no-agent-receipt-${runTag}.json`)
    )
    harness.createdWorktreeIds.push(noAgent.result.worktree.id)
    expect(noAgent.ok).toBe(true)
    expect(noAgent.result.agentStarted).toBe(false)
    expect(noAgent.result.warning).toContain('--agent')
    expect(noAgent.result.agentTerminalHandle).toBeUndefined()
    expect(noAgent.result.worktree.linkedIssue).toBe(ISSUE)
    expect(noAgent.result.worktree.createdWithAgent).toBeUndefined()
    await waitForTerminalOutput(orcaPage, '"agentStarted": false', 15_000)
    await evidence.capture(
      '02-scenario-no-agent-receipt.png',
      'Receipt for the issue-linked create without --agent: agentStarted false plus the warning.'
    )

    // ── The no-agent workspace is a shell, not a silent agent ───────────────────────────────
    await openWorkspace(orcaPage, noAgent.result.worktree.id)
    const noAgentPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, noAgentPtyId, 20_000)
    await execInTerminal(orcaPage, noAgentPtyId, 'echo NO_AGENT_SHELL:$PWD')
    await waitForTerminalOutput(orcaPage, 'NO_AGENT_SHELL:', 20_000)
    await evidence.capture(
      '03-scenario-no-agent-workspace-shell.png',
      'The same workspace answers NO_AGENT_SHELL:<path>: it is a shell, not an agent.'
    )

    // ── With --agent: the same request starts the requested agent ───────────────────────────
    await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
    const agentReceiptPath = testInfo.outputPath(`agent-receipt-${runTag}.json`)
    const agent = await runCreateInTerminal(
      orcaPage,
      noAgentPtyId,
      harness.userDataDir,
      [
        'worktree',
        'create',
        '--repo',
        `id:${harness.repoId}`,
        '--name',
        `issue-77-agent-${runTag}`,
        '--issue',
        String(ISSUE),
        '--agent',
        'codex',
        '--prompt',
        'Issue 77 E2E: report ready.',
        '--no-parent',
        '--json'
      ],
      agentReceiptPath
    )
    harness.createdWorktreeIds.push(agent.result.worktree.id)
    expect(agent.ok).toBe(true)
    expect(agent.result.agentStarted).toBe(true)
    expect(agent.result.worktree.createdWithAgent).toBe('codex')
    const agentHandle = agent.result.agentTerminalHandle ?? agent.result.startupTerminal?.handle
    const tabId = agent.result.startupTerminal?.tabId
    expect(agentHandle).toBeTruthy()
    expect(tabId).toBeTruthy()
    // A background create leaves the agent terminal off-tab, so the runtime buffer is the proof
    // that the process ran; the tab assertion below proves the workspace owns it.
    await expect
      .poll(() => agentTail(harness.userDataDir, String(agentHandle)), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)

    await openWorkspace(orcaPage, agent.result.worktree.id)
    await expect(worktreeTab(orcaPage, String(tabId))).toBeVisible({ timeout: 30_000 })
    await evidence.capture(
      '04-scenario-agent-workspace-ready.png',
      'The create with --agent owns an agent tab in the new workspace.'
    )

    // ── Back in the shell: show the agent receipt and the agent's own PTY tail ─────────────
    await openWorkspace(orcaPage, noAgent.result.worktree.id)
    const receiptPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, receiptPtyId, 20_000)
    await execInTerminal(
      orcaPage,
      receiptPtyId,
      [
        `grep -E '"agentStarted"|"warning"|"createdWithAgent"' ${shellQuote(agentReceiptPath)}`,
        `; ${cliPrefix(harness.userDataDir)} terminal read --terminal ${shellQuote(String(agentHandle))} --limit 40 --json`
      ].join(' ')
    )
    await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
    await evidence.capture(
      '05-scenario-agent-pty-tail.png',
      'The agent receipt plus terminal.read of its handle: status running and the stub ready marker.'
    )

    await evidence.finish({
      slug: 'issue-77-cli-receipt',
      issue: ISSUE,
      command: CLI_COMMAND,
      notCaptured: NOT_CAPTURED_AGENT
    })
  } finally {
    await evidence.abort()
    await harness.cleanup()
  }
})

test('auto_evolve execute creates the workspace and starts the agent', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const harness = await prepareWorktreeCreateHarness({
    page: orcaPage,
    electronApp,
    seededRepoPath
  })
  const evidence = await startScenarioEvidence({
    page: orcaPage,
    electronApp,
    slug: 'issue-77-auto-evolve-execute'
  })
  const runTag = String(Date.now())
  try {
    const paramsPath = writeAutoEvolveCreateParams(
      testInfo.outputPath(`auto-evolve-create-params-${runTag}.json`),
      buildAutoEvolveCreateParams({
        repoId: harness.repoId,
        baseSha: seededBaseSha(seededRepoPath),
        name: `issue-77-autoevolve-${runTag}`,
        clientMutationId: `issue-77-autoevolve-${runTag}`,
        startupAgent: 'codex',
        startupPrompt: 'Issue 77 E2E: auto-evolve created this workspace; report ready.',
        issue: ISSUE
      })
    )
    await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
    const outputPath = testInfo.outputPath(`auto-evolve-receipt-${runTag}.json`)
    await execInTerminal(
      orcaPage,
      harness.shellPtyId,
      autoEvolveCommand({
        metadataPath: harness.metadataPath,
        runtimeId: harness.runtimeId,
        paramsPath,
        stateDir: testInfo.outputPath(`auto-evolve-intents-${runTag}`),
        outputPath
      })
    )
    // The echoed command contains AUTO_EVOLVE_END, so waiting on the terminal would return before
    // the script ran; wait for the redirected receipt to become complete JSON instead.
    const receipt = await waitForJsonFile<CliReceipt>(outputPath)
    if (!receipt.result) {
      throw new Error(`auto-evolve returned no result: ${JSON.stringify(receipt.error)}`)
    }
    harness.createdWorktreeIds.push(receipt.result.worktree.id)
    // rpc.py exits non-zero on agent_not_started; reaching here means the receipt assertion passed.
    expect(receipt.ok).toBe(true)
    expect(receipt.result.worktree.createdWithAgent).toBe('codex')
    expect(receipt.result.worktree.linkedIssue).toBe(ISSUE)
    expect(receipt.result.worktree.linkedWorkItem).toBeTruthy()
    expect(receipt.result.worktree.linkedTaskSourceContext).toBeTruthy()
    const agentHandle = receipt.result.agentTerminalHandle
    const tabId = receipt.result.startupTerminal?.tabId
    expect(agentHandle).toBeTruthy()
    expect(tabId).toBeTruthy()
    await waitForTerminalOutput(orcaPage, '"ok": true', 15_000)
    await evidence.capture(
      '06-scenario-autoevolve-receipt.png',
      'auto_evolve execution entry returns ok with the agent handle and the issue/task bindings.'
    )

    await expect
      .poll(() => agentTail(harness.userDataDir, String(agentHandle)), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)
    await openWorkspace(orcaPage, receipt.result.worktree.id)
    await expect(worktreeTab(orcaPage, String(tabId))).toBeVisible({ timeout: 30_000 })
    await evidence.capture(
      '07-scenario-autoevolve-agent-workspace.png',
      'The workspace the skill created owns the requested agent tab.'
    )

    // The agent's tab can be silent (silently adopted background PTY has no scrollback replay),
    // so print its live PTY tail from a shell: the ready marker is the process-level proof.
    await openWorkspace(orcaPage, harness.originalWorktreeId)
    const readPtyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, readPtyId, 20_000)
    await execInTerminal(
      orcaPage,
      readPtyId,
      `${cliPrefix(harness.userDataDir)} terminal read --terminal ${shellQuote(String(agentHandle))} --limit 40 --json`
    )
    await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
    await evidence.capture(
      '08-scenario-autoevolve-agent-pty-tail.png',
      'terminal.read of the agent handle: status running and the stub ready marker.'
    )

    await evidence.finish({
      slug: 'issue-77-auto-evolve-execute',
      issue: ISSUE,
      command: SKILL_COMMAND,
      notCaptured: [
        ...NOT_CAPTURED_AGENT,
        'The LLM step: typing "auto-evolve" into an agent TUI and the model choosing the skill. The visible command is the skill execution entry itself.'
      ],
      note: 'the visible command is scripts/rpc.py --execute, not an LLM turn'
    })
  } finally {
    await evidence.abort()
    await harness.cleanup()
  }
})
