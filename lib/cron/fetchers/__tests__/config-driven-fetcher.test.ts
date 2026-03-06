/**
 * Config-Driven Fetcher Tests
 *
 * Tests the createConfigDrivenFetcher factory:
 *   - Returns a valid function
 *   - Period mapping (maps Arena periods to exchange-specific values)
 *   - Pagination handling (page_number, offset, none)
 *   - Field mapping / extraction
 *   - Handles missing period mapping gracefully
 *   - Handles API failures gracefully
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createConfigDrivenFetcher, type ExchangeConfig } from '../config-driven-fetcher'

// ============================================
// Mocks
// ============================================

// Mock the shared module (fetchJsonWithRetry, fetchWithFallback, upsertTraders, sleep)
jest.mock('../shared', () => {
  const actual = jest.requireActual('../shared')
  return {
    ...actual,
    fetchJson: jest.fn(),
    fetchJsonWithRetry: jest.fn(),
    fetchWithFallback: jest.fn(),
    upsertTraders: jest.fn().mockResolvedValue({ saved: 0 }),
    sleep: jest.fn().mockResolvedValue(undefined),
  }
})

// Mock logger
jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  captureException: jest.fn(),
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { fetchJsonWithRetry, fetchWithFallback, upsertTraders } from '../shared'

const mockFetchJson = fetchJsonWithRetry as jest.MockedFunction<typeof fetchJsonWithRetry>
const mockFetchWithFallback = fetchWithFallback as jest.MockedFunction<typeof fetchWithFallback>
const mockUpsertTraders = upsertTraders as jest.MockedFunction<typeof upsertTraders>

// Mock Supabase client
function createMockSupabase(): SupabaseClient {
  const insertFn = jest.fn().mockResolvedValue({ error: null })
  const upsertFn = jest.fn().mockResolvedValue({ error: null })
  return {
    from: jest.fn().mockReturnValue({
      upsert: upsertFn,
      insert: insertFn,
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  } as unknown as SupabaseClient
}

// ============================================
// Minimal exchange config for testing
// ============================================

function createTestConfig(overrides: Partial<ExchangeConfig> = {}): ExchangeConfig {
  return {
    source: 'test_exchange',
    displayName: 'Test Exchange',
    periodMap: {
      '7D': 'WEEKLY',
      '30D': 'MONTHLY',
      '90D': 'QUARTERLY',
    },
    request: {
      url: (period: string, page: number, pageSize: number) =>
        `https://api.test.com/leaderboard?period=${period}&page=${page}&size=${pageSize}`,
      method: 'GET',
      timeoutMs: 10000,
    },
    pagination: {
      type: 'page_number',
      pageSize: 20,
      maxPages: 3,
      target: 50,
    },
    mapping: {
      extractList: (response: unknown) => {
        const data = response as { traders?: unknown[] }
        return data?.traders ?? []
      },
      mapItem: (item: unknown) => {
        const t = item as {
          uid: string
          name: string
          roi: number
          pnl: number
          winRate?: number
          maxDD?: number
        }
        if (!t.uid) return null
        return {
          source_trader_id: t.uid,
          handle: t.name || null,
          roi: t.roi,
          pnl: t.pnl,
          win_rate: t.winRate ?? null,
          max_drawdown: t.maxDD ?? null,
        }
      },
    },
    ...overrides,
  }
}

// ============================================
// createConfigDrivenFetcher — basic contract
// ============================================

describe('createConfigDrivenFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('returns a function ()', () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    expect(typeof fetcher).toBe('function')
  })

  test('returned function accepts (supabase, periods) and returns', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // Mock API returning empty data
    mockFetchJson.mockResolvedValue({ traders: [] })

    const result = await fetcher(supabase, ['30D'])
    expect(result).toHaveProperty('source', 'test_exchange')
    expect(result).toHaveProperty('periods')
    expect(result).toHaveProperty('duration')
    expect(typeof result.duration).toBe('number')
  })

  test('fetcher sets source from config', async () => {
    const config = createTestConfig({ source: 'my_custom_exchange' })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({ traders: [] })

    const result = await fetcher(supabase, ['7D'])
    expect(result.source).toBe('my_custom_exchange')
  })
})

// ============================================
// Period Mapping
// ============================================

describe('Period mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('maps Arena periods to exchange-specific values', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({ traders: [] })

    await fetcher(supabase, ['7D', '30D', '90D'])

    // fetchJson should have been called with URLs containing exchange-specific periods
    const calls = mockFetchJson.mock.calls
    const urls = calls.map(c => c[0])
    expect(urls.some(u => u.includes('WEEKLY'))).toBe(true)
    expect(urls.some(u => u.includes('MONTHLY'))).toBe(true)
    expect(urls.some(u => u.includes('QUARTERLY'))).toBe(true)
  })

  test('handles unmapped period gracefully (returns error in result)', async () => {
    const config = createTestConfig({
      periodMap: { '7D': 'WEEKLY' }, // Only 7D mapped
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({ traders: [] })

    const result = await fetcher(supabase, ['30D'])
    expect(result.periods['30D']).toBeDefined()
    expect(result.periods['30D'].error).toContain('No period mapping')
    expect(result.periods['30D'].total).toBe(0)
    expect(result.periods['30D'].saved).toBe(0)
  })
})

// ============================================
// Pagination
// ============================================

describe('Pagination handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('stops when API returns empty list on second page', async () => {
    const config = createTestConfig({
      pagination: {
        type: 'page_number',
        pageSize: 2,  // Match exactly the number of items we return
        maxPages: 5,
        target: 50,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // First page: full page (2 items = pageSize), second page: empty
    mockFetchJson
      .mockResolvedValueOnce({
        traders: [
          { uid: 'T1', name: 'Trader1', roi: 50, pnl: 5000 },
          { uid: 'T2', name: 'Trader2', roi: 30, pnl: 3000 },
        ],
      })
      .mockResolvedValueOnce({ traders: [] })

    mockUpsertTraders.mockResolvedValue({ saved: 2 })

    const result = await fetcher(supabase, ['30D'])
    // Page 1 is full (2 items = pageSize 2), so it fetches page 2 which is empty
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
    expect(result.periods['30D'].total).toBe(2)
  })

  test('stops after partial page (items < pageSize)', async () => {
    const config = createTestConfig({
      pagination: {
        type: 'page_number',
        pageSize: 20,
        maxPages: 5,
        target: 50,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // Return 2 items when pageSize is 20 — partial page, should stop
    mockFetchJson.mockResolvedValueOnce({
      traders: [
        { uid: 'T1', name: 'Trader1', roi: 50, pnl: 5000 },
        { uid: 'T2', name: 'Trader2', roi: 30, pnl: 3000 },
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 2 })

    const result = await fetcher(supabase, ['30D'])
    // Only 1 call because 2 items < pageSize 20
    expect(mockFetchJson).toHaveBeenCalledTimes(1)
    expect(result.periods['30D'].total).toBe(2)
  })

  test('stops when reaching target count', async () => {
    const config = createTestConfig({
      pagination: {
        type: 'page_number',
        pageSize: 20,
        maxPages: 10,
        target: 2, // Very low target
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // Return exactly 20 items (full page) on first page
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      uid: `T${i}`,
      name: `Trader${i}`,
      roi: 50 + i,
      pnl: 5000 + i * 100,
    }))
    mockFetchJson.mockResolvedValue({ traders: fullPage })
    mockUpsertTraders.mockResolvedValue({ saved: 2 })

    const result = await fetcher(supabase, ['30D'])
    // Should stop after first page because target (2) < total items (20)
    expect(mockFetchJson).toHaveBeenCalledTimes(1)
    expect(result.periods['30D'].total).toBeLessThanOrEqual(2)
  })

  test('stops at maxPages', async () => {
    const config = createTestConfig({
      pagination: {
        type: 'page_number',
        pageSize: 2,
        maxPages: 2,
        target: 100,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // Always return full pages
    mockFetchJson.mockResolvedValue({
      traders: [
        { uid: `T${Date.now()}a`, name: 'A', roi: 50, pnl: 5000 },
        { uid: `T${Date.now()}b`, name: 'B', roi: 30, pnl: 3000 },
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 4 })

    await fetcher(supabase, ['30D'])
    // Should be called at most maxPages (2) times
    expect(mockFetchJson.mock.calls.length).toBeLessThanOrEqual(2)
  })

  test('stops when page has fewer items than pageSize (partial page)', async () => {
    const config = createTestConfig({
      pagination: {
        type: 'page_number',
        pageSize: 5,
        maxPages: 10,
        target: 100,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // Return 3 items (less than pageSize of 5) — indicates last page
    mockFetchJson.mockResolvedValueOnce({
      traders: [
        { uid: 'T1', name: 'A', roi: 50, pnl: 5000 },
        { uid: 'T2', name: 'B', roi: 40, pnl: 4000 },
        { uid: 'T3', name: 'C', roi: 30, pnl: 3000 },
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 3 })

    await fetcher(supabase, ['30D'])
    // Only one page fetched because items < pageSize
    expect(mockFetchJson).toHaveBeenCalledTimes(1)
  })
})

// ============================================
// Field Mapping
// ============================================

describe('Field mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('maps item fields correctly and passes to upsertTraders', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({
      traders: [
        { uid: 'ABC', name: 'TopTrader', roi: 120, pnl: 50000, winRate: 72, maxDD: -15 },
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 1 })

    await fetcher(supabase, ['30D'])

    // Verify upsertTraders was called
    expect(mockUpsertTraders).toHaveBeenCalledTimes(1)
    const tradersArg = mockUpsertTraders.mock.calls[0][1]
    expect(tradersArg.length).toBe(1)
    expect(tradersArg[0].source_trader_id).toBe('ABC')
    expect(tradersArg[0].handle).toBe('TopTrader')
    expect(tradersArg[0].roi).toBe(120)
    expect(tradersArg[0].pnl).toBe(50000)
    expect(tradersArg[0].source).toBe('test_exchange')
    expect(tradersArg[0].season_id).toBe('30D')
  })

  test('skips items where mapItem returns null', async () => {
    const config = createTestConfig({
      mapping: {
        extractList: (response: unknown) => (response as { traders: unknown[] }).traders,
        mapItem: (item: unknown) => {
          const t = item as { uid: string; roi: number; pnl: number }
          // Skip items without uid
          if (!t.uid) return null
          return {
            source_trader_id: t.uid,
            handle: null,
            roi: t.roi,
            pnl: t.pnl,
          }
        },
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({
      traders: [
        { uid: '', roi: 50, pnl: 5000 },   // Will be skipped (empty uid -> null)
        { uid: 'T1', roi: 80, pnl: 8000 }, // Will be kept
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 1 })

    await fetcher(supabase, ['30D'])

    expect(mockUpsertTraders).toHaveBeenCalledTimes(1)
    const tradersArg = mockUpsertTraders.mock.calls[0][1]
    expect(tradersArg.length).toBe(1)
    expect(tradersArg[0].source_trader_id).toBe('T1')
  })

  test('deduplicates by source_trader_id (first seen wins)', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({
      traders: [
        { uid: 'DUP', name: 'First', roi: 100, pnl: 10000 },
        { uid: 'DUP', name: 'Second', roi: 200, pnl: 20000 }, // duplicate
        { uid: 'UNIQUE', name: 'Unique', roi: 50, pnl: 5000 },
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 2 })

    await fetcher(supabase, ['30D'])

    expect(mockUpsertTraders).toHaveBeenCalledTimes(1)
    const tradersArg = mockUpsertTraders.mock.calls[0][1]
    // Should have 2 traders (DUP deduplicated)
    expect(tradersArg.length).toBe(2)
    const dupTrader = tradersArg.find((t: { source_trader_id: string }) => t.source_trader_id === 'DUP')
    expect(dupTrader).toBeDefined()
  })
})

// ============================================
// ROI Normalization (roiIsDecimal flag)
// ============================================

describe('ROI normalization via config', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('converts decimal ROI when roiIsDecimal is true', async () => {
    const config = createTestConfig({
      mapping: {
        extractList: (response: unknown) => (response as { traders: unknown[] }).traders,
        mapItem: (item: unknown) => {
          const t = item as { uid: string; roi: number; pnl: number }
          return {
            source_trader_id: t.uid,
            handle: null,
            roi: t.roi,
            pnl: t.pnl,
          }
        },
        roiIsDecimal: true,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({
      traders: [
        { uid: 'T1', roi: 0.5, pnl: 5000 }, // 0.5 -> 50%
      ],
    })
    mockUpsertTraders.mockResolvedValue({ saved: 1 })

    await fetcher(supabase, ['30D'])

    const tradersArg = mockUpsertTraders.mock.calls[0][1]
    expect(tradersArg[0].roi).toBe(50) // 0.5 * 100 = 50
  })
})

// ============================================
// Proxy fallback
// ============================================

describe('Proxy fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('uses fetchWithFallback when useProxyFallback is true', async () => {
    const config = createTestConfig({
      request: {
        url: 'https://api.test.com/leaderboard',
        method: 'GET',
        useProxyFallback: true,
      },
    })
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchWithFallback.mockResolvedValue({
      data: { traders: [] },
      via: 'direct',
    })

    await fetcher(supabase, ['30D'])

    expect(mockFetchWithFallback).toHaveBeenCalled()
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  test('uses fetchJsonWithRetry when useProxyFallback is false/absent', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue({ traders: [] })

    await fetcher(supabase, ['30D'])

    expect(mockFetchJson).toHaveBeenCalled()
    expect(mockFetchWithFallback).not.toHaveBeenCalled()
  })
})

// ============================================
// Error handling
// ============================================

describe('Error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('catches API errors per period without crashing', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    // First period succeeds, second fails
    mockFetchJson
      .mockResolvedValueOnce({
        traders: [{ uid: 'T1', name: 'A', roi: 50, pnl: 5000 }],
      })
      .mockRejectedValueOnce(new Error('Network timeout'))

    mockUpsertTraders.mockResolvedValue({ saved: 1 })

    const result = await fetcher(supabase, ['7D', '30D'])

    // 7D should have data, 30D should have error
    expect(result.periods['7D']).toBeDefined()
    expect(result.periods['30D']).toBeDefined()
  })

  test('returns zero total when API returns null/no data', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockResolvedValue(null)

    const result = await fetcher(supabase, ['30D'])
    expect(result.periods['30D'].total).toBe(0)
    expect(result.periods['30D'].saved).toBe(0)
  })

  test('records duration even on failure', async () => {
    const config = createTestConfig()
    const fetcher = createConfigDrivenFetcher(config)
    const supabase = createMockSupabase()

    mockFetchJson.mockRejectedValue(new Error('fail'))

    const result = await fetcher(supabase, ['30D'])
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })
})
