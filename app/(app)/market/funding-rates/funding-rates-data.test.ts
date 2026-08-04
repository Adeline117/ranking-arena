import {
  dedupeLatestFundingRates,
  hasUniqueFundingRateIdentities,
  readFundingRateRows,
} from './funding-rates-data'

const rows = [
  {
    platform: 'binance',
    symbol: 'BTCUSDT',
    funding_rate: 0.0001,
    funding_time: '2026-08-03T20:00:00.000Z',
  },
]

describe('funding-rate serving contract', () => {
  it('accepts exact finite timestamped rows', () => {
    expect(readFundingRateRows(rows)).toEqual(rows)
  })

  it.each([
    ['an object instead of an array', { rows }],
    ['an extra field', [{ ...rows[0], stale: false }]],
    ['a non-finite rate', [{ ...rows[0], funding_rate: Number.NaN }]],
    ['an invalid timestamp', [{ ...rows[0], funding_time: 'yesterday' }]],
    ['a padded identity', [{ ...rows[0], symbol: ' BTCUSDT' }]],
  ])('rejects %s', (_name, value) => {
    expect(readFundingRateRows(value)).toBeNull()
  })

  it('keeps the first sorted fallback row and detects a malformed RPC partition', () => {
    const duplicate = { ...rows[0], funding_rate: 0.0002 }
    expect(hasUniqueFundingRateIdentities([...rows, duplicate])).toBe(false)
    expect(dedupeLatestFundingRates([...rows, duplicate])).toEqual(rows)
  })
})
