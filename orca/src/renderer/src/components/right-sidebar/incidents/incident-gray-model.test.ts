// Observed vs recorded (§7.2, §7.3; M7-B). The requirement has teeth: a default-off collector must not
// render as a store full of accidents.
import { describe, expect, it } from 'vitest'
import { stallRowKind, toolErrorTruncation, toolErrorWindowKind } from './incident-gray-model'
import { stallsViewFixture, toolErrorsViewFixture } from './incident-panel-fixtures'

describe('stallRowKind', () => {
  it('never marks a stall sample as recorded: the sample is the decision input, not an incident', () => {
    const row = stallsViewFixture().rows[0]
    expect(stallRowKind(row)).toBe('observed')
    expect(stallRowKind({ ...row, wouldWriteIfEnabled: true })).toBe('observed')
  })
})

describe('toolErrorWindowKind', () => {
  it('is recorded only when the collector actually wrote the incident', () => {
    expect(toolErrorWindowKind({ written: false })).toBe('observed')
    expect(toolErrorWindowKind({ written: true })).toBe('recorded')
  })
})

describe('toolErrorTruncation', () => {
  it('reports payload truncation and eviction separately', () => {
    expect(toolErrorTruncation(toolErrorsViewFixture())).toEqual({
      payloadTruncated: false,
      evicted: false
    })
    expect(
      toolErrorTruncation(toolErrorsViewFixture({ published: 1, total: 4, evicted: 2 }))
    ).toEqual({ payloadTruncated: true, evicted: true })
  })
})
