/**
 * Acceptance declarations, verdicts and the gate's decision (§8, M5-1/M5-3) on a real database.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import {
  AcceptanceDeclarationError,
  acceptanceGateState,
  declareAcceptanceRule,
  getAcceptanceStop,
  listAcceptanceRules,
  listAcceptanceVerdicts,
  openAcceptanceStop,
  resolveAcceptanceStop,
  writeAcceptanceVerdict
} from './dispatch-acceptance-store'

const T0 = 1_700_000_000_000
const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): { db: OpenIncidentsDatabase['db']; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-acceptance-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    db: opened.db,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
  }
}

function declare(db: OpenIncidentsDatabase['db'], ruleId: string, overrides: Partial<Parameters<typeof declareAcceptanceRule>[1]> = {}) {
  return declareAcceptanceRule(db, {
    hostId: 'host-a',
    dispatchId: 'disp-1',
    ruleId,
    program: 'npm',
    args: ['test'],
    expect: { exitCode: 0 },
    cwd: '/work/tree',
    actor: 'alice',
    now: T0,
    ...overrides
  })
}

afterEach(() => {
  for (const opened of databases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('declarations', () => {
  it('is idempotent by (host, dispatch, rule): re-declaring replaces the row', () => {
    const { db } = fixture()
    declare(db, 'tests')
    declare(db, 'tests', { expect: { exitCode: 1 }, now: T0 + 1 })
    const rules = listAcceptanceRules(db, 'disp-1')
    expect(rules).toHaveLength(1)
    expect(rules[0].expect).toEqual({ exitCode: 1 })
    expect(rules[0].digest).not.toBe('')
  })

  it('keeps multiple rules, each with its own argv and expectation', () => {
    const { db } = fixture()
    declare(db, 'tests', { expect: { exitCode: 0 } })
    declare(db, 'archive', {
      program: 'cat',
      args: ['out/report.json'],
      expect: { stdoutMatches: 'PASS' }
    })
    const rules = listAcceptanceRules(db, 'disp-1')
    expect(rules.map((rule) => rule.ruleId)).toEqual(['archive', 'tests'])
    expect(rules[0]).toMatchObject({ program: 'cat', args: ['out/report.json'] })
  })

  it('refuses a declaration with no expectation, no program, no cwd or no actor', () => {
    const { db } = fixture()
    expect(() => declare(db, 'x', { expect: {} })).toThrow(AcceptanceDeclarationError)
    expect(() => declare(db, 'x', { program: '  ' })).toThrow(/missing_program/)
    expect(() => declare(db, 'x', { cwd: '' })).toThrow(/missing_cwd/)
    expect(() => declare(db, 'x', { actor: ' ' })).toThrow(/missing_actor/)
    expect(listAcceptanceRules(db)).toHaveLength(0)
  })

  it('clamps an oversized timeout and rejects a non-positive one', () => {
    const { db } = fixture()
    const rule = declare(db, 'slow', { timeoutMs: 24 * 60 * 60 * 1000 })
    expect(rule.timeoutMs).toBe(10 * 60_000)
    expect(() => declare(db, 'bad', { timeoutMs: 0 })).toThrow(/invalid_timeout/)
  })
})

describe('the gate', () => {
  it('is no_rules without a declaration (the regression path)', () => {
    const { db } = fixture()
    expect(acceptanceGateState(db, 'disp-1')).toEqual({ state: 'no_rules' })
  })

  it('passes when every rule has a passed verdict', () => {
    const { db } = fixture()
    declare(db, 'tests')
    declare(db, 'archive')
    for (const ruleId of ['tests', 'archive']) {
      writeAcceptanceVerdict(db, {
        dispatchId: 'disp-1',
        ruleId,
        verdict: 'passed',
        exitCode: 0,
        signal: null,
        stdoutDigest: 'a'.repeat(64),
        stdoutBytes: 10,
        detail: 'ok',
        evaluatedAt: T0
      })
    }
    expect(acceptanceGateState(db, 'disp-1')).toEqual({ state: 'passed', via: 'verdicts' })
  })

  it('blocks on one failing rule while another passes (rules are independent)', () => {
    const { db } = fixture()
    declare(db, 'tests')
    declare(db, 'archive')
    writeAcceptanceVerdict(db, {
      dispatchId: 'disp-1',
      ruleId: 'tests',
      verdict: 'passed',
      exitCode: 0,
      signal: null,
      stdoutDigest: 'a'.repeat(64),
      stdoutBytes: 10,
      detail: 'ok',
      evaluatedAt: T0
    })
    writeAcceptanceVerdict(db, {
      dispatchId: 'disp-1',
      ruleId: 'archive',
      verdict: 'failed',
      exitCode: 2,
      signal: null,
      stdoutDigest: 'b'.repeat(64),
      stdoutBytes: 10,
      detail: 'exit_code_expected_0_got_2',
      evaluatedAt: T0
    })
    expect(acceptanceGateState(db, 'disp-1')).toMatchObject({
      state: 'blocked',
      failedRules: ['archive'],
      undeterminable: false
    })
    expect(listAcceptanceVerdicts(db, 'disp-1')).toHaveLength(2)
  })

  it('blocks on an unevaluated rule, and on an undeterminable one', () => {
    const { db } = fixture()
    declare(db, 'tests')
    expect(acceptanceGateState(db, 'disp-1')).toMatchObject({
      state: 'blocked',
      notEvaluatedRules: ['tests']
    })
    writeAcceptanceVerdict(db, {
      dispatchId: 'disp-1',
      ruleId: 'tests',
      verdict: 'undeterminable',
      exitCode: null,
      signal: null,
      stdoutDigest: null,
      stdoutBytes: 0,
      detail: 'timeout_after_60000ms',
      evaluatedAt: T0
    })
    expect(acceptanceGateState(db, 'disp-1')).toMatchObject({
      state: 'blocked',
      undeterminable: true
    })
  })
})

describe('the stop', () => {
  it('starts pending, counts attempts, and accepted/rejected are terminal', () => {
    const { db } = fixture()
    declare(db, 'tests')
    openAcceptanceStop(db, { dispatchId: 'disp-1', incidentId: 'inc_1', now: T0 })
    openAcceptanceStop(db, { dispatchId: 'disp-1', incidentId: null, now: T0 + 1 })
    expect(getAcceptanceStop(db, 'disp-1')).toMatchObject({
      state: 'pending',
      incidentId: 'inc_1',
      attempts: 2
    })

    const accepted = resolveAcceptanceStop(db, {
      dispatchId: 'disp-1',
      decision: 'accept',
      actor: 'alice',
      reason: 'checked manually',
      now: T0 + 2
    })
    expect(accepted).toMatchObject({ state: 'accepted', actor: 'alice' })
    expect(acceptanceGateState(db, 'disp-1')).toEqual({ state: 'passed', via: 'accepted' })

    // A later automated failure must not overwrite the operator's decision — not even its incident ref.
    openAcceptanceStop(db, { dispatchId: 'disp-1', incidentId: 'inc_2', now: T0 + 3 })
    expect(getAcceptanceStop(db, 'disp-1')).toMatchObject({ state: 'accepted', incidentId: 'inc_1' })
  })

  it('rejects only from pending and keeps the gate blocked', () => {
    const { db } = fixture()
    declare(db, 'tests')
    openAcceptanceStop(db, { dispatchId: 'disp-1', incidentId: null, now: T0 })
    resolveAcceptanceStop(db, { dispatchId: 'disp-1', decision: 'reject', actor: 'a', reason: 'r', now: T0 + 1 })
    expect(acceptanceGateState(db, 'disp-1').state).toBe('blocked')
    expect(resolveAcceptanceStop(db, { dispatchId: 'disp-1', decision: 'accept', actor: 'b', reason: 'r', now: T0 + 2 })).toMatchObject({ state: 'rejected' })
  })
})
