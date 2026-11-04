import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import * as appEnvironment from '../../../shared/app-environment'
import { nativeOrchestrationCliCommand } from './cli-command'

const launcher = vi.hoisted(() => ({ prependOrcaCliDirToChildPath: vi.fn() }))
vi.mock('../../cli/orca-cli-child-path', () => launcher)
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  launcher.prependOrcaCliDirToChildPath.mockReset()
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('native orchestration CLI prefix', () => {
  it.each(['linux', 'darwin'] as const)(
    'quotes the owning %s launcher, not an inherited override',
    (platform) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => '/data/this-instance' })
      vi.stubEnv('ORCA_CLI_COMMAND', '/another-instance/orca')
      launcher.prependOrcaCliDirToChildPath.mockReturnValue("/data/Orca's $instance/cli")

      expect(nativeOrchestrationCliCommand()).toBe("'/data/Orca'\"'\"'s $instance/cli'")
      expect(launcher.prependOrcaCliDirToChildPath).toHaveBeenCalledWith(
        {},
        {
          isPackaged: true,
          userDataPath: '/data/this-instance',
          resourcesPath: process.resourcesPath ?? null
        }
      )
    }
  )

  it('does not invent an absolute path when no launcher resolved', () => {
    launcher.prependOrcaCliDirToChildPath.mockReturnValue(null)
    expect(nativeOrchestrationCliCommand()).toBeUndefined()
  })

  it('does not resolve or write a launcher without an owning app environment', () => {
    vi.spyOn(appEnvironment, 'hasAppEnvironment').mockReturnValue(false)
    expect(nativeOrchestrationCliCommand()).toBeUndefined()
    expect(launcher.prependOrcaCliDirToChildPath).not.toHaveBeenCalled()
  })

  it('leaves Windows command names to the existing shell contract', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    expect(nativeOrchestrationCliCommand()).toBeUndefined()
    expect(launcher.prependOrcaCliDirToChildPath).not.toHaveBeenCalled()
  })
})
