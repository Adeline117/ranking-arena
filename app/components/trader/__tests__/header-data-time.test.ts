import { resolveHeaderDataTime } from '../header-data-time'

describe('resolveHeaderDataTime', () => {
  it('prefers the detail source watermark', () => {
    expect(resolveHeaderDataTime('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')).toBe(
      '2026-08-01T00:00:00.000Z'
    )
  })

  it('falls back to the serving snapshot capture time', () => {
    expect(resolveHeaderDataTime(null, '2026-08-02T00:00:00Z')).toBe('2026-08-02T00:00:00.000Z')
  })

  it('treats the epoch sentinel and invalid values as unknown', () => {
    expect(resolveHeaderDataTime('1970-01-01T00:00:00Z', 'nope')).toBeUndefined()
    expect(resolveHeaderDataTime(undefined, undefined)).toBeUndefined()
  })
})
