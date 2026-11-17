import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '../../../profile-capture/contract'
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '../../../profile-capture/test-helper'
import { binanceAdapter } from '../index'
import { parseBinanceProfile } from '../parsers'
import {
  BINANCE_FUTURES_PROFILE_CAPTURE,
  BINANCE_SPOT_PROFILE_CAPTURE,
} from '../profile-capture-contract'

type Board = 'futures' | 'spot'
type Json = Record<string, unknown>

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json
}

function source(board: Board, meta: Json = {}): SourceRow {
  return {
    id: board === 'futures' ? 1 : 2,
    slug: `binance_${board}`,
    exchange_id: 1,
    product_type: board,
    trader_kind_scope: 'human',
    adapter_slug: 'binance',
    leaderboard_url: 'https://www.binance.com/en/copy-trading',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 1_000,
    deep_profile_topn: 300,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'top10',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'vps_sg',
    rate_budget_ms: 2_500,
    phase: 3,
    serving_mode: 'serving',
    status: 'active',
    meta: { boardKey: board, ...meta },
  }
}

/** Real getProfile against recorded responses, routed by request path. */
async function capture(
  board: Board,
  timeframe: RankingTimeframe,
  performance: Json,
  trader = '4163883351504751104',
  meta: Json = {}
): Promise<{ pages: RawPage[]; requested: string[] }> {
  const prefix = board === 'spot' ? 'spot-' : ''
  const requested: string[] = []
  const respond = async (request: ReplayRequestTemplate) => {
    requested.push(request.url)
    const path = new URL(request.url).pathname
    if (path.endsWith('/lead-portfolio/detail')) {
      return { status: 200, json: fixture(`${prefix}detail.json`) }
    }
    if (path.endsWith('/lead-portfolio/performance')) return { status: 200, json: performance }
    if (path.endsWith('/performance/coin') || path.endsWith('/coin-preference')) {
      return { status: 200, json: fixture(`${prefix}coin-preference-7.json`) }
    }
    const dataType = new URL(request.url).searchParams.get('dataType')
    return {
      status: 200,
      json: fixture(`${prefix}chart-${dataType === 'PNL' ? 'pnl' : 'roi'}-7.json`),
    }
  }
  const page = { goto: async () => undefined, waitForLoadState: async () => undefined }
  const session = {
    sourceSlug: `binance_${board}`,
    page: async () => page,
    pageFetch: respond,
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  const bundle = await binanceAdapter.getProfile!(session, source(board, meta), trader, timeframe)
  return { pages: bundle.pages, requested }
}

const ctx = (board: Board) => ({ sourceSlug: `binance_${board}`, meta: { boardKey: board } })

describe('binance profile capture contracts', () => {
  it('are the registered contracts of both boards', () => {
    expect(getProfileCaptureContract('binance_futures')).toBe(BINANCE_FUTURES_PROFILE_CAPTURE)
    expect(getProfileCaptureContract('binance_spot')).toBe(BINANCE_SPOT_PROFILE_CAPTURE)
    // Pinned: any contract change must bump @n and register a new hash.
    expect(profileCaptureContractSha256(BINANCE_FUTURES_PROFILE_CAPTURE)).toBe(
      '5696e1805b3633e23d99f39710e680e511f172013abe4463335235f222a9726d'
    )
    expect(profileCaptureContractSha256(BINANCE_SPOT_PROFILE_CAPTURE)).toBe(
      '6396d1e0416474081964670075b5256e09a48123a0bd271aea3ee2af58295e12'
    )
  })

  it('futures: attests the window drawdown and trade count of the real request', async () => {
    const { pages, requested } = await capture(
      'futures',
      90,
      fixture('profile-performance-futures-90D.json'),
      '5076490769406674432'
    )
    expect(requested).toContain(
      'https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=5076490769406674432&timeRange=90D'
    )
    const result = expectProfileContractAttests({
      contract: BINANCE_FUTURES_PROFILE_CAPTURE,
      timeframe: 90,
      pages,
      parseProfile: parseBinanceProfile,
      ctx: ctx('futures'),
      exchangeTraderId: '5076490769406674432',
      metrics: ['mdd', 'total_positions'],
    })
    expect(result.manifest?.metrics).toEqual({
      mdd: {
        endpoint: 'performance',
        path: ['performance', 'data', 'mdd'],
        raw_value: 0.06575396,
        value: 0.06575396,
      },
      total_positions: {
        endpoint: 'performance',
        path: ['performance', 'data', 'totalOrder'],
        raw_value: 3,
        value: 3,
      },
    })
  })

  it('futures: a window whose trade count is null upstream attests drawdown only', async () => {
    const { pages } = await capture(
      'futures',
      30,
      fixture('profile-performance-futures-30D-no-total.json')
    )
    const result = expectProfileContractAttests({
      contract: BINANCE_FUTURES_PROFILE_CAPTURE,
      timeframe: 30,
      pages,
      parseProfile: parseBinanceProfile,
      ctx: ctx('futures'),
      metrics: ['mdd'],
    })
    expect(result.parsed?.totalPositions).toBeNull()
  })

  it('spot: attests drawdown, never the lifetime win-day ratio', async () => {
    const { pages, requested } = await capture(
      'spot',
      90,
      fixture('profile-performance-spot-90D.json')
    )
    expect(requested).toContain(
      'https://www.binance.com/bapi/futures/v1/public/future/spot-copy-trade/lead-portfolio/performance?portfolioId=4163883351504751104&timeRange=90D'
    )
    const result = expectProfileContractAttests({
      contract: BINANCE_SPOT_PROFILE_CAPTURE,
      timeframe: 90,
      pages,
      parseProfile: parseBinanceProfile,
      ctx: ctx('spot'),
      metrics: ['mdd'],
    })
    expect(result.manifest?.metrics.mdd?.value).toBe(13.201449)
    // The same 17.59 is returned for 7D/30D/90D: not a window value, so the
    // parser keeps it as lifetime_win_rate and leaves the window win rate empty.
    expect(result.parsed?.winRate).toBeNull()
    expect(result.parsed?.extras.lifetime_win_rate).toBe(17.59)
    expect(result.manifest?.metrics.win_rate).toBeUndefined()
  })

  it('binds the trader and window into the request projection', async () => {
    const run = async (trader: string, timeframe: RankingTimeframe, perf: string) =>
      runProfileContractFixture({
        contract: BINANCE_SPOT_PROFILE_CAPTURE,
        timeframe,
        pages: (await capture('spot', timeframe, fixture(perf), trader)).pages,
        parseProfile: parseBinanceProfile,
        ctx: ctx('spot'),
      }).manifest?.requests[0].request_projection_sha256
    const base = await run('4163883351504751104', 90, 'profile-performance-spot-90D.json')
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await run('3993275764606430465', 90, 'profile-performance-spot-90D.json')).not.toBe(base)
    expect(await run('4163883351504751104', 7, 'profile-performance-spot-7D.json')).not.toBe(base)
  })

  it('refuses a response for another window than the one requested', async () => {
    // 90D response served for a 30D request: no 30D block, nothing attested.
    const { pages } = await capture('futures', 30, fixture('profile-performance-futures-90D.json'))
    const result = runProfileContractFixture({
      contract: BINANCE_FUTURES_PROFILE_CAPTURE,
      timeframe: 30,
      pages,
      parseProfile: parseBinanceProfile,
      ctx: ctx('futures'),
    })
    expect([result.terminalState, result.reasonCode]).toEqual([
      'processing_failed',
      'stats_block_missing',
    ])
    expect(result.attestedMetrics).toEqual([])
  })

  it('refuses a capture without a performance block or from an overridden endpoint', async () => {
    const missing = await capture('futures', 90, { code: '000000', success: true, data: null })
    expect(
      runProfileContractFixture({
        contract: BINANCE_FUTURES_PROFILE_CAPTURE,
        timeframe: 90,
        pages: missing.pages,
        parseProfile: parseBinanceProfile,
        ctx: ctx('futures'),
      }).reasonCode
    ).toBe('stats_block_missing')

    const overridden = await capture(
      'futures',
      90,
      fixture('profile-performance-futures-90D.json'),
      '5076490769406674432',
      { endpoints: { performance: 'https://www.binance.com/bapi/futures/v2/performance' } }
    )
    const result = runProfileContractFixture({
      contract: BINANCE_FUTURES_PROFILE_CAPTURE,
      timeframe: 90,
      pages: overridden.pages,
      parseProfile: parseBinanceProfile,
      ctx: ctx('futures'),
    })
    expect([result.terminalState, result.reasonCode]).toEqual([
      'processing_failed',
      'undeclared_endpoint',
    ])
  })

  it('refuses a stored value the parser did not read from the declared field', async () => {
    const { pages } = await capture(
      'futures',
      90,
      fixture('profile-performance-futures-90D.json'),
      '5076490769406674432'
    )
    const result = runProfileContractFixture({
      contract: BINANCE_FUTURES_PROFILE_CAPTURE,
      timeframe: 90,
      pages,
      parseProfile: (payload, parseCtx) => {
        const profile = parseBinanceProfile(payload, parseCtx)
        return { ...profile, stats: profile.stats.map((s) => ({ ...s, mdd: 1 })) }
      },
      ctx: ctx('futures'),
    })
    expect(result.reasonCode).toBe('projection_mismatch')
  })
})
