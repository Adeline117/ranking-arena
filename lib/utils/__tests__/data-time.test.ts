import {
  describeDataTime,
  formatDataClock,
  isDataTimestampStale,
  newestDataTimestamp,
  oldestDataTimestamp,
  parseDataTimestamp,
  RANKING_SOURCE_STALE_MS,
} from '../data-time'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')

describe('parseDataTimestamp', () => {
  it('accepts a real source time', () => {
    expect(parseDataTimestamp('2026-08-01T00:00:00.000Z', NOW)).toBe(
      Date.parse('2026-08-01T00:00:00.000Z')
    )
  })

  it.each([null, undefined, '', 'nope', '1970-01-01T00:00:00.000Z', 0, -1])(
    'treats %p as unknown',
    (value) => {
      expect(parseDataTimestamp(value as string | number | null | undefined, NOW)).toBeNull()
    }
  )

  it('rejects a time beyond the future tolerance', () => {
    expect(parseDataTimestamp('2026-11-11T13:00:00.000Z', NOW)).toBeNull()
  })
})

describe('isDataTimestampStale / describeDataTime', () => {
  it('uses the 48h serving boundary', () => {
    expect(isDataTimestampStale(NOW - RANKING_SOURCE_STALE_MS, NOW)).toBe(false)
    expect(isDataTimestampStale(NOW - RANKING_SOURCE_STALE_MS - 1, NOW)).toBe(true)
  })

  it('never reports an unknown time as fresh data with an age', () => {
    expect(describeDataTime(null, NOW)).toEqual({ timestampMs: null, iso: null, isStale: false })
  })

  it('describes an August watermark as stale', () => {
    expect(describeDataTime('2026-08-01T00:00:00Z', NOW)).toEqual({
      timestampMs: Date.parse('2026-08-01T00:00:00Z'),
      iso: '2026-08-01T00:00:00.000Z',
      isStale: true,
    })
  })
})

describe('formatDataClock', () => {
  it('shows only the time for a value from the current day', () => {
    const label = formatDataClock(NOW - 60 * 60 * 1000, NOW, 'en-US', 'UTC')
    expect(label).toMatch(/11:00/)
    expect(label).not.toMatch(/Nov/)
  })

  it('includes the date for an older value so it cannot read as today', () => {
    const label = formatDataClock(Date.parse('2026-08-16T09:30:00Z'), NOW, 'en-US', 'UTC')
    expect(label).toMatch(/Aug/)
    expect(label).toMatch(/16/)
    expect(label).not.toMatch(/2026/)
  })

  it('includes the year when it differs', () => {
    const label = formatDataClock(Date.parse('2025-08-16T09:30:00Z'), NOW, 'en-US', 'UTC')
    expect(label).toMatch(/2025/)
  })
})

describe('oldest/newestDataTimestamp', () => {
  const values = ['2026-11-10T00:00:00Z', '1970-01-01T00:00:00Z', null, '2026-08-01T00:00:00Z']

  it('ignores unknown values', () => {
    expect(oldestDataTimestamp(values, NOW)).toBe('2026-08-01T00:00:00.000Z')
    expect(newestDataTimestamp(values, NOW)).toBe('2026-11-10T00:00:00.000Z')
  })

  it('is null when nothing is valid', () => {
    expect(oldestDataTimestamp([null, ''], NOW)).toBeNull()
    expect(newestDataTimestamp([], NOW)).toBeNull()
  })
})
