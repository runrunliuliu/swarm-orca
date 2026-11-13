/**
 * `orca incident --help` grouping (simplify S5).
 *
 * Display only: this pins that the daily path is listed first and under its own heading, and that no
 * command path or flag changed. The commands themselves are covered by the handler and formatter
 * suites; this file is about the one thing S5 touched.
 */
import { describe, expect, it } from 'vitest'
import { formatGroupHelp } from '../help'
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
