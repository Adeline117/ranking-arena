/**
 * Schedule Manager Unit Tests
 */

import { ScheduleManager, TraderWithSchedule } from '../schedule-manager'
import { ActivityTier, ScheduledJob } from '../smart-scheduler'

// Create a chainable mock
const createChainableMock = () => {
  const mock: Record<string, jest.Mock> = {}
  const methods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'lte', 'lt', 'not', 'order', 'limit', 'single']
  methods.forEach(method => {
    mock[method] = jest.fn(() => mock)
  })
  return mock
}

const mockSupabase = createChainableMock()

describe('ScheduleManager', () => {
  let manager: ScheduleManager

  beforeEach(() => {
    jest.clearAllMocks()
    manager = new ScheduleManager(mockSupabase as any)
  })

  describe('getTradersToRefresh', () => {
    it('should return traders due for refresh', async () => {
      const mockTraders: Partial<TraderWithSchedule>[] = [
        {
          id: '1',
          platform: 'binance_futures',
          trader_key: 'trader1',
          handle: 'trader1',
          activity_tier: 'hot' as ActivityTier,
          next_refresh_at: new Date(Date.now() - 1000).toISOString(),
          refresh_priority: 1,
        },
        {
          id: '2',
          platform: 'bybit',
          trader_key: 'trader2',
          handle: 'trader2',
          activity_tier: 'active' as ActivityTier,
          next_refresh_at: new Date(Date.now() - 2000).toISOString(),
          refresh_priority: 2,
        },
      ]

      mockSupabase.limit.mockResolvedValueOnce({ data: mockTraders, error: null })

      const result = await manager.getTradersToRefresh({ limit: 10 })

      expect(result).toHaveLength(2)
      expect(result[0].trader_key).toBe('trader1')
      expect(mockSupabase.from).toHaveBeenCalledWith('trader_sources')
    })

    it('should filter by platform when specified', async () => {
      mockSupabase.limit.mockResolvedValueOnce({ data: [], error: null })

      await manager.getTradersToRefresh({ platform: 'binance_futures' })

      expect(mockSupabase.eq).toHaveBeenCalledWith('platform', 'binance_futures')
    })

    it('should filter by tiers when specified', async () => {
      mockSupabase.limit.mockResolvedValueOnce({ data: [], error: null })

      await manager.getTradersToRefresh({ tiers: ['hot', 'active'] })

      expect(mockSupabase.in).toHaveBeenCalledWith('activity_tier', ['hot', 'active'])
    })

    it('should throw error when query fails', async () => {
      mockSupabase.limit.mockResolvedValueOnce({
        data: null,
        error: { message: 'Database error' }
      })

      await expect(manager.getTradersToRefresh()).rejects.toEqual({ message: 'Database error' })
    })
  })

  describe('getTierStats', () => {
    it('should return correct tier statistics', async () => {
      const mockData = [
        { activity_tier: 'hot' },
        { activity_tier: 'hot' },
        { activity_tier: 'active' },
        { activity_tier: 'normal' },
        { activity_tier: 'normal' },
        { activity_tier: 'normal' },
        { activity_tier: 'dormant' },
      ]

      mockSupabase.eq.mockResolvedValueOnce({ data: mockData, error: null })

      const stats = await manager.getTierStats()

      expect(stats.hot).toBe(2)
      expect(stats.active).toBe(1)
      expect(stats.normal).toBe(3)
      expect(stats.dormant).toBe(1)
      expect(stats.total).toBe(7)
    })

    it('should handle empty result', async () => {
      mockSupabase.eq.mockResolvedValueOnce({ data: [], error: null })

      const stats = await manager.getTierStats()

      expect(stats.hot).toBe(0)
      expect(stats.active).toBe(0)
      expect(stats.normal).toBe(0)
      expect(stats.dormant).toBe(0)
      expect(stats.total).toBe(0)
    })
  })

  describe('getOverdueTraders', () => {
    it('should return traders past their refresh time', async () => {
      const mockOverdue = [
        {
          id: '1',
          platform: 'binance_futures',
          trader_key: 'overdue1',
          next_refresh_at: new Date(Date.now() - 3600000).toISOString(),
        },
      ]

      mockSupabase.order.mockResolvedValueOnce({ data: mockOverdue, error: null })

      const result = await manager.getOverdueTraders()

      expect(result).toHaveLength(1)
      expect(mockSupabase.lt).toHaveBeenCalled()
    })

    it('should filter by platform when specified', async () => {
      mockSupabase.order.mockResolvedValueOnce({ data: [], error: null })

      await manager.getOverdueTraders('bybit')

      expect(mockSupabase.eq).toHaveBeenCalledWith('platform', 'bybit')
    })
  })

  describe('markRefreshed', () => {
    it('should update last_refreshed_at and next_refresh_at', async () => {
      const traderId = 'test-trader-1'

      mockSupabase.in.mockResolvedValueOnce({
        data: [{ id: traderId, activity_tier: 'hot' }],
        error: null
      })
      mockSupabase.eq.mockResolvedValueOnce({ error: null })

      await manager.markRefreshed([traderId])

      expect(mockSupabase.from).toHaveBeenCalledWith('trader_sources')
      expect(mockSupabase.update).toHaveBeenCalled()
    })

    it('should handle empty trader list', async () => {
      mockSupabase.in.mockResolvedValueOnce({ data: [], error: null })

      await manager.markRefreshed([])

      expect(mockSupabase.update).not.toHaveBeenCalled()
    })
  })

  describe('updateSchedules', () => {
    it('should update schedules in batches', async () => {
      const schedules: ScheduledJob[] = [
        {
          traderId: 'trader1',
          platform: 'binance_futures',
          tier: 'hot',
          nextRunAt: new Date(),
          priority: 1,
        },
        {
          traderId: 'trader2',
          platform: 'bybit',
          tier: 'active',
          nextRunAt: new Date(),
          priority: 2,
        },
      ]

      // Mock the final eq to return the result
      mockSupabase.eq.mockImplementation(() => {
        // Return a promise-like object for the final call in the chain
        return {
          eq: jest.fn().mockResolvedValue({ error: null }),
          ...mockSupabase
        }
      })

      await manager.updateSchedules(schedules)

      expect(mockSupabase.from).toHaveBeenCalledWith('trader_sources')
    })

    it('should handle update errors gracefully', async () => {
      const schedules: ScheduledJob[] = [
        {
          traderId: 'trader1',
          platform: 'binance_futures',
          tier: 'hot',
          nextRunAt: new Date(),
          priority: 1,
        },
      ]

      mockSupabase.eq.mockImplementation(() => {
        return {
          eq: jest.fn().mockResolvedValue({ error: { message: 'Update failed' } }),
          ...mockSupabase
        }
      })

      // Should not throw, just log error
      await manager.updateSchedules(schedules)
      expect(mockSupabase.from).toHaveBeenCalled()
    })
  })
})
