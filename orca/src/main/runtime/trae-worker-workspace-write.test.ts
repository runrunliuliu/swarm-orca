import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { WorkerStartParams } from '../../shared/rpc-contract/orchestration-worker-start-params'
import { prepareTraeWorkerWorkspaceWrite } from './trae-worker-workspace-write'

describe.skipIf(process.platform === 'win32')('Trae worker workspace-write launch', () => {
  let fixture: string
  let workspace: string
  let homePath: string
  let evidence: string
  beforeEach(async () => {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-worker-roots-')))
    workspace = join(fixture, 'workspace')
    homePath = join(fixture, 'home')
    evidence = join(fixture, "evidence ' $() ` ; \\ dir")
    await Promise.all([workspace, homePath, evidence].map((path) => mkdir(path)))
  })
  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })
  const prepare = (
    overrides: Partial<Parameters<typeof prepareTraeWorkerWorkspaceWrite>[0]> = {}
  ) =>
    prepareTraeWorkerWorkspaceWrite({
      platform: 'linux',
      executionHostId: 'local',
      connectionId: null,
      workspacePath: workspace,
      homePath,
      writableRoots: [evidence],
      ...overrides
    })

  it('quotes and deduplicates exact roots without claiming live verification', async () => {
    const result = await prepare({ writableRoots: [evidence, evidence, workspace] })
    expect(tokenizeStartupCommand(result.agentArgs, 'posix')).toMatchObject({
      ok: true,
      tokens: [
        '--no-daemon',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--add-dir',
        evidence,
        '--add-dir',
        workspace
      ]
    })
    expect(result.receipt).toEqual({
      source: 'launch_arguments',
      workspaceRoot: workspace,
      writableRoots: [evidence, workspace],
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      networkAccess: true,
      independentSession: true,
      actualSessionVerified: false
    })
  })

  it('replaces default args without mutating shared settings or losing model options', async () => {
    const result = await prepare()
    const settings = {
      agentDefaultArgs: { trae: '--yolo --remote existing' },
      agentCmdOverrides: { trae: 'traecli' }
    }
    const sessionOptions = { model: 'gpt-5.5', effort: 'high', backendVariant: 'max' }
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'trae',
      settings,
      platform: 'linux',
      isRemote: false,
      agentArgs: result.agentArgs,
      sessionOptions
    })
    expect(inputs.agentArgs).toBe(result.agentArgs)
    expect(inputs.sessionOptions).toEqual(sessionOptions)
    expect(inputs.sessionOptionsOverrideAgentArgs).toBe(true)
    const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
    if (!plan) {
      throw new Error('Expected a startup plan')
    }
    expect(tokenizeStartupCommand(plan.launchCommand, 'posix')).toMatchObject({
      ok: true,
      tokens: [
        'traecli',
        '--no-daemon',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '--add-dir',
        evidence,
        '--model',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'model_backend_variant="max"'
      ]
    })
    expect(plan.sessionOptions).toEqual(sessionOptions)
    expect(settings.agentDefaultArgs.trae).toBe('--yolo --remote existing')
  })

  it.each(['traecli', 'traex-tui', '/traecli', '/example/home/.local/bin/traecli'])(
    'accepts plain launcher %s',
    async (commandOverride) => {
      await expect(prepare({ commandOverride })).resolves.toBeDefined()
    }
  )
  it.each([
    'traecli --remote old',
    'traecli resume',
    'env traecli',
    './traecli',
    '/tmp/a b/traecli',
    'traecli;true'
  ])('refuses embedded or ambiguous launcher %s', async (commandOverride) => {
    await expect(prepare({ commandOverride })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
  it.each([
    { platform: 'win32' as const },
    { executionHostId: 'ssh:test' },
    { executionHostId: 'wsl:test' },
    { executionHostId: 'runtime:test' },
    { connectionId: 'ssh-test' }
  ])('refuses unsupported host before filesystem lookup %o', async (overrides) => {
    await expect(prepare({ workspacePath: '/nonexistent', ...overrides })).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
  it('accepts macOS canonical paths', async () => {
    await expect(prepare({ platform: 'darwin' })).resolves.toBeDefined()
  })
  it('refuses broad, relative, noncanonical, missing and non-directory roots', async () => {
    const file = join(fixture, 'file')
    const alias = join(fixture, 'alias')
    await writeFile(file, 'test')
    await symlink(evidence, alias)
    for (const root of [
      '/',
      homePath,
      fixture,
      'relative',
      `${evidence}/`,
      `${workspace}/../workspace`,
      alias,
      file,
      join(fixture, 'missing')
    ]) {
      await expect(prepare({ writableRoots: [root] }), root).rejects.toThrow()
    }
    await expect(prepare({ workspacePath: alias })).rejects.toThrow('canonical')
    await expect(prepare({ workspacePath: homePath })).rejects.toThrow('home')
    await expect(prepare({ workspacePath: fixture })).rejects.toThrow('home')
  })

  it.each(
    [[], [''], ['a\n'], ['a\u0000'], [false], Array(33).fill('/tmp'), ['x'.repeat(4097)]].map(
      (writableRoots) => ({ writableRoots })
    )
  )('rejects malformed RPC roots %j', ({ writableRoots }) => {
    expect(() => WorkerStartParams.parse({ spec: 'test', from: 'coord', writableRoots })).toThrow()
  })
})
