/**
 * `orca incident --help` grouping (simplify S5).
 *
 * Display only: this pins that the daily path is listed first and under its own heading, and that no
 * command path or flag changed. The commands themselves are covered by the handler and formatter
 * suites; this file is about the one thing S5 touched.
 */
import { describe, expect, it } from 'vitest'
import { formatCommandHelp, formatGroupHelp } from '../help'
import { INCIDENT_COMMAND_SPECS } from './incident'

describe('incident help grouping', () => {
  const help = formatGroupHelp(INCIDENT_COMMAND_SPECS, ['incident'])

  it('lists the daily path first under its own heading', () => {
    expect(help).toContain('Daily:')
    expect(help).toContain('Diagnostic:')
    expect(help).toContain('Maintenance:')
    const daily = help.indexOf('Daily:')
    const diagnostic = help.indexOf('Diagnostic:')
    const maintenance = help.indexOf('Maintenance:')
    expect(daily).toBeGreaterThan(-1)
    // Daily before Diagnostic before Maintenance.
    expect(daily).toBeLessThan(diagnostic)
    expect(diagnostic).toBeLessThan(maintenance)
    // The four daily commands are in the daily section, not scattered.
    const dailySection = help.slice(daily, diagnostic)
    for (const command of ['list', 'show', 'decide', 'export']) {
      expect(dailySection).toContain(command)
    }
    expect(dailySection).not.toContain('prune')
  })

  it('keeps diagnostic and maintenance commands out of the daily section', () => {
    const diagnosticSection = help.slice(help.indexOf('Diagnostic:'), help.indexOf('Maintenance:'))
    expect(diagnosticSection).toContain('tool-failures')
    expect(diagnosticSection).toContain('pane-clocks')
    const maintenanceSection = help.slice(help.indexOf('Maintenance:'))
    expect(maintenanceSection).toContain('prune')
    expect(maintenanceSection).toContain('acceptance resolve')
  })
})

/**
 * The archive repair surface (G5). Pinned here because it is a *flag contract*, not a behaviour: the
 * behaviour is covered by the handler and `incident-archive-bucket` suites. What must not drift is the
 * promise the help makes — one explicit, append-only retry, and nothing that looks like a repair when
 * it cannot repair.
 */
describe('incident archive repair flags (G5)', () => {
  const spec = INCIDENT_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'incident archive')

  it('declares --retry-incomplete and --pointer, and keeps --drain', () => {
    expect(spec).toBeDefined()
    expect(spec?.usage).toContain('--drain')
    expect(spec?.usage).toContain('--retry-incomplete <incident-id>')
    expect(spec?.usage).toContain('--pointer <n>')
    expect(spec?.allowedFlags).toEqual(
      expect.arrayContaining(['drain', 'retry-incomplete', 'pointer'])
    )
    expect(spec?.examples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--retry-incomplete inc_abc123 --pointer 0 --drain')
      ])
    )
  })

  it('states the scope and the limits of the repair in the help notes', () => {
    const notes = (spec?.notes ?? []).join('\n')
    expect(notes).toContain('APPENDS a new archive_pending event')
    expect(notes).toContain('latest state is archive_incomplete')
    expect(notes).toContain('No row is updated or deleted')
    expect(notes).toContain('staging excerpt can no longer be read')
    expect(notes).toContain('not repairable this way')
    expect(notes).toContain('overwrites the target')
    expect(notes).toContain('--pointer without --retry-incomplete is a usage error')
    // The rendered per-command help carries the flag and its notes, so `orca incident archive --help`
    // cannot silently lose the repair path.
    const rendered = formatCommandHelp(spec as (typeof INCIDENT_COMMAND_SPECS)[number])
    expect(rendered).toContain('--retry-incomplete')
    expect(rendered).toContain('--pointer')
    expect(rendered).toContain('archive_incomplete')
  })
})

/**
 * The daily path's id contract (found while checking the §17 item 25 live-verification debt).
 *
 * `show` and `decide` take the incident id positionally, and normalization rewrites that positional
 * into `--id` before validation. With `'id'` missing from `allowedFlags` the documented form failed
 * with "Unknown flag --id" for every release since `5a04946a`; the handler suites bind the flag
 * themselves, so they never exercised the parser. Pinned here and by the generic guard in
 * `args.test.ts` ("positional arguments survive parse → normalize → validate").
 */
describe('incident id positional (daily path)', () => {
  it.each(['incident show', 'incident decide'])('%s declares <id> and allows --id', (path) => {
    const spec = INCIDENT_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)

    expect(spec?.positionalArgs).toEqual(['id'])
    expect(spec?.allowedFlags).toContain('id')
    // The examples stay in the positional form the parser must accept.
    expect(spec?.examples?.[0]).toMatch(/^orca incident (show|decide) inc_abc123/)
  })
})
