import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal
} from './web-runtime-session'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  seedNativeChatSubmittedLaunchPromptForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab,
  seedNativeChatSubmittedLaunchPromptForAgentTab:
    mocks.seedNativeChatSubmittedLaunchPromptForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('keeps same-ID local and runtime worktrees on the selected runtime owner', async () => {
    const selectedHosts: (string | undefined)[] = []
    mocks.setActiveWorktree.mockImplementation((_worktreeId: string, executionHostId?: string) => {
      selectedHosts.push(executionHostId)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1', leafId: 'host-leaf-1' } }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toEqual({ status: 'created' })

    expect(selectedHosts).toEqual([RUNTIME_EXECUTION_HOST_ID])
  })

  it.each(
    [
      { sessionKind: 'fresh' as const, activate: true },
      { sessionKind: 'fresh' as const, activate: false },
      { sessionKind: 'resume' as const, activate: true },
      { sessionKind: 'resume' as const, activate: false }
    ].flatMap((entry) =>
      [true, false].map((keyboardSupported) => ({ ...entry, keyboardSupported }))
    )
  )(
    'keeps $sessionKind host creation background with activate=$activate and keyboard=$keyboardSupported',
    async ({ sessionKind, activate, keyboardSupported }) => {
      const hostTabId = `host-${sessionKind}-${activate ? 'active' : 'background'}`
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                'agent-session.host-authority.v1',
                ...(keyboardSupported ? ['agent-session.keyboard.v1'] : [])
              ]
            }
          }
        }
        if (
          request.method === 'terminal.createAgentSession' ||
          request.method === 'terminal.ensureAgentSession'
        ) {
          return {
            id: 'agent-session',
            ok: true,
            result: {
              terminal: {
                handle: `term-${sessionKind}`,
                worktreeId: WORKTREE_ID,
                tabId: hostTabId,
                paneKey: `${hostTabId}:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: sessionKind,
          launchAgent: 'codex',
          ...(sessionKind === 'resume'
            ? {
                command: "codex resume 'session-1'",
                providerSession: { key: 'session_id' as const, id: 'session-1' }
              }
            : {}),
          activate
        })
      ).resolves.toEqual({ status: 'created' })

      const authorityMethod =
        sessionKind === 'resume' ? 'terminal.ensureAgentSession' : 'terminal.createAgentSession'
      const authorityRequest = runtimeCall.mock.calls.find(
        ([request]) => request.method === authorityMethod
      )?.[0]
      expect(authorityRequest).toMatchObject({
        selector: ENVIRONMENT_ID,
        method: authorityMethod,
        params: { presentation: 'background' }
      })
      if (keyboardSupported) {
        expect(authorityRequest).toHaveProperty('params.terminalKittyKeyboardProtocol', true)
      } else {
        expect(authorityRequest).not.toHaveProperty('params.terminalKittyKeyboardProtocol')
      }
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual(
        activate ? { hostTabId, leafId: FOCUS_LEAF_ID } : null
      )
      expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledTimes(activate ? 1 : 0)
    }
  )

  it.each([
    { gated: false, authority: false },
    { gated: true, authority: true }
  ])(
    'routes a Kimi resume by capability (advertised=$gated) instead of the generic host-authority probe',
    async ({ gated, authority }) => {
      // Why: an old host answers the widened ensureAgentSession enum with invalid_argument, which
      // runRemoteAgentSessionLaunch does not retry on — the per-agent probe is the only thing
      // keeping a remote Kimi resume from dying instead of degrading to a legacy launch.
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: [
                'agent-session.host-authority.v1',
                ...(gated ? ['agent-session.kimi-resume.v1'] : [])
              ]
            }
          }
        }
        if (request.method === 'terminal.ensureAgentSession') {
          return {
            id: 'ensure',
            ok: true,
            result: {
              terminal: {
                handle: 'term-kimi',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-kimi',
                paneKey: `host-tab-kimi:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === 'session.tabs.createTerminal') {
          return {
            id: 'legacy-create',
            ok: true,
            result: { tab: { id: 'host-tab-kimi', leafId: FOCUS_LEAF_ID } }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: 'resume',
          launchAgent: 'kimi',
          command: "kimi '--session' 'session_431324d7'",
          providerSession: { key: 'session_id', id: 'session_431324d7' }
        })
      ).resolves.toEqual({ status: 'created' })

      const methods = runtimeCall.mock.calls.map(([request]) => request.method)
      expect(methods.includes('terminal.ensureAgentSession')).toBe(authority)
      expect(methods.includes('session.tabs.createTerminal')).toBe(!authority)
    }
  )

  // Issue #60: the host once rebuilt the command from its own Settings while taking this client's
  // arguments, so a wrapper's `$0` marker became the agent's first prompt. A launch this client
  // prepared travels as one command and must never be rebuilt on the host.
  it('runs a client-owned command as it stands instead of rebuilding it on the host', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: { tab: { id: 'host-tab-trae', leafId: FOCUS_LEAF_ID } }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        launchAgent: 'trae',
        preparedAgentCommand: true,
        command: `sh '-c' 'exec traecli "$@"' 'wrapper-dispatch' '--yolo'`,
        launchConfig: {
          agentArgs: `-c 'exec traecli "$@"' wrapper-dispatch --yolo`,
          agentEnv: {}
        }
      })
    ).resolves.toEqual({ status: 'created' })

    const methods = runtimeCall.mock.calls.map(([request]) => request.method)
    // Why: `terminal.createAgentSession` is exactly the method that rebuilds the launch from the
    // host's Settings, so reaching it would re-create the mixed command from the incident.
    expect(methods).not.toContain('terminal.createAgentSession')
    const legacy = runtimeCall.mock.calls.find(
      ([request]) => request.method === 'session.tabs.createTerminal'
    )?.[0] as unknown as { params: Record<string, unknown> }
    expect(legacy.params).toMatchObject({
      command: `sh '-c' 'exec traecli "$@"' 'wrapper-dispatch' '--yolo'`,
      launchAgent: 'trae'
    })
    // The arguments are inside the command; sending them beside it is the mix being prevented.
    expect(legacy.params).not.toHaveProperty('agentArgs')
  })

  it('creates paired web agents through host authority so activation is mirrored', async () => {
    const snapshot = {
      ...makeSnapshot(),
      snapshotVersion: 2,
      activeTabId: 'host-tab-2::leaf-1',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab-2::leaf-1',
          parentTabId: 'host-tab-2',
          leafId: 'leaf-1',
          title: 'Terminal 2',
          terminal: 'pty-2',
          status: 'ready' as const,
          isActive: true
        }
      ]
    }
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities: ['agent-session.host-authority.v1']
        }
      })
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          terminal: {
            id: 'pty-2',
            handle: 'term_2',
            title: 'Terminal 2',
            cwd: '/repo/packages/app',
            worktreeId: WORKTREE_ID,
            tabId: 'host-tab-2',
            paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
          },
          disposition: 'created'
        }
      })
      .mockResolvedValueOnce({
        id: 'move',
        ok: true,
        result: { moved: true }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: snapshot
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        targetGroupId: 'group-left',
        command: "codex 'linked issue context'",
        cwd: '/repo/packages/app',
        env: { CODEX_PROFILE: 'captured' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        startupCommandDelivery: 'shell-ready',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        viewMode: 'chat',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      expectedEnvironmentPairingRevision: undefined,
      method: 'terminal.createAgentSession',
      params: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: `id:${WORKTREE_ID}`,
        agent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        startupCwd: '/repo/packages/app',
        viewMode: 'chat',
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-2',
        targetGroupId: 'group-left',
        kind: 'move-to-group'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(4, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID
    )
  })

  it.each(['session.tabs.move', 'session.tabs.list'] as const)(
    'treats %s failure after host creation as accepted so callers do not duplicate the agent',
    async (failedMethod) => {
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                id: 'pty-created',
                handle: 'term_created',
                title: 'Codex',
                cwd: '/repo',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-created',
                paneKey: `host-tab-created:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === failedMethod) {
          throw new Error(`${failedMethod} unavailable`)
        }
        return { id: 'ok', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          targetGroupId: failedMethod === 'session.tabs.move' ? 'group-left' : undefined,
          launchAgent: 'codex',
          activate: true
        })
      ).resolves.toEqual({ status: 'created' })

      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(1)
    }
  )

  it('replays an ambiguous fresh-create failure with the same operation ID', async () => {
    const operationIds: string[] = []
    let createAttempts = 0
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        operationIds.push((request.params as { clientOperationId: string }).clientOperationId)
        createAttempts += 1
        if (createAttempts === 1) {
          throw new Error('connection closed before response')
        }
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_replayed',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-replayed',
              paneKey: `host-tab-replayed:${FOCUS_LEAF_ID}`
            },
            disposition: 'replayed'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
    ).resolves.toEqual({ status: 'created' })

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).toBe(operationIds[1])
  })

  it('delivers generated continuation context after host-authoritative creation', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: 'claude',
        promptAfterReady: 'continue the unfinished task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    const createRequest = runtimeCall.mock.calls.find(
      ([request]) => request.method === 'terminal.createAgentSession'
    )?.[0]
    expect(createRequest).toMatchObject({ params: { agent: 'claude' } })
    expect(createRequest?.params).not.toHaveProperty('prompt')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      content: 'continue the unfinished task',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('returns the known process mismatch from a client-owned host fallback', async () => {
    const failure = {
      reason: 'process-mismatch' as const,
      expectedProcess: 'claude',
      foregroundProcess: 'sh'
    }
    mocks.deliverLaunchPromptToAgentTab.mockImplementation(
      async (args: { onTimeout?: (reason: typeof failure) => void }) => {
        args.onTimeout?.(failure)
        return false
      }
    )
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.launch-prompt-delivery.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created',
            promptDelivery: { state: 'not-requested' }
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: 'claude',
        prompt: 'deliver the task',
        promptDelivery: 'auto-submit',
        hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
        promptAfterReady: 'deliver the task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({
      outcome: { status: 'created' },
      promptDelivered: false,
      failureReason: failure
    })
  })

  it.each([
    ['trae', 'argv'],
    ['pi', 'env-hook']
  ] as const)(
    'accepts host-settled %s delivery without writing through the mirrored tab',
    async (agent, transport) => {
      const verdict = vi.fn()
      const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.launch-prompt-delivery.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                handle: 'term_created',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-2',
                paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
              },
              disposition: 'created',
              promptDelivery: { state: 'launch-bound', transport }
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeAgentSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: 'fresh',
          agent,
          command: agent === 'trae' ? 'traecli --yolo' : 'pi',
          prompt: 'deliver the task',
          promptDelivery: 'auto-submit',
          hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
          promptAfterReady: 'deliver the task',
          submitPrompt: true,
          forcePromptPaste: true,
          onSubmitVerdict: verdict
        })
      ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

      expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
      expect(verdict).toHaveBeenCalledWith('written')
      expect(
        runtimeCall.mock.calls.find(([request]) => request.method === 'terminal.createAgentSession')
          ?.[0]
      ).toMatchObject({
        params: { agent, prompt: 'deliver the task', promptDelivery: 'auto-submit' }
      })
      expect(mocks.seedNativeChatSubmittedLaunchPromptForAgentTab).toHaveBeenCalledWith({
        tabId: 'web-terminal-host-tab-2',
        agent,
        text: 'deliver the task'
      })
    }
  )

  it('fails closed when a capable host omits the launch delivery settlement', async () => {
    const verdict = vi.fn()
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.launch-prompt-delivery.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'trae',
        prompt: 'deliver the task',
        promptDelivery: 'auto-submit',
        hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
        promptAfterReady: 'deliver the task',
        submitPrompt: true,
        forcePromptPaste: true,
        onSubmitVerdict: verdict
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: false })

    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
    expect(verdict).toHaveBeenCalledWith('unconfirmed')
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.createTerminal'
    )
  })

  it('pastes when a capable host reports it bound no submitted prompt', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.launch-prompt-delivery.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created',
            promptDelivery: { state: 'not-requested' }
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        prompt: 'keep this draft editable',
        promptDelivery: 'auto-submit',
        hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
        promptAfterReady: 'keep this draft editable',
        submitPrompt: false,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      content: 'keep this draft editable',
      agent: 'claude',
      submit: false,
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
    expect(mocks.seedNativeChatSubmittedLaunchPromptForAgentTab).not.toHaveBeenCalled()
  })

  it('keeps prompt paste on the legacy path for a host without the new capability', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: { tab: { id: 'host-tab-trae', leafId: FOCUS_LEAF_ID } }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'trae',
        command: 'traecli --yolo',
        prompt: 'deliver the task',
        promptDelivery: 'auto-submit',
        hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
        promptAfterReady: 'deliver the task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    const methods = runtimeCall.mock.calls.map(([request]) => request.method)
    expect(methods).not.toContain('terminal.createAgentSession')
    expect(methods).toContain('session.tabs.createTerminal')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-trae',
      content: 'deliver the task',
      agent: 'trae',
      submit: true,
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('falls back to one legacy create when the host rejects a live-PTY adapter before spawn', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.launch-prompt-delivery.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'structured-create',
          ok: false,
          error: {
            code: 'agent_session_legacy_required',
            message: 'live PTY delivery remains client-owned'
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: { tab: { id: 'host-tab-zcode', leafId: FOCUS_LEAF_ID } }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'zcode',
        command: 'zcode',
        prompt: 'deliver the task',
        promptDelivery: 'auto-submit',
        hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1',
        promptAfterReady: 'deliver the task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    const methods = runtimeCall.mock.calls.map(([request]) => request.method)
    expect(methods.filter((method) => method === 'terminal.createAgentSession')).toHaveLength(1)
    expect(methods.filter((method) => method === 'session.tabs.createTerminal')).toHaveLength(1)
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-zcode',
      content: 'deliver the task',
      agent: 'zcode',
      submit: true,
      forcePaste: true,
      onTimeout: expect.any(Function)
    })
  })

  it('seeds the chat composer for a draft that rode in on the launch command', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.createAgentSession') {
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
            },
            disposition: 'created'
          }
        }
      }
      return { id: 'list', ok: true, result: makeSnapshot() }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeAgentSessionTerminalWithLaunchDraft({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: "claude --prefill 'https://github.com/o/r/issues/12'",
        launchDraft: 'https://github.com/o/r/issues/12'
      })
    ).resolves.toEqual({ status: 'created' })

    // No paste runs for an argv-prefill draft, so this is the only thing that
    // fills the mirrored tab's composer on this host class.
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      agent: 'claude',
      text: 'https://github.com/o/r/issues/12'
    })
  })
})
