/**
 * @jest-environment node
 */

jest.mock('@/lib/constants/exchanges', () => ({
  EXCHANGE_CONFIG: Object.fromEntries(
    ['dynamic_loaded', 'loaded', 'missing_fresh', 'missing_stale', 'missing_unknown'].map(
      (source) => [source, { sourceType: 'futures' }]
    )
  ),
}))

import { checkPlatformFreshness } from '../freshness-check'
import type { TraderRow } from '../trader-row'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function trader(
  source: string,
  capturedAt: string,
  id = 'trader',
  sourceBoardAsOf = capturedAt
): TraderRow {
  return {
    source,
    source_trader_id: id,
    roi: 10,
    pnl: 100,
    win_rate: null,
    max_drawdown: null,
    trades_count: 10,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: capturedAt,
    source_board_as_of: sourceBoardAsOf,
    full_confidence_at: null,
    profitability_score: null,
    risk_control_score: null,
    execution_score: null,
    score_completeness: null,
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    metrics_estimated: false,
  }
}

function watermarkQuery(result: {
  data: Array<{ source: string; source_as_of: string }> | null
  error: { message: string } | null
}) {
  const eq = jest.fn().mockResolvedValue(result)
  const select = jest.fn(() => ({ eq }))
  return { select, eq }
}

const DEFAULT_EXPECTED = ['loaded', 'missing_fresh', 'missing_stale', 'missing_unknown']

function authorityRows(season: '7D' | '30D' | '90D', sources = DEFAULT_EXPECTED) {
  return sources.map((source) => ({
    registry_slug: source,
    filter_source: source,
    exchange_name: source,
    season_id: season,
  }))
}

function supabaseWithAuthority(params: {
  from: jest.Mock
  season: '7D' | '30D' | '90D'
  sources?: string[]
  authorityData?: unknown
  authorityError?: { message: string } | null
}) {
  const rpc = jest.fn().mockResolvedValue({
    data: params.authorityData ?? authorityRows(params.season, params.sources),
    error: params.authorityError ?? null,
  })
  return { from: params.from, rpc }
}

describe('compute leaderboard freshness gate', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses current board watermarks plus persisted per-window source watermarks', async () => {
    const query = watermarkQuery({
      data: [
        { source: 'missing_fresh', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'missing_stale', source_as_of: '2026-07-16T08:00:00.000Z' },
      ],
      error: null,
    })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([['loaded:one', trader('loaded', '2026-07-18T10:00:00.000Z', 'one')]])

    const supabase = supabaseWithAuthority({ from, season: '30D' })

    await expect(checkPlatformFreshness(supabase as never, traderMap, '30D')).resolves.toEqual({
      expectedPlatforms: ['loaded', 'missing_fresh', 'missing_stale', 'missing_unknown'],
      freshPlatforms: ['loaded'],
      stalePlatforms: ['missing_stale', 'missing_unknown'],
      queryFailedPlatforms: ['missing_fresh'],
    })

    expect(supabase.rpc).toHaveBeenCalledWith('arena_freshness_expected_sources')
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('leaderboard_source_freshness')
    expect(query.select).toHaveBeenCalledWith('source,source_as_of')
    expect(query.eq).toHaveBeenCalledWith('season_id', '30D')
  })

  it('treats a stale row observation with a fresh source board as fresh', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:one',
        trader('loaded', '2026-07-15T11:00:00.000Z', 'one', '2026-07-18T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness(
      supabaseWithAuthority({ from, season: '7D' }) as never,
      traderMap,
      '7D'
    )

    expect(result.freshPlatforms).toContain('loaded')
    expect(result.stalePlatforms).not.toContain('loaded')
  })

  it('treats a fresh row observation with a stale source board as stale', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:one',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'one', '2026-07-15T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness(
      supabaseWithAuthority({ from, season: '7D' }) as never,
      traderMap,
      '7D'
    )

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it('uses the oldest watermark when a loaded source contains mixed boards', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      [
        'loaded:new',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'new', '2026-07-18T11:00:00.000Z'),
      ],
      [
        'loaded:old',
        trader('loaded', '2026-07-18T11:00:00.000Z', 'old', '2026-07-15T11:00:00.000Z'),
      ],
    ])

    const result = await checkPlatformFreshness(
      supabaseWithAuthority({ from, season: '7D' }) as never,
      traderMap,
      '7D'
    )

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it.each([
    ['invalid', 'not-a-timestamp'],
    ['far-future', '2026-07-18T12:10:00.000Z'],
  ])('treats a loaded source with an %s board watermark as stale', async (_case, boardAsOf) => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      ['loaded:one', trader('loaded', '2026-07-18T11:00:00.000Z', 'one', boardAsOf)],
    ])

    const result = await checkPlatformFreshness(
      supabaseWithAuthority({ from, season: '7D' }) as never,
      traderMap,
      '7D'
    )

    expect(result.stalePlatforms).toContain('loaded')
    expect(result.freshPlatforms).not.toContain('loaded')
  })

  it('classifies missing sources as query failures when provenance cannot be read', async () => {
    const query = watermarkQuery({
      data: null,
      error: { message: 'relation unavailable' },
    })
    const from = jest.fn(() => ({ select: query.select }))

    const result = await checkPlatformFreshness(
      supabaseWithAuthority({ from, season: '90D' }) as never,
      new Map(),
      '90D'
    )

    expect(result.queryFailedPlatforms).toEqual([
      'loaded',
      'missing_fresh',
      'missing_stale',
      'missing_unknown',
    ])
    expect(result.stalePlatforms).toEqual([])
  })

  it('classifies a configured registry source that is absent from the historical list', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const traderMap = new Map([
      ['dynamic_loaded:one', trader('dynamic_loaded', '2026-07-18T11:00:00.000Z', 'one')],
    ])

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({ from, season: '30D', sources: ['dynamic_loaded'] }) as never,
        traderMap,
        '30D'
      )
    ).resolves.toMatchObject({
      expectedPlatforms: ['dynamic_loaded'],
      freshPlatforms: ['dynamic_loaded'],
    })
  })

  it('deduplicates physical registry boards that share one public source alias', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))
    const authorityData = [
      {
        registry_slug: 'loaded_usdt',
        filter_source: 'loaded',
        exchange_name: 'Loaded',
        season_id: '30D',
      },
      {
        registry_slug: 'loaded_usdc',
        filter_source: 'loaded',
        exchange_name: 'Loaded',
        season_id: '30D',
      },
    ]

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({ from, season: '30D', authorityData }) as never,
        new Map([['loaded:one', trader('loaded', '2026-07-18T11:00:00.000Z')]]),
        '30D'
      )
    ).resolves.toMatchObject({
      expectedPlatforms: ['loaded'],
      freshPlatforms: ['loaded'],
    })
  })

  it('fails closed when the registry authority is unavailable or malformed', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({
          from,
          season: '7D',
          authorityError: { message: 'rpc unavailable' },
        }) as never,
        new Map(),
        '7D'
      )
    ).rejects.toThrow('authority is unavailable')

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({ from, season: '7D', authorityData: [] }) as never,
        new Map(),
        '7D'
      )
    ).rejects.toThrow('returned no windows')
  })

  it('fails closed on season gaps, unconfigured promises, and authority-external inputs', async () => {
    const query = watermarkQuery({ data: [], error: null })
    const from = jest.fn(() => ({ select: query.select }))

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({
          from,
          season: '7D',
          authorityData: authorityRows('30D', ['loaded']),
        }) as never,
        new Map(),
        '7D'
      )
    ).rejects.toThrow('returned no season rows')

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({ from, season: '7D', sources: ['unconfigured'] }) as never,
        new Map(),
        '7D'
      )
    ).rejects.toThrow('lack exchange configuration')

    await expect(
      checkPlatformFreshness(
        supabaseWithAuthority({ from, season: '7D', sources: ['loaded'] }) as never,
        new Map([['dynamic_loaded:one', trader('dynamic_loaded', '2026-07-18T11:00:00.000Z')]]),
        '7D'
      )
    ).rejects.toThrow('outside the registry authority')
  })

  it('keeps compute membership independent of the historical source allowlist', () => {
    const freshness = readFileSync(
      join(process.cwd(), 'app/api/cron/compute-leaderboard/freshness-check.ts'),
      'utf8'
    )
    const route = readFileSync(
      join(process.cwd(), 'app/api/cron/compute-leaderboard/route.ts'),
      'utf8'
    )

    expect(freshness).not.toContain('SOURCES_WITH_DATA')
    expect(route).not.toContain('SOURCES_WITH_DATA')
    expect(freshness).toContain("rpc('arena_freshness_expected_sources')")
  })
})
