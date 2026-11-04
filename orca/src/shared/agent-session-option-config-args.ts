/** Remove one TOML override without disturbing unrelated config or positional arguments. */
export function removeAgentConfigOverride(tokens: readonly string[], key: string): string[] {
  const result: string[] = []
  const matches = (value: string): boolean => {
    const separator = value.indexOf('=')
    if (separator === -1) {
      return false
    }
    const assignmentKey = value.slice(0, separator).trim()
    return [key, `"${key}"`, `'${key}'`].includes(assignmentKey)
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      result.push(...tokens.slice(index))
      break
    }
    if ((token === '-c' || token === '--config') && matches(tokens[index + 1] ?? '')) {
      index += 1
      continue
    }
    const prefix = ['--config=', '-c=', '-c'].find((candidate) => token.startsWith(candidate))
    if (prefix && matches(token.slice(prefix.length))) {
      continue
    }
    result.push(token)
  }
  return result
}

export function hasAgentConfigOverride(tokens: readonly string[], key: string): boolean {
  return removeAgentConfigOverride(tokens, key).length !== tokens.length
}
