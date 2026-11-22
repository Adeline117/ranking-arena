/**
 * bitget_cfd profile capture contract against recorded public responses
 * (mt5/public/details + performance of one CFD portfolio, 7/30/90, probed
 * 2026-11-20; identity fields replaced, metric values untouched). The real
 * getProfile builds the page; the real parser and the worker's capture path
 * decide what is attested.
 *
 * The spot fixture (spot/public/uta/details + performance, same probe) records
 * why bitget_spot has no contract: the response has no drawdown field.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, RawPage, SourceRow } from '../../../core/types'
import { UpstreamGoneError } from '../../../fetch/capture'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '../../../profile-capture/contract'
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '../../../profile-capture/test-helper'
import { bitgetAdapter } from '../index'
import { parseBitgetProfile } from '../parsers'
import { BITGET_CFD_PROFILE_CAPTURE } from '../profile-capture-contract'

type Json = Record<string, unknown>
type Envelopes = { details: Json; performance: Json }

const TRADER = 'b0c00000000000000015'
const PORTFOLIO = '1400000000000000015'
const DETAILS_URL = 'https://www.bitget.com/v1/trace/mt5/public/details'
const PERFORMANCE_URL = 'https://www.bitget.com/v1/trace/mt5/public/performance'

function envelopes(name: string): Envelopes {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')) as Envelopes
}
const cfd = (timeframe: RankingTimeframe) => envelopes(`cfd-profile-capture-${timeframe}`)

const source: SourceRow = {
  id: 6,
  slug: 'bitget_cfd',
  exchange_id: 4,
  product_type: 'cfd',
  trader_kind_scope: 'human',
  adapter_slug: 'bitget',
  leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/cfd',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 300,
  positions_topn: 100,
  profile_cache_ttl: '6 hours',
  copier_table_depth: 'top50',
  currency: 'USDT',
  page_size: 50,
  pagination_kind: 'numeric',
  cadence_tier_a: '4 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 2_500,
  phase: 3,
  serving_mode: 'serving',
  status: 'active',
  meta: { boardKey: 'cfd' },
}

/** Real getProfile, upstream answered by the recorded envelopes. */
async function capture(
  timeframe: RankingTimeframe,
  served: Envelopes = cfd(timeframe),
  options: { trader?: string; meta?: Json | null } = {}
): Promise<{ pages: RawPage[]; requests: ReplayRequestTemplate[] }> {
  const requests: ReplayRequestTemplate[] = []
  // A fresh session per capture: details is memoized per session.
  const session = {
    sourceSlug: source.slug,
    page: async () => ({ goto: async () => null, waitForLoadState: async () => null }),
    pageFetch: async (template: ReplayRequestTemplate) => {
      requests.push(template)
      const body = template.url === DETAILS_URL ? served.details : served.performance
      return { status: 200, json: JSON.parse(JSON.stringify(body)) }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  const bundle = await bitgetAdapter.getProfile(
    session,
    source,
    options.trader ?? TRADER,
    timeframe,
    options.meta === undefined ? { portfolio_id: PORTFOLIO, bitget_trader_type: 1 } : options.meta,
    { intent: 'scheduled_full' }
  )
  return { pages: bundle.pages, requests }
}

const ctx = { sourceSlug: 'bitget_cfd' }
const run = (pages: readonly RawPage[], timeframe: RankingTimeframe = 30) =>
  runProfileContractFixture({
    contract: BITGET_CFD_PROFILE_CAPTURE,
    timeframe,
    pages,
    parseProfile: parseBitgetProfile,
    ctx,
  })

describe('bitget_cfd profile capture contract', () => {
  it('is the declared contract of the source; bitget_spot declares none', () => {
    expect(getProfileCaptureContract('bitget_cfd')).toBe(BITGET_CFD_PROFILE_CAPTURE)
    // Pinned: any contract change must bump @n and register a new hash.
    expect(profileCaptureContractSha256(BITGET_CFD_PROFILE_CAPTURE)).toBe(
      '7ddc65e64c24019f5f6c29074f1a5495865f2b66fa884c6123fdf824adebff18'
    )
    expect(getProfileCaptureContract('bitget_spot')).toBeNull()
  })

  it.each([
    [7, { mdd: ['0.0000', 0], roi: ['214.99', 214.99], pnl: ['256.04', 256.04] }, 203, 66],
    [30, { mdd: ['0.2456', 24.56], roi: ['457.97', 457.97], pnl: ['680.13', 680.13] }, 555, 67.02],
    [90, { mdd: ['0.0507', 5.07], roi: ['909.98', 909.98], pnl: ['1107.80', 1107.8] }, 661, 69.89],
  ] as const)(
    '%sd: attests the performance block of the real request',
    async (tf, text, trades, winRate) => {
      const { pages, requests } = await capture(tf)
      // One details request, then the window's performance request: one
      // request returns one window.
      expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
        { url: DETAILS_URL, method: 'POST', body: { portfolioId: PORTFOLIO } },
        { url: PERFORMANCE_URL, method: 'POST', body: { portfolioId: PORTFOLIO, cycleTime: tf } },
      ])
      expect(pages).toHaveLength(1)
      expect(pages[0].url).toBe(`${PERFORMANCE_URL}?portfolioId=${PORTFOLIO}&cycleTime=${tf}`)

      const result = expectProfileContractAttests({
        contract: BITGET_CFD_PROFILE_CAPTURE,
        timeframe: tf,
        pages,
        parseProfile: parseBitgetProfile,
        ctx,
        exchangeTraderId: TRADER,
        metrics: ['mdd', 'pnl', 'roi', 'total_positions', 'win_rate'],
      })
      const field = (name: string, raw: number | string, value: number) => ({
        endpoint: 'performance',
        path: ['cfdPerformance', 'data', name],
        raw_value: raw,
        value: expect.closeTo(value, 9),
      })
      expect(result.manifest?.metrics).toEqual({
        mdd: field('maxDrawDown', text.mdd[0], text.mdd[1]),
        pnl: field('profit', text.pnl[0], text.pnl[1]),
        roi: field('roi', text.roi[0], text.roi[1]),
        total_positions: field('totalTrades', trades, trades),
        win_rate: field('winRate', (winRate / 100).toFixed(4), winRate),
      })
    }
  )

  it('parses the window block and identity from the recorded responses', async () => {
    const { pages } = await capture(30)
    const profile = parseBitgetProfile(pages[0].payload, {
      sourceSlug: 'bitget_cfd',
      currency: 'USDT',
      tfLabelMap: {},
      scrapedAt: '2026-11-20T00:00:00.000Z',
      meta: {},
    })
    expect(profile.nickname).toBe('Fixture CFD')
    expect(profile.series).toEqual([])
    expect(profile.stats).toHaveLength(1)
    expect(profile.stats[0]).toMatchObject({
      timeframe: 30,
      asOf: '2026-11-20T00:00:00.000Z',
      roi: 457.97,
      pnl: 680.13,
      sharpe: null,
      winPositions: 372,
      totalPositions: 555,
      copierPnl: 680.44,
      copierCount: 8,
      aum: 1920.52,
      profitShareRate: 20,
    })
    expect(profile.stats[0].mdd).toBeCloseTo(24.56, 9)
    expect(profile.stats[0].winRate).toBeCloseTo(67.02, 9)
    expect(profile.stats[0].extras).toMatchObject({
      trading_days: 37,
      copier_count_current: 8,
      copier_count_max: 100,
      total_equity: 457.2,
      loss_trades: 183,
      avg_profit: 8.47,
      avg_loss: -13.52,
      style_labels: ['超短线'],
    })
  })

  it('binds the portfolio and the window into the request projection', async () => {
    const projection = async (tf: RankingTimeframe, portfolio = PORTFOLIO) =>
      run((await capture(tf, cfd(tf), { meta: { portfolio_id: portfolio } })).pages, tf).manifest
        ?.requests[0].request_projection_sha256
    const base = await projection(30)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await projection(90)).not.toBe(base)
    // Another portfolio of the same trader (details echoes the trader).
    expect(await projection(30, '1400000000000000016')).not.toBe(base)
  })

  it('refuses a portfolio that belongs to another trader', async () => {
    await expect(capture(30, cfd(30), { trader: 'b0c00000000000000099' })).rejects.toThrow(
      /belongs to b0c00000000000000015, not b0c00000000000000099/
    )
  })

  it('refuses a trader without a portfolio id', async () => {
    await expect(capture(30, cfd(30), { meta: null })).rejects.toThrow(/no portfolio_id/)
  })

  it('fails the fetch on a business-error envelope instead of parsing an empty profile', async () => {
    const served = cfd(30)
    // Recorded shape of an unknown or closed portfolio (probe 2026-11-20).
    const closed = {
      code: 'portfolio_already_closed',
      flag: true,
      group: 'uta_support',
      msg: '项目不存在或已关闭',
      params: [null],
    }
    await expect(capture(30, { ...served, details: closed })).rejects.toBeInstanceOf(
      UpstreamGoneError
    )
    await expect(
      capture(30, {
        ...served,
        performance: { code: '00005', group: 'common_token', msg: 'Token不存在' },
      })
    ).rejects.toThrow(/CFD performance returned a non-success API envelope \(code=00005\)/)
  })

  it('a response without a drawdown attests no drawdown', async () => {
    // Recorded shape performance answers for a portfolio it has no data for.
    const served = cfd(30)
    const { pages } = await capture(30, {
      ...served,
      performance: {
        code: '200',
        data: {
          bv: false,
          followProfit: '0',
          lastOrderTime: null,
          profit: '0',
          roi: '0',
          winRate: '0',
        },
        params: [],
      },
    })
    const result = run(pages)
    expect(result.terminalState).toBe('complete')
    expect(result.attestedMetrics).toEqual(['pnl', 'roi', 'win_rate'])
    expect(result.parsed?.mdd).toBeNull()
  })

  it('keeps the win rate of a window without trades NULL', async () => {
    const served = cfd(7)
    const data = (served.performance as { data: Json }).data
    const { pages } = await capture(7, {
      ...served,
      performance: {
        ...served.performance,
        data: { ...data, totalTrades: 0, profitTrades: 0, lossTrades: 0, winRate: '0.0000' },
      },
    })
    const result = run(pages, 7)
    expect(result.parsed?.winRate).toBeNull()
    expect(result.attestedMetrics).toEqual(['mdd', 'pnl', 'roi', 'total_positions'])
  })

  it('does not attest a drawdown above 100 % (staging nulls it)', async () => {
    // Recorded 2026-11-21: a 90D response reported maxDrawDown "1.3254".
    const served = cfd(90)
    const data = (served.performance as { data: Json }).data
    const { pages } = await capture(90, {
      ...served,
      performance: { ...served.performance, data: { ...data, maxDrawDown: '1.3254' } },
    })
    const result = run(pages, 90)
    expect(result.terminalState).toBe('complete')
    expect(result.parsed?.mdd).toBeCloseTo(132.54, 9)
    expect(result.stored?.mdd).toBeNull()
    expect(result.attestedMetrics).toEqual(['pnl', 'roi', 'total_positions', 'win_rate'])
  })

  it('an incomplete capture attests nothing', () => {
    expect([run([]).terminalState, run([]).reasonCode]).toEqual(['partial', 'endpoint_missing'])
  })

  it('refuses a stored drawdown the parser did not read from the declared field', async () => {
    const { pages } = await capture(90)
    const result = runProfileContractFixture({
      contract: BITGET_CFD_PROFILE_CAPTURE,
      timeframe: 90,
      pages,
      parseProfile: (payload, parseCtx) => {
        const profile = parseBitgetProfile(payload, parseCtx)
        return { ...profile, stats: profile.stats.map((s) => ({ ...s, mdd: 5 })) }
      },
      ctx,
    })
    expect(result.reasonCode).toBe('projection_mismatch')
  })
})

describe('bitget_spot profile surface (recorded 2026-11-20)', () => {
  it('has no drawdown field, so no contract can attest one', () => {
    const { performance } = envelopes('spot-profile-capture-30')
    const data = (performance as { data: Json }).data
    expect(performance.code).toBe('200')
    expect(Object.keys(data).sort()).toEqual([
      'followProfit',
      'lastOrderTime',
      'profit',
      'profitTrades',
      'roi',
      'totalEquity',
      'totalTrades',
      'winRate',
    ])
  })
})
