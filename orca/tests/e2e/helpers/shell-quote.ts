/** POSIX single-quote a string for a shell command line. One definition for every E2E helper. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
