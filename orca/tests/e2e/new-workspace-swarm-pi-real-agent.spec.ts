import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getPiPrefillExtensionSource } from '../../src/main/pi/prefill-extension-source'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * Opt-in proof that a *real* pi starts a turn from the Coordinator brief.
 *
 * `new-workspace-swarm-pi-brief.spec.ts` proves the app side at the exec boundary
 * (env seed + submit flag, inside the workspace it just created) with a stub, and
 * the #54 fix commit proves the extension separately in a PTY. Neither run shows
 * the two together. This spec does: pi 1.x loads the extension source the app is
 * shipped with, `pi.sendUserMessage` fires, and pi persists the brief as a
 * submitted user message and answers it.
 *
 * Why the extension file is seeded here instead of left to Orca: managed Pi
 * extensions are installed during PTY host-env assembly (`buildPtyHostEnv`), but
 * a run of this spec against an empty agent dir confirmed that no `extensions/`
 * file appeared there, so the only thing a launch could have delivered was the
 * env seed with nobody to consume it. The installer half is therefore *not*
 * covered here; seeding keeps this spec about the part that can silently regress
 * without an error (pi's own `sendUserMessage` contract, and the extension source
 * the app generates).
 *
 * Opt-in, because it needs things CI does not have: a `pi` on PATH and a working
 * provider in `~/.pi/agent`. Gate:
 *
 *   ORCA_PI_REAL_AGENT=1 DISPLAY=:99 npx playwright test \
 *     tests/e2e/new-workspace-swarm-pi-real-agent.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 *
 * Cost and blast radius: one real model request against whatever `~/.pi/agent`
 * selects. The provider config is *copied* (never read from this repo, never
 * committed) into a temp agent dir, and the agent is launched with
 * `--exclude-tools bash,edit,write` so it answers instead of working in the
 * throwaway seeded repo.
 */
const GATE_ENV = 'ORCA_PI_REAL_AGENT'
const SKILL_PATH = 'swarm/skills/swarm-orchestration/SKILL.md'
const NOTE = `REAL_AGENT_NOTE_${process.pid}_${Date.now()}`
const MAX_WORKERS = '2'
const PROVIDER_FILES = ['models.json', 'models-store.json', 'auth.json', 'settings.json']
const SOURCE_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent')
// Why launch-env rather than `settings.agentDefaultEnv`: the agent dir is resolved
// while the PTY host env is assembled, and a setting-only override measured as not
// reaching that point.
// Why gated: a skipped file never runs its afterAll, so an ungated mkdtemp would
// leave one empty dir behind on every CI run.
const RUN_ROOT = process.env[GATE_ENV]
  ? mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-pi-real-'))
  : path.join(os.tmpdir(), 'orca-e2e-pi-real-never-created')
const AGENT_DIR = path.join(RUN_ROOT, 'agent')
const SESSION_DIR = path.join(RUN_ROOT, 'sessions')

// Why module scope: the app env has to be complete before Electron starts.
if (process.env[GATE_ENV]) {
  mkdirSync(path.join(AGENT_DIR, 'extensions'), { recursive: true })
  mkdirSync(SESSION_DIR, { recursive: true })
  for (const name of PROVIDER_FILES) {
    const from = path.join(SOURCE_AGENT_DIR, name)
    if (existsSync(from)) {
      copyFileSync(from, path.join(AGENT_DIR, name))
    }
  }
  writeFileSync(
    path.join(AGENT_DIR, 'extensions', 'orca-prefill.ts'),
    `// @orca-managed-pi-extension (seeded by this spec)\n${getPiPrefillExtensionSource('pi')}`
  )
}

test.use({
  launchEnv: process.env[GATE_ENV]
    ? { PI_CODING_AGENT_DIR: AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: SESSION_DIR }
    : {}
})

test.afterAll(() => {
  rmSync(RUN_ROOT, { recursive: true, force: true })
})

type Transcript = {
  cwd: string | null
  messages: { role: string; text: string }[]
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : ''
    )
    .join('\n')
}

function readTranscripts(sessionDir: string): Transcript[] {
  if (!existsSync(sessionDir)) {
    return []
  }
  return readdirSync(sessionDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const transcript: Transcript = { cwd: null, messages: [] }
      for (const line of readFileSync(path.join(sessionDir, name), 'utf8').split('\n')) {
        if (!line.trim()) {
          continue
        }
        let entry: { type?: string; cwd?: string; message?: { role?: string; content?: unknown } }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type === 'session' && entry.cwd) {
          transcript.cwd = entry.cwd
        }
        if (entry.type === 'message' && entry.message?.role) {
          transcript.messages.push({
            role: entry.message.role,
            text: flattenText(entry.message.content)
          })
        }
      }
      return transcript
    })
}

async function createSwarmWorkspace(page: Page, name: string): Promise<void> {
  await openSidebarWorkspaceComposer(page)
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: 'Advanced' }).click()
  await dialog.getByPlaceholder('Write a note').fill(NOTE)
  await expect(dialog.locator('[data-agent-combobox-root="true"]')).toContainText('Pi')
  await dialog.getByRole('button', { name: /Swarm Coordinator/ }).click()
  await dialog.getByLabel('max_workers').fill(MAX_WORKERS)
  await expect(dialog.locator('[data-new-workspace-launch-mode="swarm"]')).toBeVisible()
  await dialog.getByRole('button', { name: /^Create/ }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
}

test('a real pi turns the Coordinator brief into a session user message', async ({
  orcaPage
}, testInfo) => {
  test.skip(!process.env[GATE_ENV], `opt-in: set ${GATE_ENV}=1 (spends one model request)`)
  test.skip(process.platform === 'win32', 'POSIX-only proof: pi agent dir layout and PATH `pi`')
  test.setTimeout(300_000)

  let piOnPath = true
  try {
    execFileSync('which', ['pi'], { stdio: 'pipe' })
  } catch {
    piOnPath = false
  }
  test.skip(!piOnPath, 'no `pi` on PATH')
  test.skip(
    !existsSync(path.join(AGENT_DIR, 'models.json')),
    'no ~/.pi/agent/models.json to copy a provider from'
  )

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({
      defaultTuiAgent: 'pi',
      // Why: bound both spend and side effects. Delivery is what this spec proves;
      // letting a real agent act inside the throwaway seeded repo is not.
      agentDefaultArgs: { pi: '--exclude-tools bash,edit,write' }
    })
  })

  const workspaceName = `swarm-pi-real-${Date.now()}`
  let createdWorktreeId: string | null = null
  try {
    await createSwarmWorkspace(orcaPage, workspaceName)
    await expect(
      orcaPage.locator('[role="option"]').filter({ hasText: workspaceName })
    ).toBeVisible({ timeout: 60_000 })
    createdWorktreeId = await waitForActiveWorktree(orcaPage)

    let briefMessage: string | null = null
    let sawReply = false
    await expect
      .poll(
        () => {
          for (const transcript of readTranscripts(SESSION_DIR)) {
            const userIndex = transcript.messages.findIndex(
              (message) => message.role === 'user' && message.text.includes(SKILL_PATH)
            )
            if (userIndex === -1) {
              continue
            }
            briefMessage = transcript.messages[userIndex]!.text
            // Why require the reply: a persisted user message alone cannot tell "the
            // brief arrived" from "sendUserMessage queued it and nothing ran". A
            // tool-call-only assistant entry counts — that is still a started turn.
            sawReply = transcript.messages
              .slice(userIndex + 1)
              .some((message) => message.role === 'assistant')
            if (sawReply) {
              return true
            }
          }
          return false
        },
        {
          timeout: 180_000,
          intervals: [1_000],
          message: 'no pi session ever recorded the Coordinator brief as a submitted user message'
        }
      )
      .toBe(true)

    const transcripts = readTranscripts(SESSION_DIR)
    const briefIn = transcripts.find((transcript) =>
      transcript.messages.some((message) => message.text.includes(SKILL_PATH))
    )
    // The agent ran inside the workspace the app created, not the parent checkout.
    expect(briefIn?.cwd ? path.basename(briefIn.cwd) : null).toBe(workspaceName)
    expect(briefMessage).toContain(`max_workers=${MAX_WORKERS}`)
    expect(briefMessage).toContain(NOTE)
    expect(sawReply).toBe(true)
  } finally {
    // Why copied before teardown: the run root is removed in afterAll, and the
    // transcript is this spec's evidence.
    for (const transcript of readTranscripts(SESSION_DIR)) {
      writeFileSync(
        testInfo.outputPath(`transcript-${Date.now()}.json`),
        JSON.stringify(transcript, null, 2)
      )
    }
    if (createdWorktreeId) {
      // Why swallowed: a failed cleanup must not replace the real assertion failure.
      await orcaPage
        .evaluate(async (id) => {
          await window.__store?.getState().removeWorktree({ id, executionHostId: null }, true)
        }, createdWorktreeId)
        .catch((error: unknown) => {
          console.warn('worktree cleanup skipped', error)
        })
    }
  }
})
