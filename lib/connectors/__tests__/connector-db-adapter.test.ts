/**
 * ConnectorDbAdapter Tests
 *
 * Tests writeDiscoverResult and runConnectorBatch with mocked
 * Supabase client and connector instances.
 */

import { writeDiscoverResult, runConnectorBatch } from '@/lib/pipeline/connector-db-adapter'
import type { PlatformConnector } from '../types'
import type { DiscoverResult } from '@/lib/types/leaderboard'

// ============================================
// Mock shared module (upsertTraders, calculateArenaScore, getSupabaseClient)
// ============================================

const mockUpsertTraders = jest.fn()
const mockGetSupabaseClient = jest.fn()

jest.mock('@/lib/cron/fetchers/shared', () => ({
  upsertTraders: (...args: unknown[]) => mockUpsertTraders(...args),
  calculateArenaScore: (roi: number, pnl: number | null) => {
    if (roi <= 0 && (pnl == null || pnl <= 0)) return 0
    return 75.5
  },
  getSupabaseClient: () => mockGetSupabaseClient(),
}))

jest.mock('@/lib/utils/logger', () => {
  const mockLoggerInstance = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() }
  return {
    logger: mockLoggerInstance,
    apiLogger: mockLoggerInstance,
    dataLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    authLogger: mockLoggerInstance,
    perfLogger: mockLoggerInstance,
    createLogger: jest.fn(() => mockLoggerInstance),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

jest.mock('@/lib/constants/exchanges', () => ({
  SOURCE_TYPE_MAP: {},
}))

jest.mock('@/lib/cron/enrichment-runner', () => ({
  ENRICHMENT_PLATFORM_CONFIGS: {},
  NO_ENRICHMENT_PLATFORMS: [],
  runEnrichment: jest.fn(),
}))

// ============================================
// Helpers
// ============================================

function createMockConnector(overrides?: Partial<PlatformConnector>): PlatformConnector {
  return {
    platform: 'test_platform' as never,
    marketType: 'futures' as never,
    capabilities: {
      platform: 'test_platform' as never,
      market_types: ['futures'],
      native_windows: ['7d', '30d', '90d'],
      available_fields: ['roi', 'pnl'],
      has_timeseries: false,
      has_profiles: false,
      scraping_difficulty: 1,
      rate_limit: { rpm: 30, concurrency: 3 },
      notes: [],
    },
    setRateLimiter: jest.fn(),
    discoverLeaderboard: jest.fn(),
    fetchTraderProfile: jest.fn(),
    fetchTraderSnapshot: jest.fn(),
    fetchTimeseries: jest.fn(),
    normalize: (raw: unknown) => {
      const r = raw as Record<string, unknown>
      return {
        trader_key: r.id,
        display_name: r.name,
        roi: r.roi,
        pnl: r.pnl,
        win_rate: null,
        max_drawdown: null,
        followers: null,
        trades_count: null,
        aum: null,
        sharpe_ratio: null,
        platform_rank: null,
        avatar_url: null,
        copiers: null,
      }
    },
    ...overrides,
  }
}

function makeTrader(id: string, data: Record<string, unknown> = {}) {
  return {
    platform: 'test_platform' as never,
    market_type: 'futures' as never,
    trader_key: id,
    display_name: (data.name as string) ?? null,
    profile_url: null,
    discovered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    is_active: true,
    raw: { id, ...data },
  }
}

function makeResult(traders: ReturnType<typeof makeTrader>[], window = '90d'): DiscoverResult {
  return {
    traders,
    total_available: traders.length,
    window: window as '7d' | '30d' | '90d',
    fetched_at: new Date().toISOString(),
  }
}

const mockSupabase = {} as never

// ============================================
// Tests: writeDiscoverResult
// ============================================

describe('writeDiscoverResult', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpsertTraders.mockResolvedValue({ saved: 1, error: undefined })
  })

  it('normalizes traders and returns correct counts', async () => {
    const result = makeResult([
      makeTrader('trader1', { name: 'Test Trader', roi: 50, pnl: 1000 }),
    ])

    const writeResult = await writeDiscoverResult(createMockConnector(), result, { dryRun: true })

    expect(writeResult.total).toBe(1)
    expect(writeResult.saved).toBe(1)
    expect(writeResult.skipped).toBe(0)
    expect(writeResult.window).toBe('90D')
    expect(writeResult.dryRunData).toBeDefined()
    expect(writeResult.dryRunData![0].roi).toBe(50)
    expect(writeResult.dryRunData![0].pnl).toBe(1000)
    expect(writeResult.dryRunData![0].arena_score).not.toBeNull()
  })

  it('handles normalize failure gracefully', async () => {
    const badConnector = createMockConnector({
      normalize: () => { throw new Error('parse error') },
    })

    const result = makeResult([
      makeTrader('bad', { broken: true }),
    ])

    const writeResult = await writeDiscoverResult(badConnector, result, { dryRun: true })

    expect(writeResult.saved).toBe(0)
    expect(writeResult.skipped).toBe(1)
    expect(writeResult.error).toContain('failed normalization')
  })

  it('applies sourceOverride correctly', async () => {
    const result = makeResult([
      makeTrader('t1', { name: 'T1', roi: 10, pnl: 500 }),
    ], '30d')

    const writeResult = await writeDiscoverResult(createMockConnector(), result, {
      dryRun: true,
      sourceOverride: 'htx_futures',
    })

    expect(writeResult.source).toBe('htx_futures')
    expect(writeResult.dryRunData![0].source).toBe('htx_futures')
  })

  it('writes to DB via upsertTraders when not dryRun', async () => {
    mockUpsertTraders.mockResolvedValue({ saved: 2, error: undefined })
    const result = makeResult([
      makeTrader('t1', { name: 'A', roi: 25, pnl: 2000 }),
      makeTrader('t2', { name: 'B', roi: 30, pnl: 3000 }),
    ])

    const writeResult = await writeDiscoverResult(createMockConnector(), result, {
      supabase: mockSupabase,
    })

    expect(mockUpsertTraders).toHaveBeenCalledTimes(1)
    const [_sb, traderDataArray] = mockUpsertTraders.mock.calls[0]
    expect(traderDataArray).toHaveLength(2)
    expect(traderDataArray[0].source_trader_id).toBe('t1')
    expect(traderDataArray[1].source_trader_id).toBe('t2')
    expect(writeResult.saved).toBe(2)
    expect(writeResult.error).toBeUndefined()
  })

  it('skips arena score calculation when calculateScore=false', async () => {
    const result = makeResult([
      makeTrader('t1', { roi: 50, pnl: 5000 }),
    ])

    const writeResult = await writeDiscoverResult(createMockConnector(), result, {
      dryRun: true,
      calculateScore: false,
    })

    expect(writeResult.dryRunData![0].arena_score).toBeNull()
  })

  it('handles empty trader list', async () => {
    const result = makeResult([])

    const writeResult = await writeDiscoverResult(createMockConnector(), result, { dryRun: true })

    expect(writeResult.total).toBe(0)
    expect(writeResult.saved).toBe(0)
    // Empty list is not an error — no traders to normalize
    expect(writeResult.error).toBeUndefined()
  })

  it('returns error when supabase client not available', async () => {
    mockGetSupabaseClient.mockReturnValue(null)
    const result = makeResult([
      makeTrader('t1', { roi: 10, pnl: 1000 }),
    ])

    const writeResult = await writeDiscoverResult(createMockConnector(), result)

    expect(writeResult.error).toContain('Supabase client not available')
    expect(writeResult.saved).toBe(0)
  })

  it('converts window to uppercase correctly', async () => {
    for (const w of ['7d', '30d', '90d']) {
      const result = makeResult(
        [makeTrader('t1', { roi: 10, pnl: 100 })],
        w,
      )
      const wr = await writeDiscoverResult(createMockConnector(), result, { dryRun: true })
      expect(wr.window).toBe(w.toUpperCase())
    }
  })

  it('handles upsertTraders returning an error', async () => {
    mockUpsertTraders.mockResolvedValue({ saved: 0, error: 'DB constraint violation' })
    const result = makeResult([
      makeTrader('t1', { roi: 10, pnl: 1000 }),
    ])

    const writeResult = await writeDiscoverResult(createMockConnector(), result, {
      supabase: mockSupabase,
    })

    expect(writeResult.error).toBe('DB constraint violation')
    expect(writeResult.saved).toBe(0)
  })

  it('counts skipped traders when some fail normalization', async () => {
    let callIdx = 0
    const connector = createMockConnector({
      normalize: (raw: unknown) => {
        callIdx++
        if (callIdx === 2) throw new Error('bad data')
        const r = raw as Record<string, unknown>
        return {
          trader_key: r.id, display_name: null, avatar_url: null,
          roi: r.roi, pnl: r.pnl,
          win_rate: null, max_drawdown: null, trades_count: null,
          followers: null, copiers: null, aum: null,
          sharpe_ratio: null, platform_rank: null,
        }
      },
    })

    const result = makeResult([
      makeTrader('t1', { roi: 10, pnl: 100 }),
      makeTrader('t2', { roi: 'INVALID' }),  // will throw
      makeTrader('t3', { roi: 20, pnl: 200 }),
    ])

    const writeResult = await writeDiscoverResult(connector, result, { dryRun: true })

    expect(writeResult.total).toBe(3)
    expect(writeResult.saved).toBe(2)
    expect(writeResult.skipped).toBe(1)
  })
})

// ============================================
// Tests: runConnectorBatch
// ============================================

describe('runConnectorBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpsertTraders.mockResolvedValue({ saved: 1, error: undefined })
    mockGetSupabaseClient.mockReturnValue(mockSupabase)
  })

  it('fetches all 3 windows by default', async () => {
    const mockDiscover = jest.fn().mockResolvedValue(
      makeResult([makeTrader('t1', { roi: 10, pnl: 1000 })])
    )
    const connector = createMockConnector({ discoverLeaderboard: mockDiscover })

    const fetchResult = await runConnectorBatch(connector, { supabase: mockSupabase })

    expect(fetchResult.source).toBe('test_platform')
    expect(fetchResult.duration).toBeGreaterThanOrEqual(0)
    expect(mockDiscover).toHaveBeenCalledTimes(3)

    const calledWindows = mockDiscover.mock.calls.map((c: unknown[]) => c[0])
    expect(calledWindows).toContain('7d')
    expect(calledWindows).toContain('30d')
    expect(calledWindows).toContain('90d')

    expect(fetchResult.periods['7D']).toBeDefined()
    expect(fetchResult.periods['30D']).toBeDefined()
    expect(fetchResult.periods['90D']).toBeDefined()
  })

  it('handles custom windows and limit', async () => {
    const mockDiscover = jest.fn().mockResolvedValue(
      makeResult([makeTrader('t1', { roi: 10, pnl: 1000 })])
    )
    const connector = createMockConnector({ discoverLeaderboard: mockDiscover })

    await runConnectorBatch(connector, {
      supabase: mockSupabase,
      windows: ['7d'],
      limit: 200,
    })

    expect(mockDiscover).toHaveBeenCalledTimes(1)
    expect(mockDiscover).toHaveBeenCalledWith('7d', 200)
  })

  it('records error for failed windows but does not throw', async () => {
    let callCount = 0
    const mockDiscover = jest.fn().mockImplementation(() => {
      callCount++
      if (callCount === 2) throw new Error('API timeout')
      return Promise.resolve(
        makeResult([makeTrader('t1', { roi: 10, pnl: 1000 })])
      )
    })
    const connector = createMockConnector({ discoverLeaderboard: mockDiscover })

    const fetchResult = await runConnectorBatch(connector, { supabase: mockSupabase })

    const periods = Object.values(fetchResult.periods)
    const errors = periods.filter(p => p.error)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('API timeout')
  })

  it('uses sourceOverride in the final result', async () => {
    const mockDiscover = jest.fn().mockResolvedValue(
      makeResult([makeTrader('t1', { roi: 10, pnl: 1000 })])
    )
    const connector = createMockConnector({ discoverLeaderboard: mockDiscover })

    const fetchResult = await runConnectorBatch(connector, {
      supabase: mockSupabase,
      sourceOverride: 'custom_source',
    })

    expect(fetchResult.source).toBe('custom_source')
  })

  it('returns valid FetchResult structure with periods map', async () => {
    const mockDiscover = jest.fn().mockResolvedValue(
      makeResult([makeTrader('t1', { roi: 10, pnl: 1000 })])
    )
    const connector = createMockConnector({ discoverLeaderboard: mockDiscover })

    const fetchResult = await runConnectorBatch(connector, {
      supabase: mockSupabase,
      windows: ['30d'],
    })

    expect(fetchResult).toHaveProperty('source')
    expect(fetchResult).toHaveProperty('periods')
    expect(fetchResult).toHaveProperty('duration')
    expect(fetchResult.periods['30D']).toHaveProperty('total')
    expect(fetchResult.periods['30D']).toHaveProperty('saved')
  })
})
