/**
 * The classifier's trust model (M4-C1): structured evidence decides, text is only a hint, and a build
 * log that merely says "permission denied" can never be high severity.
 */
import { describe, expect, it } from 'vitest'
import {
  HIGH_SEVERITY_TOOL_ERROR_CODES,
  STRUCTURED_ERROR_KINDS,
  TOOL_ERROR_CODES,
  classifyToolError,
  isHighSeverityToolError,
  textHintFor
} from './incident-tool-error-classifier'

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'

describe('structured evidence decides', () => {
  it('maps every structured denial kind, and only the permission family is high severity', () => {
    const expectations: [string, string, boolean][] = [
      ['permission_denied', 'permission_denied', true],
      ['pin_mismatch', 'permission_denied', true],
      ['scope_violation', 'permission_denied', true],
      ['immutable', 'permission_denied', true],
      ['tool_schema', 'tool_schema', false],
      ['timeout', 'timeout', false],
      ['network', 'network', false]
    ]
    for (const [kind, code, high] of expectations) {
      expect(classifyToolError({ errorKind: kind, isError: true }), kind).toMatchObject({
        code,
        confidence: 'structured',
        highSeverity: high
      })
    }
    expect(STRUCTURED_ERROR_KINDS).toHaveLength(7)
  })

  it('takes a structured exit code as non_zero_exit, even when the text claims permission', () => {
    // The exact regression from review: a build log containing "permission denied" and a 2 exit code.
    const classification = classifyToolError({
      output: 'npm ERR! permission denied / 403 while fetching',
      isError: true,
      exitCode: 2
    })
    expect(classification).toMatchObject({
      code: 'non_zero_exit',
      confidence: 'exit_code',
      highSeverity: false
    })
  })

  it('lets a structured refusal kind outrank a non-zero exit code', () => {
    expect(
      classifyToolError({ errorKind: 'permission_denied', exitCode: 2, isError: true })
    ).toMatchObject({ code: 'permission_denied', highSeverity: true })
  })

  it('never lets text alone produce a code or high severity', () => {
    for (const text of [
      'permission denied: /root/x',
      'EACCES 403 forbidden',
      'immutable record',
      'pin mismatch',
      'timed out',
      'no such file or directory',
      'command not found'
    ]) {
      const classification = classifyToolError({ output: text, isError: true })
      expect(classification, text).toMatchObject({
        code: 'unknown',
        confidence: 'text_hint',
        highSeverity: false
      })
      expect(classification.textHint).toBeDefined()
      expect(TOOL_ERROR_CODES).toContain(classification.code)
    }
  })

  it('reports an unrecognized error as unknown with no hint', () => {
    expect(classifyToolError({ output: 'something odd happened', isError: true })).toEqual({
      code: 'unknown',
      confidence: 'unknown',
      highSeverity: false
    })
    expect(classifyToolError({ isError: false })).toMatchObject({ code: 'unknown' })
  })

  it('ignores a non-zero exit code of zero and an unknown kind', () => {
    expect(classifyToolError({ exitCode: 0, output: 'boom', isError: true })).toMatchObject({
      code: 'unknown'
    })
    expect(classifyToolError({ errorKind: 'mystery', exitCode: 3, isError: true })).toMatchObject({
      code: 'non_zero_exit'
    })
  })

  it('does not leak the matched text anywhere in its result', () => {
    const classification = classifyToolError({
      output: `permission denied: ${SECRET}`,
      isError: true
    })
    expect(JSON.stringify(classification)).not.toContain(SECRET)
    // The hint is a member of the closed vocabulary, not free text.
    expect(TOOL_ERROR_CODES).toContain(classification.textHint)
    expect(textHintFor({ output: 'permission denied' })).toBe('permission_denied')
  })

  it('treats only permission_denied as high severity', () => {
    expect(HIGH_SEVERITY_TOOL_ERROR_CODES).toEqual(['permission_denied'])
    expect(isHighSeverityToolError('permission_denied')).toBe(true)
    expect(isHighSeverityToolError('non_zero_exit')).toBe(false)
  })
})
