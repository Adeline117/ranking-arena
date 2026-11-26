import { describeRowProvenance } from '../row-provenance'

const t = (key: string) =>
  (
    ({ publicLeaderboardData: 'Public leaderboard data', rowDataAsOf: 'as of {time}' }) as Record<
      string,
      string
    >
  )[key] ?? key

describe('describeRowProvenance', () => {
  const asOf = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()

  it('names the data level, the exchange and the capture time in UTC', () => {
    const note = describeRowProvenance({ source: 'binance_futures', asOf }, t, 'en')
    expect(note).not.toBeNull()
    expect(note!.iso).toBe(asOf)
    expect(note!.full).toMatch(/^Public leaderboard data · .+ · as of .+UTC$/)
    // The exchange is shown by its display name, not the raw source key.
    expect(note!.full).not.toContain('binance_futures')
    expect(note!.short.length).toBeGreaterThan(0)
  })

  it('still describes the data when the exchange is unknown', () => {
    const note = describeRowProvenance({ source: null, asOf }, t, 'en')
    expect(note!.full).toMatch(/^Public leaderboard data · as of /)
  })

  it.each([null, undefined, '', 'not-a-date'])(
    'gives no note at all for an unknown capture time (%p)',
    (value) => {
      expect(describeRowProvenance({ source: 'bybit', asOf: value }, t, 'en')).toBeNull()
    }
  )
})
