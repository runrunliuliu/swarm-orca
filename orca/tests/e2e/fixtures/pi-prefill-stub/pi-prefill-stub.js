#!/usr/bin/env node
/**
 * Stand-in `pi` for the new-workspace E2E specs.
 *
 * Why a stub instead of the real binary: the repository's own `orca-prefill.ts`
 * extension runs inside pi, so the assertion this fixture exists for is the
 * boundary the app owns — which env vars it sets at exec time, whether the brief
 * rides argv, and whether a paste is still attempted. A real pi also needs a
 * provider, credentials and network, and its model answer would make the proof
 * about the model rather than about the launch.
 *
 * The real-pi half of the same question is proved separately (PTY run of the
 * generated extension against pi 1.5.0); see the #54 fix commit.
 *
 * Report shape (one file per exec under $ORCA_E2E_PI_STUB_REPORT_DIR):
 *   { argv, cwd, prefill, submitFlag, paneKey, startedAt }
 * Every byte the app writes to this process's stdin is appended to
 * `<report>.stdin`, so "the app did not paste" is observable, not assumed.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const reportDir = process.env.ORCA_E2E_PI_STUB_REPORT_DIR

// Why before the report: agent availability probes run `pi --version` and must not
// be answered with a TUI frame or a "report env unset" failure.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('1.6.0-e2e-stub\n')
  process.exit(0)
}

if (!reportDir) {
  process.stderr.write('pi-prefill-stub: ORCA_E2E_PI_STUB_REPORT_DIR is unset\n')
  process.exit(2)
}

mkdirSync(reportDir, { recursive: true })
const reportPath = path.join(reportDir, `pi-${process.pid}-${Date.now()}.json`)
const inputPath = `${reportPath}.stdin`
writeFileSync(inputPath, '')
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      prefill: process.env.ORCA_PI_PREFILL ?? null,
      submitFlag: process.env.ORCA_PI_PREFILL_SUBMIT ?? null,
      // Why recorded: the generated orca-prefill extension early-returns without this,
      // so its absence would make a "prefill delivered" claim hollow.
      paneKey: process.env.ORCA_PANE_KEY ?? null,
      startedAt: new Date().toISOString()
    },
    null,
    2
  )}\n`
)

const ESC = '\x1b'
const READY_MARKER = 'PI_PREFILL_STUB_READY'

function render() {
  process.stdout.write(
    `${ESC}]0;pi${ESC}\x07${
      // Why DECSET 2004: the app's paste-after-ready gate waits for this bracketed-paste
      // handshake, so without it a pre-fix run could not paste even when it tried and the
      // spec could not tell "delivered by prefill" from "nothing was ever written".
      ESC
    }[?2004h${[
      `${ESC}[H${ESC}[2Jpi (e2e stub)`,
      `[${READY_MARKER}]`,
      process.env.ORCA_PI_PREFILL_SUBMIT === '1' ? '[PI_PREFILL_STUB_SUBMIT_FLAG]' : '',
      'Ctrl+C to quit.'
    ]
      .filter(Boolean)
      .join('\r\n')}`
  )
}

function exitCleanly() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdout.write(`${ESC}[?1049l`, () => process.exit(0))
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  appendFileSync(inputPath, typeof chunk === 'string' ? chunk : chunk.toString())
  if (chunk.includes('\x03')) {
    exitCleanly()
  }
})
process.stdin.resume()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, exitCleanly)
}

// Why a self-timeout: a spec that fails before cleanup must not leave a stub
// holding the PTY open until the whole worker is torn down.
setTimeout(() => process.exit(0), 180_000).unref()

process.stdout.write(`${ESC}[?1049h`)
render()
