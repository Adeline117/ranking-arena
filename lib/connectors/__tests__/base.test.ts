/**
 * Tests for BaseConnector and BaseConnectorLegacy (lib/connectors/base.ts)
 * ~20 tests covering HTTP request, retry, backoff, error normalization, timeout, circuit breaker
 */

import { BaseConnector, BaseConnectorLegacy, CircuitOpenError, isError, toError } from '../base'
import { ConnectorError } from '../types'
import type {
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  PlatformCapabilities,
  LeaderboardPlatform,
  MarketType,
  Window,
} from '../../types/leaderboard'

// ============================================
// Mock setup
// ============================================

// Mock cockatiel to avoid importing the real module
jest.mock('cockatiel', () => ({
  BrokenCircuitError: class BrokenCircuitError extends Error {
    constructor() {
      super('Circuit is broken')
      this.name = 'BrokenCircuitError'
    }
  },
}))

// Mock circuit-registry
jest.mock('../circuit-registry', () => ({
  getPlatformPolicy: jest.fn(() => ({
    execute: jest.fn((fn: () => Promise<unknown>) => fn()),
  })),
  BrokenCircuitError: class BrokenCircuitError extends Error {
    constructor() {
      super('Circuit broken')
      this.name = 'BrokenCircuitError'
    }
  },
}))

// Mock cache
jest.mock('../../cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
}))

// Mock route-config
jest.mock('../route-config', () => ({
  getRouteConfig: jest.fn(() => ({ routes: ['direct'] })),
  resolveRouteUrl: jest.fn(() => null),
  resolveRouteKey: jest.fn(() => ''),
}))

// Save the original fetch
const originalFetch = globalThis.fetch

// ============================================
// Concrete test subclass for BaseConnector
// ============================================

class TestConnector extends BaseConnector {
  readonly platform = 'binance_futures' as LeaderboardPlatform
  readonly marketType = 'futures' as MarketType
  readonly capabilities: PlatformCapabilities = {
    native_windows: ['7d', '30d', '90d'] as Window[],
    has_profile: true,
    has_timeseries: false,
    has_position_data: false,
    max_leaderboard_size: 100,
  }

  // Expose the protected request method for testing
  async testRequest<T>(url: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, options)
  }

  // Expose buildQualityFlags
  testBuildQualityFlags(metrics: Record<string, unknown>, window: Window, isNative: boolean) {
    return this.buildQualityFlags(metrics as never, window, isNative)
  }

  // Expose buildProvenance
  testBuildProvenance(sourceUrl: string | null) {
    return this.buildProvenance(sourceUrl)
  }

  // Expose isNativeWindow
  testIsNativeWindow(window: Window) {
    return this.isNativeWindow(window)
  }

  // Expose mapWindowToPlatform
  testMapWindowToPlatform(window: Window) {
    return this.mapWindowToPlatform(window)
  }

  // Expose emptyMetrics
  testEmptyMetrics() {
    return this.emptyMetrics()
  }

  // Expose getDateBucket
  testGetDateBucket() {
    return this.getDateBucket()
  }

  async discoverLeaderboard(): Promise<DiscoverResult> {
    return { traders: [], total: 0, provenance: this.testBuildProvenance(null) }
  }

  async fetchTraderProfile(): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(): Promise<TimeseriesResult> {
    return { data_points: [], provenance: this.testBuildProvenance(null) }
  }

  normalize(raw: unknown): Record<string, unknown> {
    return raw as Record<string, unknown>
  }
}

// ============================================
// Type Guards
// ============================================

describe('Type Guards', () => {
  describe('isError', () => {
    it('should return true for Error instances', () => {
      expect(isError(new Error('test'))).toBe(true)
      expect(isError(new TypeError('type error'))).toBe(true)
    })

    it('should return false for non-Error values', () => {
      expect(isError('string')).toBe(false)
      expect(isError(42)).toBe(false)
      expect(isError(null)).toBe(false)
      expect(isError(undefined)).toBe(false)
      expect(isError({ message: 'not an error' })).toBe(false)
    })
  })

  describe('toError', () => {
    it('should return Error instances as-is', () => {
      const err = new Error('test')
      expect(toError(err)).toBe(err)
    })

    it('should wrap strings in Error', () => {
      const result = toError('string error')
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('string error')
    })

    it('should extract message from objects with message property', () => {
      const result = toError({ message: 'obj error' })
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('obj error')
    })

    it('should stringify other values', () => {
      const result = toError(42)
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('42')
    })
  })
})

// ============================================
// CircuitOpenError
// ============================================

describe('CircuitOpenError', () => {
  it('should have correct name and message', () => {
    const err = new CircuitOpenError('test circuit open')
    expect(err.name).toBe('CircuitOpenError')
    expect(err.message).toBe('test circuit open')
    expect(err).toBeInstanceOf(Error)
  })
})

// ============================================
// BaseConnector - Utility Methods
// ============================================

describe('BaseConnector', () => {
  let connector: TestConnector

  beforeEach(() => {
    connector = new TestConnector()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('emptyMetrics', () => {
    it('should return all null metric fields', () => {
      const metrics = connector.testEmptyMetrics()
      expect(metrics.roi).toBeNull()
      expect(metrics.pnl).toBeNull()
      expect(metrics.win_rate).toBeNull()
      expect(metrics.max_drawdown).toBeNull()
      expect(metrics.sharpe_ratio).toBeNull()
      expect(metrics.arena_score).toBeNull()
    })
  })

  describe('isNativeWindow', () => {
    it('should detect native windows', () => {
      expect(connector.testIsNativeWindow('7d')).toBe(true)
      expect(connector.testIsNativeWindow('30d')).toBe(true)
      expect(connector.testIsNativeWindow('90d')).toBe(true)
    })
  })

  describe('mapWindowToPlatform', () => {
    it('should map standard windows', () => {
      expect(connector.testMapWindowToPlatform('7d')).toBe('WEEKLY')
      expect(connector.testMapWindowToPlatform('30d')).toBe('MONTHLY')
      expect(connector.testMapWindowToPlatform('90d')).toBe('QUARTERLY')
    })
  })

  describe('getDateBucket', () => {
    it('should truncate to the current hour', () => {
      const bucket = connector.testGetDateBucket()
      const date = new Date(bucket)
      expect(date.getMinutes()).toBe(0)
      expect(date.getSeconds()).toBe(0)
      expect(date.getMilliseconds()).toBe(0)
    })
  })

  describe('buildProvenance', () => {
    it('should include platform and method', () => {
      const prov = connector.testBuildProvenance('https://api.example.com')
      expect(prov.source_platform).toBe('binance_futures')
      expect(prov.acquisition_method).toBe('api')
      expect(prov.source_url).toBe('https://api.example.com')
      expect(prov.fetched_at).toBeDefined()
    })
  })

  describe('buildQualityFlags', () => {
    it('should report missing fields', () => {
      const flags = connector.testBuildQualityFlags(
        { roi: 10, pnl: null, win_rate: undefined },
        '7d',
        true
      )
      expect(flags.missing_fields).toContain('pnl')
      expect(flags.missing_fields).toContain('win_rate')
      expect(flags.window_native).toBe(true)
    })

    it('should note non-native windows', () => {
      const flags = connector.testBuildQualityFlags({}, '30d', false)
      expect(flags.window_native).toBe(false)
      expect(flags.notes.length).toBeGreaterThan(0)
    })
  })

  describe('request with retry and error handling', () => {
    it('should succeed on 200 with JSON content-type', async () => {
      globalThis.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
        json: () => Promise.resolve({ data: 'ok' }),
      })

      const result = await connector.testRequest<{ data: string }>('https://api.example.com')
      expect(result.data).toBe('ok')
    })

    it('should throw ConnectorError on 400 client error (non-retryable)', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: { get: () => 'application/json' },
      })

      await expect(
        connector.testRequest('https://api.example.com')
      ).rejects.toThrow('Client error: 400')
    })

    it('should retry on 500 server error with exponential backoff', async () => {
      let callCount = 0
      globalThis.fetch = jest.fn().mockImplementation(() => {
        callCount++
        if (callCount <= 2) {
          return Promise.resolve({
            ok: false,
            status: 500,
            headers: { get: () => 'application/json' },
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
          json: () => Promise.resolve({ result: 'recovered' }),
        })
      })

      const result = await connector.testRequest<{ result: string }>('https://api.example.com')
      expect(result.result).toBe('recovered')
      expect(callCount).toBe(3) // 2 failures + 1 success
    })

    it('should throw after max retries on persistent 500', async () => {
      const conn = new TestConnector({ maxRetries: 1, retryBaseDelay: 10 })
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
      })

      await expect(
        conn.testRequest('https://api.example.com')
      ).rejects.toThrow()
    })

    it('should throw on 429 rate limit with retryAfter', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: (h: string) => h === 'Retry-After' ? '30' : 'application/json' },
      })

      const conn = new TestConnector({ maxRetries: 0 })

      await expect(
        conn.testRequest('https://api.example.com')
      ).rejects.toThrow('Rate limited')
    })

    it('should detect WAF/CloudFlare block (non-JSON content-type on 200)', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (h: string) => h === 'content-type' ? 'text/html' : null },
      })

      const conn = new TestConnector({ maxRetries: 0 })

      await expect(
        conn.testRequest('https://api.example.com')
      ).rejects.toThrow('WAF/CloudFlare block detected')
    })

    it('should handle fetch abort on timeout', async () => {
      globalThis.fetch = jest.fn().mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('The operation was aborted')), 50)
        })
      })

      const conn = new TestConnector({ maxRetries: 0, timeout: 10 })

      await expect(
        conn.testRequest('https://api.example.com')
      ).rejects.toThrow()
    })

    it('should check circuit breaker on rate limiter before request', async () => {
      const mockLimiter = {
        acquire: jest.fn().mockResolvedValue(undefined),
        release: jest.fn(),
        isCircuitOpen: jest.fn().mockReturnValue(true),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
        getState: jest.fn(),
      }
      connector.setRateLimiter(mockLimiter)

      await expect(
        connector.testRequest('https://api.example.com')
      ).rejects.toThrow('Circuit breaker is open')
    })
  })
})

// ============================================
// BaseConnectorLegacy
// ============================================

describe('BaseConnectorLegacy', () => {
  // Create a concrete subclass for testing
  class TestLegacyConnector extends BaseConnectorLegacy {
    readonly platform = 'binance_futures' as never

    constructor() {
      super({ max_concurrent: 2, max_requests: 10, window_ms: 1000, min_delay_ms: 0, max_delay_ms: 0 })
      this.init()
    }

    // Expose requestWithCircuitBreaker for testing
    async testRequest<T>(fn: () => Promise<T>, options?: { retries?: number; label?: string }): Promise<T> {
      return this.requestWithCircuitBreaker(fn, options)
    }

    testBuildQuality(metrics: Record<string, unknown>) {
      return this.buildQuality(metrics)
    }
  }

  describe('requestWithCircuitBreaker', () => {
    it('should execute successfully on first try', async () => {
      const conn = new TestLegacyConnector()
      const result = await conn.testRequest(() => Promise.resolve('ok'))
      expect(result).toBe('ok')
    })

    it('should throw after exhausting retries', async () => {
      const conn = new TestLegacyConnector()
      let attempts = 0

      await expect(
        conn.testRequest(
          () => {
            attempts++
            return Promise.reject(new Error('persistent fail'))
          },
          { retries: 1, label: 'test' }
        )
      ).rejects.toThrow('failed after 2 attempts')

      expect(attempts).toBe(2) // initial + 1 retry
    })
  })

  describe('buildQuality', () => {
    it('should compute confidence and missing fields', () => {
      const quality = new TestLegacyConnector().testBuildQuality({
        roi: 10,
        pnl: null,
        win_rate: 50,
        max_drawdown: undefined,
      })

      expect(quality.is_complete).toBe(false)
      expect(quality.missing_fields).toContain('pnl')
      expect(quality.missing_fields).toContain('max_drawdown')
      expect(quality.confidence).toBe(0.5) // 2/4 present
      expect(quality.is_interpolated).toBe(false)
    })

    it('should report complete when no missing fields', () => {
      const quality = new TestLegacyConnector().testBuildQuality({
        roi: 10,
        pnl: 1000,
      })

      expect(quality.is_complete).toBe(true)
      expect(quality.missing_fields).toHaveLength(0)
      expect(quality.confidence).toBe(1)
    })
  })
})
