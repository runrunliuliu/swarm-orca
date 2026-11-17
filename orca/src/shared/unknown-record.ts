/** Narrow `unknown` to a plain object. Shared by modules that validate untrusted JSON. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
