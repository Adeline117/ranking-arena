/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockPlogSuccess = jest.fn()
const mockPlogError = jest.fn()
const mockReleaseCronLock = jest.fn()
const mockSupabaseClient = { from: mockFrom, rpc: mockRpc }

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(),
}))

jest.mock('@/lib/cron/utils', () => ({
  isAuthorized: jest.fn((req: Request) => {
    return req.headers.get('authorization') === 'Bearer test-secret'
  }),
  getSupabaseEnv: jest.fn(() => ({
    url: 'http://supabase.test',
    serviceKey: 'test-key',
  })),
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: jest.fn(),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  captureMessage: jest.fn(),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  apiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  captureError: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    dbError: jest.fn(),
  },
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(),
  },
}))

jest.mock('@/lib/services/pipeline-self-heal', () => ({
  evaluateAndAlert: jest.fn(),
}))

import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { evaluateAndAlert } from '@/lib/services/pipeline-self-heal'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { captureMessage } from '@/lib/utils/logger'
import { GET } from '../route'

const mockSendRateLimitedAlert = jest.mocked(sendRateLimitedAlert)
const mockAcquireCronLock = jest.mocked(acquireCronLock)
const mockCaptureMessage = jest.mocked(captureMessage)
const mockEvaluateAndAlert = jest.mocked(evaluateAndAlert)
const mockPipelineStart = jest.mocked(PipelineLogger.start)
const mockedGetSupabaseAdmin = jest.mocked(getSupabaseAdmin)

const NOW = Date.parse('2026-07-18T12:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000
const SEASONS = ['7D', '30D', '90D'] as const

type Season = (typeof SEASONS)[number]

interface TestSource {
  source: string
  count: number
  registrySlug?: string
  exchangeName?: string
}

interface WatermarkRow {
  season_id: Season
  source: string
  source_as_of: unknown
}

const visibleBySeason = new Map<Season, unknown[]>()
const visibleErrors = new Map<Season, unknown>()
let expectedRows: unknown[] = []
let expectedError: unknown = null
let watermarkRows: WatermarkRow[] = []
let watermarkError: unknown = null
const mockWatermarkSelect = jest.fn()
const mockWatermarkIn = jest.fn()

function displayName(source: string): string {
  if (source === 'bybit') return 'Bybit'
  if (source === 'gmx') return 'GMX'
  return 'Binance'
}

function visibleRow(testSource: TestSource) {
  const registrySlug = testSource.registrySlug ?? testSource.source
  return {
    registry_slug: registrySlug,
    filter_source: testSource.source,
    exchange_slug: registrySlug.split('_')[0],
    exchange_name: testSource.exchangeName ?? displayName(testSource.source),
    product_type: 'futures',
    trader_count: testSource.count,
    cache_updated_at: '2026-07-18T11:55:00.000Z',
  }
}

function expectedRow(testSource: TestSource, season: Season) {
  return {
    registry_slug: testSource.registrySlug ?? testSource.source,
    filter_source: testSource.source,
    exchange_name: testSource.exchangeName ?? displayName(testSource.source),
    season_id: season,
  }
}

function setAuthority(sources: TestSource[]): void {
  expectedRows = SEASONS.flatMap((season) => sources.map((source) => expectedRow(source, season)))
  for (const season of SEASONS) {
    visibleBySeason.set(
      season,
      sources.map((source) => visibleRow(source))
    )
  }
  watermarkRows = SEASONS.flatMap((season) =>
    sources.map((source, index) => ({
      season_id: season,
      source: source.source,
      source_as_of: new Date(NOW - (index + 1) * HOUR_MS).toISOString(),
    }))
  )
}

function resetAuthority(): void {
  expectedError = null
  watermarkError = null
  visibleErrors.clear()
  setAuthority([
    { source: 'binance_futures', count: 100 },
    { source: 'bybit', count: 50 },
  ])

  mockRpc.mockImplementation(async (name: string, args?: { p_season_id?: Season }) => {
    if (name === 'arena_freshness_expected_sources') {
      return { data: expectedRows, error: expectedError }
    }
    if (name === 'arena_visible_sources' && args?.p_season_id) {
      return {
        data: visibleBySeason.get(args.p_season_id),
        error: visibleErrors.get(args.p_season_id) ?? null,
      }
    }
    return { data: null, error: { code: 'unexpected_rpc' } }
  })
  mockWatermarkIn.mockImplementation(async () => ({
    data: watermarkRows,
    error: watermarkError,
  }))
  mockWatermarkSelect.mockReturnValue({ in: mockWatermarkIn })
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'leaderboard_source_freshness') {
      throw new Error(`unexpected table: ${table}`)
    }
    return { select: mockWatermarkSelect }
  })
}

function setWatermarkAge(source: string, ageMs: number): void {
  const sourceAsOf = new Date(NOW - ageMs).toISOString()
  watermarkRows = watermarkRows.map((row) =>
    row.source === source ? { ...row, source_as_of: sourceAsOf } : row
  )
}

function createRequest(secret?: string): Request {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new Request('http://localhost:3000/api/cron/check-data-freshness', { headers })
}

describe('GET /api/cron/check-data-freshness', () => {
  beforeAll(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    process.env.CRON_SECRET = 'test-secret'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockedGetSupabaseAdmin.mockReturnValue(
      mockSupabaseClient as ReturnType<typeof getSupabaseAdmin>
    )
    mockPlogSuccess.mockResolvedValue(undefined)
    mockPlogError.mockResolvedValue(undefined)
    mockReleaseCronLock.mockResolvedValue(undefined)
    mockAcquireCronLock.mockResolvedValue(mockReleaseCronLock)
    mockPipelineStart.mockResolvedValue({
      id: 1,
      success: mockPlogSuccess,
      error: mockPlogError,
      partialSuccess: jest.fn(),
      timeout: jest.fn(),
    })
    mockCaptureMessage.mockResolvedValue(undefined)
    mockSendRateLimitedAlert.mockResolvedValue({ sent: true, rateLimited: false, channels: [] })
    mockEvaluateAndAlert.mockResolvedValue([])
    resetAuthority()
  })

  it.each([undefined, 'wrong'])(
    'returns 401 without touching the freshness authority for secret %s',
    async (secret) => {
      const response = await GET(createRequest(secret))

      expect(response.status).toBe(401)
      expect(mockPipelineStart).not.toHaveBeenCalled()
      expect(mockAcquireCronLock).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('skips a duplicate delivery while the distributed lock is held', async () => {
    mockAcquireCronLock.mockResolvedValueOnce(null)

    const response = await GET(createRequest('test-secret'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      skipped: true,
      reason: 'concurrent_execution',
    })
    expect(mockPipelineStart).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockReleaseCronLock).not.toHaveBeenCalled()
  })

  it('uses independent registry, visible-generation, and source_as_of authorities', async () => {
    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      checked_at: '2026-07-18T12:00:00.000Z',
      summary: {
        total: 2,
        fresh: 2,
        stale: 0,
        critical: 0,
        unknown: 0,
      },
    })
    expect(body.platforms).toEqual([
      expect.objectContaining({
        platform: 'binance_futures',
        lastUpdate: '2026-07-18T11:00:00.000Z',
        recordCount: 300,
        status: 'fresh',
      }),
      expect.objectContaining({
        platform: 'bybit',
        lastUpdate: '2026-07-18T10:00:00.000Z',
        recordCount: 150,
        status: 'fresh',
      }),
    ])
    expect(mockRpc.mock.calls).toEqual([
      ['arena_freshness_expected_sources'],
      ...SEASONS.map((season) => ['arena_visible_sources', { p_season_id: season }]),
    ])
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(mockWatermarkSelect).toHaveBeenCalledWith('season_id,source,source_as_of')
    expect(mockWatermarkIn).toHaveBeenCalledWith('season_id', [...SEASONS])
    expect(mockPlogSuccess).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ critical: 0, stale: 0, unknown: 0 })
    )
    expect(mockPlogError).not.toHaveBeenCalled()
    expect(mockAcquireCronLock).toHaveBeenCalledWith('check-data-freshness', {
      ttlSeconds: 150,
    })
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['default just before stale', 'binance_futures', 8 * HOUR_MS - 1, 'fresh'],
    ['default exact stale', 'binance_futures', 8 * HOUR_MS, 'stale'],
    ['default just before critical', 'binance_futures', 24 * HOUR_MS - 1, 'stale'],
    ['default exact critical', 'binance_futures', 24 * HOUR_MS, 'critical'],
    ['override just before stale', 'gmx', 48 * HOUR_MS - 1, 'fresh'],
    ['override exact stale', 'gmx', 48 * HOUR_MS, 'stale'],
    ['override just before critical', 'gmx', 72 * HOUR_MS - 1, 'stale'],
    ['override exact critical', 'gmx', 72 * HOUR_MS, 'critical'],
  ] as const)('preserves the %s threshold', async (_case, source, ageMs, status) => {
    setAuthority([{ source, count: 100 }])
    setWatermarkAge(source, ageMs)

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.platforms).toEqual([
      expect.objectContaining({
        platform: source,
        status,
      }),
    ])
  })

  it('keeps stale alerts and records an unhealthy report as a successful check', async () => {
    setWatermarkAge('binance_futures', 10 * HOUR_MS)

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.summary).toMatchObject({ stale: 1, critical: 0, unknown: 0 })
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('STALE'),
      'warning',
      expect.any(Object)
    )
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning' }),
      'data-freshness:binance_futures',
      expect.any(Number)
    )
    expect(mockPlogSuccess).toHaveBeenCalled()
    expect(mockPlogError).not.toHaveBeenCalled()
  })

  it('fails closed for a missing upstream watermark', async () => {
    watermarkRows = watermarkRows.filter(
      (row) => !(row.season_id === '30D' && row.source === 'bybit')
    )

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.summary).toMatchObject({ fresh: 1, unknown: 1 })
    expect(body.platforms).toContainEqual(
      expect.objectContaining({
        platform: 'bybit',
        lastUpdate: null,
        ageMs: null,
        ageHours: null,
        status: 'unknown',
      })
    )
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('UNKNOWN WATERMARK'),
      'error',
      expect.objectContaining({ level: 'critical' })
    )
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'critical',
        details: expect.objectContaining({ unknown_count: 1 }),
      }),
      'data-freshness:unknown:bybit',
      expect.any(Number)
    )
    expect(mockPlogSuccess).toHaveBeenCalledWith(1, expect.objectContaining({ unknown: 1 }))
  })

  it('keeps a declared registry window observable when its count cache disappears', async () => {
    visibleBySeason.set(
      '30D',
      (visibleBySeason.get('30D') ?? []).filter(
        (row) => (row as { filter_source?: string }).filter_source !== 'bybit'
      )
    )

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.summary).toMatchObject({ fresh: 1, unknown: 1 })
    expect(body.platforms).toContainEqual(
      expect.objectContaining({
        platform: 'bybit',
        status: 'unknown',
        lastUpdate: null,
        recordCount: 100,
      })
    )
    expect(mockPlogSuccess).toHaveBeenCalledWith(1, expect.objectContaining({ unknown: 1 }))
    expect(mockPlogError).not.toHaveBeenCalled()
  })

  it('does not let a far-future source_as_of watermark make a source fresh', async () => {
    watermarkRows = watermarkRows.map((row) =>
      row.season_id === '90D' && row.source === 'bybit'
        ? { ...row, source_as_of: '2026-07-18T12:05:00.001Z' }
        : row
    )

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.summary.unknown).toBe(1)
    expect(body.ok).toBe(false)
  })

  it.each([
    'expected_rpc_error',
    'expected_empty',
    'expected_malformed',
    'visible_rpc_error',
    'visible_malformed',
    'visible_outside_registry',
    'watermark_error',
  ] as const)('returns a sanitized 500 when the authority is blind: %s', async (failure) => {
    if (failure === 'expected_rpc_error') {
      expectedError = { message: 'private-expected-error' }
    } else if (failure === 'expected_empty') {
      expectedRows = []
    } else if (failure === 'expected_malformed') {
      expectedRows = [{ season_id: '90D' }]
    } else if (failure === 'visible_rpc_error') {
      visibleErrors.set('30D', { message: 'private-visible-error' })
    } else if (failure === 'visible_malformed') {
      visibleBySeason.set('30D', [{ trader_count: 10 }])
    } else if (failure === 'visible_outside_registry') {
      visibleBySeason.set('30D', [
        ...(visibleBySeason.get('30D') ?? []),
        visibleRow({ source: 'outside_registry', count: 10 }),
      ])
    } else {
      watermarkError = { message: 'private-watermark-error' }
    }

    const response = await GET(createRequest('test-secret'))
    const serialized = JSON.stringify(await response.json())

    expect(response.status).toBe(500)
    expect(serialized).toBe('{"error":"freshness_authority_unavailable"}')
    expect(serialized).not.toMatch(/private|database|watermark/i)
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '数据新鲜度权威不可用',
        level: 'critical',
      }),
      'data-freshness:authority-unavailable',
      expect.any(Number)
    )
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it('keeps checking healthy data under a separately reported PipelineLogger degradation', async () => {
    mockPipelineStart.mockRejectedValueOnce(new Error('private pipeline connection detail'))

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, summary: { fresh: 2, unknown: 0 } })
    expect(mockRpc).toHaveBeenCalledWith('arena_freshness_expected_sources')
    expect(mockFrom).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(mockPlogError).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '数据新鲜度日志链路不可用',
        level: 'warning',
      }),
      'data-freshness:pipeline-log-unavailable',
      expect.any(Number)
    )
  })

  it('returns a sanitized 500 when the admin client is unavailable', async () => {
    mockedGetSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('private environment detail')
    })

    const response = await GET(createRequest('test-secret'))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'freshness_authority_unavailable' })
    expect(mockPlogError).toHaveBeenCalledTimes(1)
  })

  it('keeps the authority response truthful when alert and logging delivery fail', async () => {
    setWatermarkAge('binance_futures', 10 * HOUR_MS)
    mockCaptureMessage.mockRejectedValueOnce(new Error('sentry unavailable'))
    mockSendRateLimitedAlert.mockRejectedValueOnce(new Error('telegram unavailable'))
    mockEvaluateAndAlert.mockRejectedValueOnce(new Error('self-heal unavailable'))
    mockPlogSuccess.mockRejectedValueOnce(new Error('pipeline log unavailable'))
    mockReleaseCronLock.mockRejectedValueOnce(new Error('redis unlock unavailable'))

    const response = await GET(createRequest('test-secret'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.summary).toMatchObject({ stale: 1, unknown: 0 })
    expect(mockPlogError).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).toHaveBeenCalledTimes(1)
    expect(mockReleaseCronLock).toHaveBeenCalledTimes(1)
  })

  it('keeps a sanitized authority response when failure logging and alerting also fail', async () => {
    expectedRows = []
    mockPlogError.mockRejectedValueOnce(new Error('private plog detail'))
    mockSendRateLimitedAlert.mockRejectedValueOnce(new Error('private alert detail'))

    const response = await GET(createRequest('test-secret'))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'freshness_authority_unavailable' })
  })

  it('contains no static source membership or score-computation freshness fallback', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/cron/check-data-freshness/route.ts'),
      'utf8'
    )

    expect(route).not.toContain('SOURCES_WITH_DATA')
    expect(route).not.toContain("from('leaderboard_ranks')")
    expect(route).not.toContain('computed_at')
    expect(route).toContain("rpc('arena_freshness_expected_sources')")
    expect(route).toContain("rpc('arena_visible_sources'")
    expect(route).toContain("from('leaderboard_source_freshness')")
    expect(route).toContain("select('season_id,source,source_as_of')")
    expect(route).toContain("acquireCronLock('check-data-freshness'")
    expect(route).not.toContain('sendScraperAlert')
  })
})
