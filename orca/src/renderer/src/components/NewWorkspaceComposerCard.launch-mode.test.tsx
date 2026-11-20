// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceLaunchMode } from '@/lib/swarm-launch-prompt'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: [],
        worktreesByRepo: {}
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(
      <NewWorkspaceComposerCard
        quickAgent={null}
        onQuickAgentChange={() => {}}
        eligibleRepos={[]}
        repoId="repo-a"
        selectedRepoIsGit
        onRepoChange={() => {}}
        onProjectChange={() => {}}
        primaryActionLabel="Create workspace"
        name=""
        onNameValueChange={() => {}}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={null}
        onClearSmartNameSelection={() => {}}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
        onReuseSelectedBranchChange={() => {}}
        forkPushWarning={null}
        detectedAgentIds={null}
        onOpenAgentSettings={() => {}}
        advancedOpen={false}
        onToggleAdvanced={() => {}}
        parentWorktreeId={null}
        onParentWorktreeIdChange={() => {}}
        createDisabled={false}
        projectError={null}
        creating={false}
        onCreate={() => {}}
        note=""
        onNoteChange={() => {}}
        setupConfig={null}
        requiresExplicitSetupChoice={false}
        setupDecision={null}
        onSetupDecisionChange={() => {}}
        setupAgentStartupPolicy="start-immediately"
        onSetupAgentStartupPolicyChange={() => {}}
        shouldWaitForSetupCheck={false}
        resolvedSetupDecision={null}
        createError={null}
        selectedRepoConnectionId={null}
        selectedRepoSshStatus={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        onConnectSelectedRepo={async () => {}}
        canUseSparseCheckout={false}
        sparsePresets={[]}
        sparseSelectedPresetId={null}
        onSparseSelectPreset={() => {}}
        branchesEnabled
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        {...overrides}
      />
    )
  })
  return container
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
}

/** Document order, so the section's placement is asserted rather than assumed. */
function followsInDocument(first: Element | null, second: Element | null): boolean {
  return (
    first !== null &&
    second !== null &&
    (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  )
}

describe('NewWorkspaceComposerCard launch mode', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('renders no start-mode control when the surface does not own that state', () => {
    container = renderCard()

    expect(container.querySelector('[data-new-workspace-launch-mode]')).toBeNull()
  })

  it('sits between the agent picker and Advanced, on the single-agent default', () => {
    container = renderCard({ launchMode: 'single', onLaunchModeChange: () => {} })

    const agentPicker = findButton(container, 'Agent picker')
    const advanced = findButton(container, 'Advanced')
    const section = container.querySelector('[data-new-workspace-launch-mode]')

    expect(followsInDocument(agentPicker ?? null, section)).toBe(true)
    expect(followsInDocument(section, advanced ?? null)).toBe(true)
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      '◇Single agent'
    )
  })

  it('shows the worker cap and the linked task source once swarm is selected', () => {
    container = renderCard({
      launchMode: 'swarm',
      onLaunchModeChange: () => {},
      maxWorkers: '3',
      smartNameSelection: { kind: 'github-issue', label: '#123' }
    })

    expect(container.querySelector('input[inputmode="numeric"]')).toBeTruthy()
    expect(container.textContent).toContain('Workers ≤ 3')
    expect(container.textContent).toContain('Task source = #123')
  })

  it('reports the picked mode to the composer', () => {
    const modes: NewWorkspaceLaunchMode[] = []
    container = renderCard({
      launchMode: 'single',
      onLaunchModeChange: (next) => modes.push(next)
    })

    act(() => findButton(container!, '◈Swarm Coordinator')?.click())

    expect(modes).toEqual(['swarm'])
  })
})
