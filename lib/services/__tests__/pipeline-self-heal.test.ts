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

jest.mock('@/lib/connectors/route-config', () => ({
  getRouteConfig: jest.fn((platform: string) => {
    if (platform === 'binance_futures') {
      return { routes: ['direct', 'vps_sg', 'scraper_sg'] }
    }
    return { routes: ['direct'] }
  }),
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
  recordRouteResult,
  getPreferredRoute,
  getRouteFailureCounts,
  resetPreferredRoute,
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

      expect(cache.set).toHaveBeenCalledWith(
        'pipeline:failures:binance_futures',
        3,
        { ttl: 86400 }
      )
    })

    it('should start from 0 when no prior failures exist', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null) // no prior failures

      await recordPlatformFetchResult('binance_futures', 0)

      expect(cache.set).toHaveBeenCalledWith(
        'pipeline:failures:binance_futures',
        1,
        { ttl: 86400 }
      )
    })

    it('should reset failures on successful fetch', async () => {
      // When recordCount > 0: set(failureKey, 0), get(lastCountKey), set(lastCountKey, recordCount)
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null) // last_count (no prior)

      await recordPlatformFetchResult('binance_futures', 50)

      expect(cache.set).toHaveBeenCalledWith(
        'pipeline:failures:binance_futures',
        0,
        { ttl: 86400 }
      )
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

      const alerts = await evaluateAndAlert([
        { platform: 'bybit', ageHours: 15, recordCount: 50 },
      ])

      expect(alerts).toHaveLength(1)
      expect(alerts[0].alertType).toBe('stale')
      expect(alerts[0].alertLevel).toBe('warning')
    })

    it('should return empty array when everything is healthy', async () => {
      ;(cache.get as jest.Mock)
        .mockResolvedValueOnce(0)  // binance_futures consecutive failures
        .mockResolvedValueOnce(0)  // bybit consecutive failures

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

  describe('recordRouteResult', () => {
    it('should reset failure count on success', async () => {
      await recordRouteResult('binance_futures', 'direct', true)

      expect(cache.set).toHaveBeenCalledWith(
        'route:failures:binance_futures:direct',
        0,
        { ttl: 86400 }
      )
    })

    it('should increment failure count on failure', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(1)

      await recordRouteResult('binance_futures', 'direct', false)

      expect(cache.set).toHaveBeenCalledWith(
        'route:failures:binance_futures:direct',
        2,
        { ttl: 86400 }
      )
    })

    it('should switch to next route after 3 consecutive failures', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(2) // will become 3

      await recordRouteResult('binance_futures', 'direct', false)

      // Should set preferred route to 'vps_sg' (next after 'direct')
      expect(cache.set).toHaveBeenCalledWith(
        'route:preferred:binance_futures',
        'vps_sg',
        { ttl: 21600 } // 6h
      )
      expect(sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
        })
      )
    })
  })

  describe('getPreferredRoute', () => {
    it('should return cached preferred route if set', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce('vps_sg')
      const route = await getPreferredRoute('binance_futures')
      expect(route).toBe('vps_sg')
    })

    it('should return first configured route when no override', async () => {
      ;(cache.get as jest.Mock).mockResolvedValueOnce(null)
      const route = await getPreferredRoute('binance_futures')
      expect(route).toBe('direct')
    })
  })

  describe('getRouteFailureCounts', () => {
    it('should return failure counts for all configured routes', async () => {
      ;(cache.get as jest.Mock)
        .mockResolvedValueOnce(1) // direct
        .mockResolvedValueOnce(0) // vps_sg
        .mockResolvedValueOnce(3) // scraper_sg

      const counts = await getRouteFailureCounts('binance_futures')
      expect(counts['direct']).toBe(1)
      expect(counts['vps_sg']).toBe(0)
      expect(counts['scraper_sg']).toBe(3)
    })
  })

  describe('resetPreferredRoute', () => {
    it('should delete the preferred route cache key', async () => {
      await resetPreferredRoute('binance_futures')
      expect(cache.del).toHaveBeenCalledWith('route:preferred:binance_futures')
    })
  })
})
