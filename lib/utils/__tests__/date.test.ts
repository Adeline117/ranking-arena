import { formatTimeAgo } from '../date'

describe('formatTimeAgo', () => {
  beforeEach(() => {
    // Mock Date.now() to a fixed time
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2024-01-15T12:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should return "刚刚" for times within 1 minute', () => {
    const now = new Date()
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000).toISOString()
    expect(formatTimeAgo(thirtySecondsAgo)).toBe('刚刚')
  })

  it('should return minutes ago for times within 1 hour', () => {
    const now = new Date()
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString()
    expect(formatTimeAgo(fifteenMinutesAgo)).toBe('15分钟前')
  })

  it('should return hours ago for times within 24 hours', () => {
    const now = new Date()
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString()
    expect(formatTimeAgo(threeHoursAgo)).toBe('3小时前')
  })

  it('should return days ago for times within 30 days', () => {
    const now = new Date()
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatTimeAgo(fiveDaysAgo)).toBe('5天前')
  })

  it('should return months ago for times within 1 year', () => {
    const now = new Date()
    const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatTimeAgo(twoMonthsAgo)).toBe('2个月前')
  })

  it('should return years ago for times over 1 year', () => {
    const now = new Date()
    const oneYearAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatTimeAgo(oneYearAgo)).toBe('1年前')
  })

  it('should handle Date objects', () => {
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)
    expect(formatTimeAgo(fiveMinutesAgo)).toBe('5分钟前')
  })

  it('should handle invalid input gracefully', () => {
    expect(formatTimeAgo('')).toBe('未知时间')
    expect(formatTimeAgo(null as unknown as string)).toBe('未知时间')
    expect(formatTimeAgo(undefined as unknown as string)).toBe('未知时间')
  })
})
