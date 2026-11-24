import { expect, it } from 'vitest'
import { readCreatedAgentTerminalIdentity } from './web-runtime-terminal-identity'

it('reads host coordinates while accepting additive and legacy fields', () => {
  expect(
    readCreatedAgentTerminalIdentity({
      terminal: { tabId: 'tab', paneKey: 'tab:leaf', future: true },
      disposition: 'created'
    })
  ).toEqual({ terminal: { tabId: 'tab', paneKey: 'tab:leaf' } })
  expect(readCreatedAgentTerminalIdentity({ terminal: { paneKey: null } })).toEqual({
    terminal: { tabId: undefined, paneKey: null }
  })
})

it.each([
  null,
  {},
  { terminal: null },
  { terminal: 'pty' },
  { terminal: { tabId: 12 } },
  { terminal: { paneKey: false } }
])('rejects malformed host coordinates: %j', (value) => {
  expect(() => readCreatedAgentTerminalIdentity(value)).toThrow('Host returned')
})

it('accepts only known launch prompt delivery settlements', () => {
  const terminal = { tabId: 'tab-1', paneKey: 'tab-1:leaf-1' }
  expect(
    readCreatedAgentTerminalIdentity({
      terminal,
      promptDelivery: { state: 'launch-bound', transport: 'env-hook' }
    })
  ).toMatchObject({ promptDelivery: { state: 'launch-bound', transport: 'env-hook' } })
  expect(() =>
    readCreatedAgentTerminalIdentity({
      terminal,
      promptDelivery: { state: 'launch-bound', transport: 'stdin' }
    })
  ).toThrow('invalid launch prompt delivery')
  expect(() =>
    readCreatedAgentTerminalIdentity({ terminal, promptDelivery: { state: 'launch-bound' } })
  ).toThrow('invalid launch prompt delivery')
})
