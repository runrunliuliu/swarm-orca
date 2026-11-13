/**
 * The normalized code classifier (§7.3): a stable cluster code, no stored text, and unknown is a
 * cluster rather than a guess.
 */
import { describe, expect, it } from 'vitest'
import {
  HIGH_SEVERITY_TOOL_ERROR_CODES,
  TOOL_ERROR_CODES,
  classifyToolError,
  isHighSeverityToolError
} from './incident-tool-error-classifier'

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'

describe('classifyToolError', () => {
  it('maps each family to its code', () => {
    const cases: [string, string][] = [
      ['bash: /root/x: Permission denied', 'permission_denied'],
      ['EACCES: permission denied, open /etc/hosts', 'permission_denied'],
      ['refusing: pin mismatch for worker-model-profiles.json', 'permission_denied'],
      ['path is outside the allowed write scope', 'permission_denied'],
      ['write failed: immutable record', 'permission_denied'],
      ['read: no such file or directory', 'path_not_found'],
      ['rg: command not found', 'command_not_found'],
      ['request timed out after 30000ms', 'timeout'],
      ['connect ECONNREFUSED 127.0.0.1:1', 'network'],
      ['invalid arguments: required property "path"', 'tool_schema'],
      ['process exited with code 2', 'non_zero_exit']
    ]
    for (const [text, code] of cases) {
      expect(classifyToolError({ output: text, isError: true }), text).toBe(code)
    }
  })

  it('folds an unrecognized error to unknown instead of inventing a code', () => {
    expect(classifyToolError({ output: 'something odd happened', isError: true })).toBe('unknown')
    expect(classifyToolError({ output: '', isError: true })).toBe('unknown')
    expect(classifyToolError({ isError: false })).toBe('unknown')
  })

  it('uses a structured exit code when no phrase matches', () => {
    expect(classifyToolError({ output: 'boom', isError: true, exitCode: 3 })).toBe('non_zero_exit')
    expect(classifyToolError({ output: 'boom', isError: true, exitCode: 0 })).toBe('unknown')
  })

  it('does not leak the matched text anywhere in its result', () => {
    const code = classifyToolError({ output: `permission denied: ${SECRET}`, isError: true })
    expect(code).toBe('permission_denied')
    expect(JSON.stringify({ code })).not.toContain(SECRET)
    // Every code is a member of the closed vocabulary — nothing free-form can escape.
    expect(TOOL_ERROR_CODES).toContain(code)
  })

  it('treats the pin/scope/immutable family as high severity', () => {
    expect(HIGH_SEVERITY_TOOL_ERROR_CODES).toEqual(['permission_denied'])
    expect(isHighSeverityToolError('permission_denied')).toBe(true)
    for (const code of ['timeout', 'path_not_found', 'unknown'] as const) {
      expect(isHighSeverityToolError(code)).toBe(false)
    }
  })
})
