/**
 * Smart Scheduler Unit Tests
 */

import {
  ActivityTier,
  TraderActivity,
  classifyActivityTier,
  scheduleTraderBatch,
  shouldRefresh,
  getNextScheduledTime,
  getTierStats,
  TIER_SCHEDULES,
  TIER_THRESHOLDS,
} from '../smart-scheduler'

describe('Smart Scheduler', () => {
  describe('classifyActivityTier', () => {
    it('should classify top 100 traders as hot', () => {
      const activity: TraderActivity = {
        traderId: '1',
        platform: 'binance_futures',
        rank: 50,
        followers: 500,
      }

      expect(classifyActivityTier(activity)).toBe('hot')
    })

    it('should classify traders with high followers as hot', () => {
      const activity: TraderActivity = {
        traderId: '2',
        platform: 'binance_futures',
        rank: 500,
        followers: 15000,
      }

      expect(classifyActivityTier(activity)).toBe('hot')
    })

    it('should classify traders with high views as hot', () => {
      const activity: TraderActivity = {
        traderId: '3',
        platform: 'binance_futures',
        rank: 500,
        viewsLast24h: 2000,
      }

      expect(classifyActivityTier(activity)).toBe('hot')
    })

    it('should classify rank 101-500 as active', () => {
      const activity: TraderActivity = {
        traderId: '4',
        platform: 'binance_futures',
        rank: 250,
        followers: 500,
      }

      expect(classifyActivityTier(activity)).toBe('active')
    })

    it('should classify traders with recent trades as active', () => {
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      const activity: TraderActivity = {
        traderId: '5',
        platform: 'binance_futures',
        rank: 1000,
        lastTradeAt: oneHourAgo,
      }

      expect(classifyActivityTier(activity)).toBe('active')
    })

    it('should classify traders with moderate followers as active', () => {
      const activity: TraderActivity = {
        traderId: '6',
        platform: 'binance_futures',
        rank: 800,
        followers: 2000,
      }

      expect(classifyActivityTier(activity)).toBe('active')
    })

    it('should classify rank 501-2000 as normal', () => {
      const activity: TraderActivity = {
        traderId: '7',
        platform: 'binance_futures',
        rank: 1500,
        followers: 100,
      }

      expect(classifyActivityTier(activity)).toBe('normal')
    })

    it('should classify traders with recent activity (within 7 days) as normal', () => {
      const now = new Date()
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

      const activity: TraderActivity = {
        traderId: '8',
        platform: 'binance_futures',
        rank: 3000,
        lastTradeAt: threeDaysAgo,
      }

      expect(classifyActivityTier(activity)).toBe('normal')
    })

    it('should classify low-activity traders as dormant', () => {
      const activity: TraderActivity = {
        traderId: '9',
        platform: 'binance_futures',
        rank: 5000,
        followers: 10,
      }

      expect(classifyActivityTier(activity)).toBe('dormant')
    })

    it('should classify old traders as dormant', () => {
      const now = new Date()
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)

      const activity: TraderActivity = {
        traderId: '10',
        platform: 'binance_futures',
        rank: 3000,
        lastTradeAt: tenDaysAgo,
      }

      expect(classifyActivityTier(activity)).toBe('dormant')
    })

    it('should handle traders with no data as dormant', () => {
      const activity: TraderActivity = {
        traderId: '11',
        platform: 'binance_futures',
      }

      expect(classifyActivityTier(activity)).toBe('dormant')
    })
  })

  describe('scheduleTraderBatch', () => {
    it('should schedule traders with correct priorities', () => {
      const traders: TraderActivity[] = [
        { traderId: '1', platform: 'binance', rank: 10 }, // hot
        { traderId: '2', platform: 'binance', rank: 200 }, // active
        { traderId: '3', platform: 'binance', rank: 1000 }, // normal
        { traderId: '4', platform: 'binance', rank: 5000 }, // dormant
      ]

      const schedules = scheduleTraderBatch(traders)

      expect(schedules).toHaveLength(4)
      expect(schedules[0].priority).toBe(10) // hot
      expect(schedules[1].priority).toBe(20) // active
      expect(schedules[2].priority).toBe(30) // normal
      expect(schedules[3].priority).toBe(40) // dormant
    })

    it('should stagger jobs within the same tier', () => {
      const traders: TraderActivity[] = [
        { traderId: '1', platform: 'binance', rank: 10 },
        { traderId: '2', platform: 'binance', rank: 20 },
        { traderId: '3', platform: 'binance', rank: 30 },
      ]

      const baseTime = new Date('2024-01-01T00:00:00Z')
      const schedules = scheduleTraderBatch(traders, baseTime)

      // All should be hot tier, staggered by 1 second
      const times = schedules.map((s) => s.nextRunAt.getTime())
      expect(times[1]).toBeGreaterThan(times[0])
      expect(times[2]).toBeGreaterThan(times[1])
    })

    it('should sort by priority then nextRunAt', () => {
      const traders: TraderActivity[] = [
        { traderId: '1', platform: 'binance', rank: 5000 }, // dormant
        { traderId: '2', platform: 'binance', rank: 10 }, // hot
        { traderId: '3', platform: 'binance', rank: 1000 }, // normal
        { traderId: '4', platform: 'binance', rank: 200 }, // active
      ]

      const schedules = scheduleTraderBatch(traders)

      // Should be sorted: hot, active, normal, dormant
      expect(schedules[0].tier).toBe('hot')
      expect(schedules[1].tier).toBe('active')
      expect(schedules[2].tier).toBe('normal')
      expect(schedules[3].tier).toBe('dormant')
    })
  })

  describe('shouldRefresh', () => {
    it('should refresh if never updated', () => {
      expect(shouldRefresh(null, 'normal')).toBe(true)
    })

    it('should refresh if interval has passed (hot tier)', () => {
      const now = new Date()
      const twentyMinutesAgo = new Date(now.getTime() - 20 * 60 * 1000)

      expect(shouldRefresh(twentyMinutesAgo, 'hot', now)).toBe(true)
    })

    it('should not refresh if interval has not passed (hot tier)', () => {
      const now = new Date()
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000)

      expect(shouldRefresh(tenMinutesAgo, 'hot', now)).toBe(false)
    })

    it('should refresh if interval has passed (active tier)', () => {
      const now = new Date()
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)

      expect(shouldRefresh(twoHoursAgo, 'active', now)).toBe(true)
    })

    it('should not refresh if interval has not passed (active tier)', () => {
      const now = new Date()
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000)

      expect(shouldRefresh(thirtyMinutesAgo, 'active', now)).toBe(false)
    })

    it('should refresh if interval has passed (normal tier)', () => {
      const now = new Date()
      const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000)

      expect(shouldRefresh(fiveHoursAgo, 'normal', now)).toBe(true)
    })

    it('should refresh if interval has passed (dormant tier)', () => {
      const now = new Date()
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)

      expect(shouldRefresh(twoDaysAgo, 'dormant', now)).toBe(true)
    })
  })

  describe('getNextScheduledTime', () => {
    it('should return now if never updated', () => {
      const now = new Date()
      const next = getNextScheduledTime(null, 'normal', now)

      expect(next.getTime()).toBe(now.getTime())
    })

    it('should calculate next time for hot tier (15 minutes)', () => {
      const lastUpdate = new Date('2024-01-01T00:00:00Z')
      const now = lastUpdate
      const next = getNextScheduledTime(lastUpdate, 'hot', now)

      const expected = new Date(lastUpdate.getTime() + 15 * 60 * 1000)
      expect(next.getTime()).toBe(expected.getTime())
    })

    it('should calculate next time for active tier (1 hour)', () => {
      const lastUpdate = new Date('2024-01-01T00:00:00Z')
      const now = lastUpdate
      const next = getNextScheduledTime(lastUpdate, 'active', now)

      const expected = new Date(lastUpdate.getTime() + 60 * 60 * 1000)
      expect(next.getTime()).toBe(expected.getTime())
    })

    it('should calculate next time for normal tier (4 hours)', () => {
      const lastUpdate = new Date('2024-01-01T00:00:00Z')
      const now = lastUpdate
      const next = getNextScheduledTime(lastUpdate, 'normal', now)

      const expected = new Date(lastUpdate.getTime() + 4 * 60 * 60 * 1000)
      expect(next.getTime()).toBe(expected.getTime())
    })

    it('should calculate next time for dormant tier (24 hours)', () => {
      const lastUpdate = new Date('2024-01-01T00:00:00Z')
      const now = lastUpdate
      const next = getNextScheduledTime(lastUpdate, 'dormant', now)

      const expected = new Date(lastUpdate.getTime() + 24 * 60 * 60 * 1000)
      expect(next.getTime()).toBe(expected.getTime())
    })

    it('should return now if next time is in the past', () => {
      const now = new Date()
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
      const next = getNextScheduledTime(twoDaysAgo, 'hot', now)

      expect(next.getTime()).toBe(now.getTime())
    })
  })

  describe('getTierStats', () => {
    it('should count traders by tier', () => {
      const traders: TraderActivity[] = [
        { traderId: '1', platform: 'binance', rank: 10 }, // hot
        { traderId: '2', platform: 'binance', rank: 20 }, // hot
        { traderId: '3', platform: 'binance', rank: 200 }, // active
        { traderId: '4', platform: 'binance', rank: 300 }, // active
        { traderId: '5', platform: 'binance', rank: 1000 }, // normal
        { traderId: '6', platform: 'binance', rank: 5000 }, // dormant
      ]

      const stats = getTierStats(traders)

      expect(stats.hot).toBe(2)
      expect(stats.active).toBe(2)
      expect(stats.normal).toBe(1)
      expect(stats.dormant).toBe(1)
    })

    it('should handle empty trader list', () => {
      const stats = getTierStats([])

      expect(stats.hot).toBe(0)
      expect(stats.active).toBe(0)
      expect(stats.normal).toBe(0)
      expect(stats.dormant).toBe(0)
    })
  })

  describe('Configuration', () => {
    it('should have correct tier schedules', () => {
      expect(TIER_SCHEDULES.hot.intervalMinutes).toBeGreaterThanOrEqual(15)
      expect(TIER_SCHEDULES.active.intervalMinutes).toBeGreaterThanOrEqual(60)
      expect(TIER_SCHEDULES.normal.intervalMinutes).toBeGreaterThanOrEqual(240)
      expect(TIER_SCHEDULES.dormant.intervalMinutes).toBeGreaterThanOrEqual(1440)
    })

    it('should have correct priority ordering', () => {
      expect(TIER_SCHEDULES.hot.priority).toBeLessThan(TIER_SCHEDULES.active.priority)
      expect(TIER_SCHEDULES.active.priority).toBeLessThan(TIER_SCHEDULES.normal.priority)
      expect(TIER_SCHEDULES.normal.priority).toBeLessThan(TIER_SCHEDULES.dormant.priority)
    })

    it('should have reasonable tier thresholds', () => {
      expect(TIER_THRESHOLDS.hot.rank).toBeGreaterThan(0)
      expect(TIER_THRESHOLDS.hot.rank).toBeLessThan(TIER_THRESHOLDS.active.rank)
      expect(TIER_THRESHOLDS.active.rank).toBeLessThan(TIER_THRESHOLDS.normal.rank)
    })
  })

  describe('Edge Cases', () => {
    it('should handle trader with all fields undefined', () => {
      const activity: TraderActivity = {
        traderId: '1',
        platform: 'binance',
        rank: undefined,
        followers: undefined,
        lastTradeAt: undefined,
        viewsLast24h: undefined,
      }

      expect(classifyActivityTier(activity)).toBe('dormant')
    })

    it('should handle trader with rank 0', () => {
      const activity: TraderActivity = {
        traderId: '1',
        platform: 'binance',
        rank: 0,
      }

      expect(classifyActivityTier(activity)).toBe('hot')
    })

    it('should handle trader exactly at threshold boundaries', () => {
      const activity100: TraderActivity = {
        traderId: '1',
        platform: 'binance',
        rank: 100,
      }
      expect(classifyActivityTier(activity100)).toBe('hot')

      const activity101: TraderActivity = {
        traderId: '2',
        platform: 'binance',
        rank: 101,
      }
      expect(classifyActivityTier(activity101)).toBe('active')

      const activity500: TraderActivity = {
        traderId: '3',
        platform: 'binance',
        rank: 500,
      }
      expect(classifyActivityTier(activity500)).toBe('active')

      const activity501: TraderActivity = {
        traderId: '4',
        platform: 'binance',
        rank: 501,
      }
      expect(classifyActivityTier(activity501)).toBe('normal')
    })

    it('should handle very large batch scheduling', () => {
      const traders: TraderActivity[] = Array.from({ length: 1000 }, (_, i) => ({
        traderId: `${i}`,
        platform: 'binance',
        rank: i + 1,
      }))

      const schedules = scheduleTraderBatch(traders)

      expect(schedules).toHaveLength(1000)
      expect(schedules[0].tier).toBe('hot') // rank 1
      expect(schedules[schedules.length - 1].tier).toBe('normal') // rank 1000 <= normal threshold (2000)
    })
  })
})
