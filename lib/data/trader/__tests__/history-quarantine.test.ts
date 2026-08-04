import {
  LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  quarantineLegacyFullPositions,
  quarantineLegacyPositionHistory,
} from '../history-quarantine'

describe('legacy history response quarantine', () => {
  it('clones and clears cached positionHistory with explicit unknown evidence', () => {
    const cached = {
      profile: { handle: 'cached' },
      positionHistory: [{ symbol: 'BTCUSDT', pnlUsd: 42 }],
      historyCompleteness: { state: 'complete' },
    }

    const sanitized = quarantineLegacyPositionHistory(cached)

    expect(sanitized).not.toBe(cached)
    expect(sanitized).toEqual({
      profile: cached.profile,
      positionHistory: [],
      historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
    })
    expect(cached.positionHistory).toHaveLength(1)
  })

  it('clears the historical full-route positions alias', () => {
    expect(
      quarantineLegacyFullPositions({ positions: [{ symbol: 'ETHUSDT' }], stats: null })
    ).toEqual({
      positions: [],
      stats: null,
      historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
    })
  })

  it.each([null, undefined, 'cached', 7, []])('leaves non-record payload %p unchanged', (value) => {
    expect(quarantineLegacyPositionHistory(value)).toBe(value)
    expect(quarantineLegacyFullPositions(value)).toBe(value)
  })
})
