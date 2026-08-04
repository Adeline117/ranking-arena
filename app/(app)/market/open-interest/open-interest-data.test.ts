import {
  dedupeLatestOpenInterest,
  hasUniqueOpenInterestIdentities,
  readOpenInterestRows,
} from './open-interest-data'

const rows = [
  {
    platform: 'binance',
    symbol: 'BTCUSDT',
    open_interest_usd: 1_000_000,
    open_interest_contracts: 20,
    timestamp: '2026-08-03T20:00:00.000Z',
  },
]

describe('open-interest serving contract', () => {
  it('accepts exact finite timestamped rows', () => {
    expect(readOpenInterestRows(rows)).toEqual(rows)
    expect(readOpenInterestRows([{ ...rows[0], open_interest_contracts: null }])).not.toBeNull()
  })

  it.each([
    ['an object instead of an array', { rows }],
    ['an extra field', [{ ...rows[0], stale: false }]],
    ['a negative USD value', [{ ...rows[0], open_interest_usd: -1 }]],
    ['a non-finite contract value', [{ ...rows[0], open_interest_contracts: Number.NaN }]],
    ['an invalid timestamp', [{ ...rows[0], timestamp: 'yesterday' }]],
    ['a padded identity', [{ ...rows[0], platform: 'binance ' }]],
  ])('rejects %s', (_name, value) => {
    expect(readOpenInterestRows(value)).toBeNull()
  })

  it('keeps the first sorted fallback row and detects a malformed RPC partition', () => {
    const duplicate = { ...rows[0], open_interest_usd: 2_000_000 }
    expect(hasUniqueOpenInterestIdentities([...rows, duplicate])).toBe(false)
    expect(dedupeLatestOpenInterest([...rows, duplicate])).toEqual(rows)
  })
})
