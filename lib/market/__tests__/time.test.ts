import { formatMarketTimeUtc } from '../time'

describe('formatMarketTimeUtc', () => {
  const originalTimeZone = process.env.TZ

  afterAll(() => {
    process.env.TZ = originalTimeZone
  })

  it('returns identical, explicitly UTC text in different host time zones', () => {
    process.env.TZ = 'America/Los_Angeles'
    const serverText = formatMarketTimeUtc('2026-07-17T18:05:00.000Z')

    process.env.TZ = 'Asia/Shanghai'
    const browserText = formatMarketTimeUtc('2026-07-17T18:05:00.000Z')

    expect(serverText).toBe('2026-07-17 18:05 UTC')
    expect(browserText).toBe(serverText)
  })

  it('uses the shared missing-value marker for invalid timestamps', () => {
    expect(formatMarketTimeUtc('not-a-date')).toBe('—')
  })
})
