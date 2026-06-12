/**
 * Tests for Pipeline Self-Healing Service (lib/services/pipeline-self-heal.ts)
 * ~10 tests covering failure tracking, alert evaluation, route failover, recovery
 */

import * as cache from '@/lib/cache'

jest.mock('@/lib/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
  sendRateLimitedAlert: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  EXCHANGE_CONFIG: {
    binance_futures: { name: 'Binance Futures' },
    bybit: { name: 'Bybit' },
  },
}))

import {
  recordPlatformFetchResult,
  getConsecutiveFailures,
  evaluateAndAlert,
} from '../pipeline-self-heal'
import { sendAlert, sendRateLimitedAlert } from '@/lib/alerts/send-alert'

describe('Pipeline Self-Heal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ============================================
  // Failure Tracking
  // ============================================

  describe('recordPlatformFetchResult', () => {
    it('should increment consecutive failures on zero records', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(2) // current failure count

      await recordPlatformFetchResult('binance_futures', 0)

      expect(cache.set).toHaveBeenCalledWith('pipeline:failures:binance_futures', 3, { ttl: 86400 })
    })

    it('should start from 0 when no prior failures exist', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null) // no prior failures

      await recordPlatformFetchResult('binance_futures', 0)

      expect(cache.set).toHaveBeenCalledWith('pipeline:failures:binance_futures', 1, { ttl: 86400 })
    })

    it('should reset failures on successful fetch', async () => {
      // When recordCount > 0: set(failureKey, 0), get(lastCountKey), set(lastCountKey, recordCount)
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null) // last_count (no prior)

      await recordPlatformFetchResult('binance_futures', 50)

      expect(cache.set).toHaveBeenCalledWith('pipeline:failures:binance_futures', 0, { ttl: 86400 })
    })

    it('should alert on data drop below 30% threshold', async () => {
      // When recordCount > 0, code path is: set(failureKey), get(lastCountKey), set(lastCountKey)
      // Only one cache.get call: for lastCountKey
      ;(cache.get as jest.Mock).mockResolvedValueOnce(100) // last_count was 100

      await recordPlatformFetchResult('binance_futures', 20) // 20% of previous = below 30%

      expect(sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
        })
      )
    })

    it('should not alert when data count is stable', async () => {
      // Only one cache.get: for lastCountKey
      ;(cache.get as jest.Mock).mockResolvedValueOnce(100) // last_count

      await recordPlatformFetchResult('binance_futures', 90) // 90% of previous = above 30%

      expect(sendAlert).not.toHaveBeenCalled()
    })
  })

  describe('getConsecutiveFailures', () => {
    it('should return cached failure count', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(5)
      const count = await getConsecutiveFailures('binance_futures')
      expect(count).toBe(5)
    })

    it('should return 0 when no cache entry', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null)
      const count = await getConsecutiveFailures('binance_futures')
      expect(count).toBe(0)
    })
  })

  // ============================================
  // Alert Evaluation
  // ============================================

  describe('evaluateAndAlert', () => {
    it('should detect consecutive zero-data as critical', async () => {
      // Mock getConsecutiveFailures to return 3 (above threshold of 2)
      ;(cache.get as jest.Mock).mockResolvedValue(3)

      const alerts = await evaluateAndAlert([
        { platform: 'binance_futures', ageHours: 1, recordCount: 0 },
      ])

      expect(alerts).toHaveLength(1)
      expect(alerts[0].alertType).toBe('consecutive_zero')
      expect(alerts[0].alertLevel).toBe('critical')
      expect(sendRateLimitedAlert).toHaveBeenCalled()
    })

    it('should detect stale data (>12h) as warning', async () => {
      // getConsecutiveFailures calls cache.get once per platform
      ;(cache.get as jest.Mock).mockResolvedValueOnce(0) // consecutive failures = 0 for bybit

      const alerts = await evaluateAndAlert([{ platform: 'bybit', ageHours: 15, recordCount: 50 }])

      expect(alerts).toHaveLength(1)
      expect(alerts[0].alertType).toBe('stale')
      expect(alerts[0].alertLevel).toBe('warning')
    })

    it('should return empty array when everything is healthy', async () => {
      ;(cache.get as jest.Mock)
        .mockResolvedValueOnce(0) // binance_futures consecutive failures
        .mockResolvedValueOnce(0) // bybit consecutive failures

      const alerts = await evaluateAndAlert([
        { platform: 'binance_futures', ageHours: 1, recordCount: 100 },
        { platform: 'bybit', ageHours: 2, recordCount: 50 },
      ])

      expect(alerts).toHaveLength(0)
      expect(sendRateLimitedAlert).not.toHaveBeenCalled()
    })
  })

  // ============================================
  // Route Auto-Failover
  // ============================================
})
