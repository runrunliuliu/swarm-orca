#!/usr/bin/env node

const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const READY_MARKER = 'GOLDEN_STUB_AGENT_READY'
const EXIT_MARKER = 'GOLDEN_STUB_AGENT_EXITED'

// Opt-in, because the same stub backs the launch/typing golden specs: enabling a paste-ready
// handshake or a report file for every run would change what those specs observe.
const pasteReady = process.env.ORCA_E2E_STUB_PASTE_READY === '1'
const reportDir = process.env.ORCA_E2E_STUB_REPORT_DIR ?? ''

// Agent detection and trust preflight ask the CLI for its version. Answering with a TUI frame (and
// then waiting on stdin) leaves that probe hanging, which delays the real spawn, so answer plainly.
if (
  process.argv.includes('--version') ||
  process.argv.includes('-v') ||
  process.argv.includes('--help') ||
  process.argv.includes('-h')
) {
  process.stdout.write('1.0.0-golden-stub-agent\n')
  process.exit(0)
}

// The interactive fixture does not implement Codex's JSONL app-server API.
if (process.argv[2] === 'app-server') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}

const ESC = '\x1b'
const keyboardProtocolMode = process.argv.includes('--keyboard-protocol')
const keyboardProtocolAgent = process.argv.includes('--grok') ? 'Grok' : 'Codex'
// Both match the bytes after ESC, so the control character stays out of the
// pattern: a CSI/SS3 introducer still missing its final byte, and a complete
// CSI/SS3 sequence. Shift+Enter is matched before either is consulted.
const INCOMPLETE_ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*|O)?$/
const ESCAPE_TAIL_RE = /^(?:\[[0-9;?]*[ -/]*[@-~]|O[@-~])/

let composer = ''
let lastSubmission = ''
let pendingInput = ''
let exiting = false
// Bracketed paste is atomic for a TUI: newlines inside it belong to the composer, not to submit.
// Why tracked: the delivery instruction is multi-line, so a stub that submitted on every newline
// would report a dozen messages for one paste and prove nothing about delivery.
let inBracketedPaste = false
let reportPath = null

function writeReport(fields) {
  if (!reportDir) {
    return
  }
  try {
    mkdirSync(reportDir, { recursive: true })
    if (!reportPath) {
      reportPath = path.join(reportDir, `golden-stub-${process.pid}-${Date.now()}.json`)
      writeFileSync(`${reportPath}.stdin`, '')
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            argv: process.argv.slice(2),
            cwd: process.cwd(),
            submissions: [],
            enteredAt: new Date().toISOString()
          },
          null,
          1
        )}\n`
      )
    }
    if (!fields) {
      return
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    Object.assign(report, fields(report))
    writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`)
  } catch {
    // Why swallowed: a report is evidence, never a reason to break the TUI under test.
  }
}

function render() {
  // Why the handshake: the app's paste-after-ready gate waits for DECSET 2004, so without it a
  // delivery launch only ever takes the blind-write fallback — a different path than the app's.
  const pasteHandshake = pasteReady ? '\x1b[?2004h' : ''
  const lines = composer.split('\n')
  const renderedComposer = lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`)
  process.stdout.write(
    `${keyboardProtocolMode ? `\x1b]0;\u280b ${keyboardProtocolAgent} is thinking\x07\x1b[>1u` : '\x1b]0;Golden Stub Agent\x07'}${[
      '\x1b[H\x1b[2JGolden Stub Agent',
      `[${READY_MARKER}]`,
      '',
      ...renderedComposer,
      '',
      'Shift+Enter inserts a newline. Type exit then Enter to quit.',
      ...(lastSubmission ? [`[GOLDEN_STUB_AGENT_SUBMITTED] ${lastSubmission}`] : [])
    ].join('\r\n')}${pasteHandshake}`
  )
}

function exitCleanly() {
  if (exiting) {
    return
  }
  exiting = true
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  const idleTitle = keyboardProtocolMode ? `\x1b]0;${keyboardProtocolAgent}\x07` : ''
  process.stdout.write(`${idleTitle}\x1b[?1049l[${EXIT_MARKER}]\r\n`, () => process.exit(0))
}

function submit() {
  if (composer.trim() === 'exit') {
    exitCleanly()
    return
  }
  lastSubmission = composer
  composer = ''
  writeReport((report) => ({
    submissions: [
      ...report.submissions,
      { text: lastSubmission, at: new Date().toISOString() }
    ]
  }))
  render()
}

function consumeInput() {
  while (pendingInput.length > 0 && !exiting) {
    // Bracketed paste is one atomic insertion: its newlines are composer text, and its markers are
    // protocol, so both are consumed before the escape/key handling below can see them.
    if (pendingInput.startsWith('\x1b[200~')) {
      pendingInput = pendingInput.slice('\x1b[200~'.length)
      inBracketedPaste = true
      continue
    }
    if (pendingInput.startsWith('\x1b[201~')) {
      pendingInput = pendingInput.slice('\x1b[201~'.length)
      inBracketedPaste = false
      render()
      continue
    }
    if (inBracketedPaste) {
      const pastedChar = pendingInput[0]
      pendingInput = pendingInput.slice(1)
      if (pastedChar === '\r' || pastedChar === '\n') {
        composer += '\n'
      } else if (pastedChar >= ' ') {
        composer += pastedChar
      }
      continue
    }
    const enter = ['\x1b[13u', '\x1b[13;1u'].find((sequence) => pendingInput.startsWith(sequence))
    if (enter) {
      pendingInput = pendingInput.slice(enter.length)
      submit()
      continue
    }
    const shiftEnter = ['\x1b[13;2u', '\x1b[13;2~', '\x1b\r'].find((sequence) =>
      pendingInput.startsWith(sequence)
    )
    if (shiftEnter) {
      pendingInput = pendingInput.slice(shiftEnter.length)
      composer += '\n'
      render()
      continue
    }
    if (pendingInput.startsWith(ESC)) {
      const tail = pendingInput.slice(ESC.length)
      // Wait for the rest of a sequence that is still arriving.
      if (INCOMPLETE_ESCAPE_TAIL_RE.test(tail)) {
        return
      }
      // Why: without this, an unhandled sequence loses its ESC to the sub-space
      // filter below and types its tail ("[A") into the composer, so a stray key
      // report surfaces as a baffling render diff instead of being ignored.
      const escape = ESCAPE_TAIL_RE.exec(tail)
      if (escape) {
        pendingInput = pendingInput.slice(ESC.length + escape[0].length)
        continue
      }
    }

    const char = pendingInput[0]
    pendingInput = pendingInput.slice(1)
    if (char === '\r' || char === '\n') {
      submit()
    } else if (char === '\x04' || char === '\x03') {
      // Raw mode delivers Ctrl+C as \x03 instead of raising SIGINT.
      exitCleanly()
    } else if (char === '\x7f' || char === '\b') {
      composer = composer.slice(0, -1)
      render()
    } else if (char >= ' ') {
      composer += char
      render()
    }
  }
}

if (reportDir) {
  writeReport(null)
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString()
  // Why append before consuming: "the app wrote exactly one Enter" has to be readable from the
  // raw byte log, not inferred from how the composer happened to parse it.
  if (reportPath) {
    try {
      appendFileSync(`${reportPath}.stdin`, text)
    } catch {
      // Report writes never break the TUI under test.
    }
  }
  pendingInput += text
  consumeInput()
})
process.stdin.resume()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, exitCleanly)
}

process.stdout.write('\x1b[?1049h')
render()

if (pasteReady) {
  // Why three re-assertions and not a heartbeat: the readiness gate needs a quiet window after the
  // handshake, so a periodic write would keep pushing the paste further out. These land after the
  // renderer has attached and stop early enough for the 1500ms quiet window to close.
  for (const delayMs of [800, 2000, 4000]) {
    const timer = setTimeout(() => {
      if (!exiting) {
        render()
      }
    }, delayMs)
    timer.unref?.()
  }
}
