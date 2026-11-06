import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'

export const terminalWaitStartupHandler: CommandHandler = async ({ flags, client, json }) => {
  const terminal = getRequiredStringFlag(flags, 'terminal')
  const expectedIncarnationId = getOptionalStringFlag(flags, 'expected-incarnation-id')
  const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? 60_000
  if (timeoutMs > 3_600_000) {
    throw new RuntimeClientError('invalid_argument', '--timeout-ms must not exceed 3600000')
  }
  const result = await client.call<{
    startup?: { handle: string; agent: string; ready: boolean; incarnationId: string }
  }>(
    'terminal.waitForStartup',
    { terminal, timeoutMs, expectedIncarnationId },
    {
      timeoutMs: timeoutMs + 5000
    }
  )
  const startup = result.result.startup
  if (
    startup?.ready !== true ||
    startup.agent !== 'trae' ||
    startup.handle !== terminal ||
    typeof startup.incarnationId !== 'string' ||
    !startup.incarnationId ||
    (expectedIncarnationId && startup.incarnationId !== expectedIncarnationId)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Host did not confirm the requested Trae startup composer'
    )
  }
  printResult(result, json, () => `Startup composer ready: ${terminal} (not business idle).`)
}
