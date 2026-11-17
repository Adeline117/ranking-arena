import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  expectProfileContractAttests,
  runProfileContractFixture,
} from '../../../profile-capture/test-helper'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '../../../profile-capture/contract'
import { bybitCopytradeAdapter } from '../index'
import { parseBybitCopytradeProfile } from '../parsers'
import { BYBIT_COPYTRADE_PROFILE_CAPTURE } from '../profile-capture-contract'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

const MARK = 'S9LoGlRC6qFD5thjUyzWrQ=='
const CYCLE: Record<RankingTimeframe, string> = {
  7: 'DAY_CYCLE_TYPE_SEVEN_DAY',
  30: 'DAY_CYCLE_TYPE_THIRTY_DAY',
  90: 'DAY_CYCLE_TYPE_NINETY_DAY',
}

function chartUrl(timeframe: RankingTimeframe, mark = MARK): string {
  return (
    'https://www.bybit.com/x-api/fapi/beehive/public/v2/leader/dynamic-yield-trend' +
    `?dayCycleType=${CYCLE[timeframe]}&period=PERIOD_DAY&leaderMark=${encodeURIComponent(mark)}`
  )
}

/** The bundle page getProfile returns, built from the 2026-06-11 live capture. */
function bundlePage(timeframe: RankingTimeframe, mark = MARK): RawPage {
  return {
    pageIndex: 1,
    url: chartUrl(timeframe, mark),
    payload: {
      info: fixture('pub-leader-info.json'),
      income: fixture('leader-income.json'),
      yieldTrend: fixture(`yield-trend-${timeframe}.json`),
      timeframe,
    },
    fetchedAt: '2026-06-11T00:00:00.000Z',
  }
}

const run = (timeframe: RankingTimeframe, pages: RawPage[], exchangeTraderId = MARK) =>
  runProfileContractFixture({
    contract: BYBIT_COPYTRADE_PROFILE_CAPTURE,
    timeframe,
    pages,
    parseProfile: parseBybitCopytradeProfile,
    exchangeTraderId,
  })

const PREFIX: Record<RankingTimeframe, string> = { 7: 'sevenDay', 30: 'thirtyDay', 90: 'ninetyDay' }
const ATTESTED = ['mdd', 'pnl', 'roi', 'sharpe', 'sortino', 'win_rate'] as const
const FIELD = {
  roi: ['YieldRateE4', 1e2],
  pnl: ['ProfitE8', 1e8],
  win_rate: ['ProfitWinRateE4', 1e2],
  mdd: ['DrawDownE4', 1e2],
  sharpe: ['SharpeRatioE4', 1e4],
  sortino: ['SortinoRatioE4', 1e4],
} as const

describe('bybit_copytrade profile capture contract', () => {
  it('is the registered contract for the source', () => {
    expect(getProfileCaptureContract('bybit_copytrade')).toBe(BYBIT_COPYTRADE_PROFILE_CAPTURE)
    // The registration migration inserts this value; any contract change must
    // bump @n and register a new row.
    expect(profileCaptureContractSha256(BYBIT_COPYTRADE_PROFILE_CAPTURE)).toBe(
      'b9e04adab7fe2d1d31c54dadba418f71e56ba72a66c44abef8efd89bfa5bb212'
    )
  })

  it.each([
    [
      7,
      {
        pnl: -214.72556189,
        roi: -19.45,
        win_rate: 7.55,
        mdd: 17.71,
        sharpe: -2.4707,
        sortino: -1.5208,
      },
    ],
    [
      30,
      {
        pnl: -300.1281687,
        roi: -25.23,
        win_rate: 10.61,
        mdd: 23.02,
        sharpe: -0.7694,
        sortino: -1.1103,
      },
    ],
    [
      90,
      {
        pnl: -356.53843916,
        roi: -28.62,
        win_rate: 14.04,
        mdd: 59.37,
        sharpe: -0.4258,
        sortino: -0.6647,
      },
    ],
  ] as const)('%sd capture attests exactly the exchange window values', (timeframe, values) => {
    const result = expectProfileContractAttests({
      contract: BYBIT_COPYTRADE_PROFILE_CAPTURE,
      timeframe,
      pages: [bundlePage(timeframe)],
      parseProfile: parseBybitCopytradeProfile,
      exchangeTraderId: MARK,
      metrics: ATTESTED,
    })
    expect(result.stored).toMatchObject({
      pnl: values.pnl,
      roi: values.roi,
      winRate: values.win_rate,
      mdd: values.mdd,
      sharpe: values.sharpe,
      extras: expect.objectContaining({ sortino: values.sortino }),
    })
    const income = (fixture('leader-income.json') as { result: Record<string, string | number> })
      .result
    for (const metric of ATTESTED) {
      const key = `${PREFIX[timeframe]}${FIELD[metric][0]}`
      expect(result.manifest?.metrics[metric]).toEqual({
        endpoint: 'profile_bundle',
        path: ['income', 'result', key],
        raw_value: income[key],
        value: values[metric],
      })
      expect(Number(income[key]) / FIELD[metric][1]).toBe(values[metric])
    }
    expect(result.manifest).toMatchObject({
      exchange_trader_id: MARK,
      timeframe,
      capture_contract: 'bybit_copytrade-profile-capture@1',
    })
    // The parser's win+loss sum is never attested (not an exchange field).
    expect(result.stored?.totalPositions).not.toBeNull()
    expect(result.attestedMetrics).not.toContain('total_positions')
  })

  it('binds the request to the trader and the timeframe', () => {
    const own = run(90, [bundlePage(90)])
    const otherTrader = run(90, [bundlePage(90, 'fs0Hd+DcxxczT4zUzuV7zQ==')])
    const cacheBuster = run(90, [{ ...bundlePage(90), url: `${chartUrl(90)}&_=1` }])
    const projection = (r: typeof own) => r.manifest?.requests[0].request_projection_sha256
    expect(projection(otherTrader)).not.toBe(projection(own))
    expect(projection(cacheBuster)).toBe(projection(own))
    expect(own.sourceRunId).not.toBe(otherTrader.sourceRunId)
  })

  it('a bundle of another timeframe attests nothing', () => {
    const result = run(30, [bundlePage(7)])
    expect(result.terminalState).toBe('processing_failed')
    expect(result.reasonCode).toBe('stats_block_missing')
    expect(result.attestedMetrics).toEqual([])
  })

  it('an incomplete capture attests nothing', () => {
    expect(run(90, [])).toMatchObject({ terminalState: 'partial', reasonCode: 'endpoint_missing' })
    const twice = run(90, [bundlePage(90), bundlePage(90)])
    expect(twice).toMatchObject({
      terminalState: 'processing_failed',
      reasonCode: 'duplicate_endpoint_page',
    })
    // A page from an overridden (undeclared) chart endpoint is not evidence.
    const moved = run(90, [
      { ...bundlePage(90), url: chartUrl(90).replace('/v2/leader/', '/v3/leader/') },
    ])
    expect(moved).toMatchObject({
      terminalState: 'processing_failed',
      reasonCode: 'undeclared_endpoint',
    })
  })

  it('a window without the exchange PnL is honest absence, not a borrowed value', () => {
    const page = bundlePage(30)
    const payload = page.payload as { income: { result: Record<string, unknown> } }
    delete payload.income.result.thirtyDayProfitE8
    const result = run(30, [page])
    expect(result.terminalState).toBe('complete')
    expect(result.stored?.pnl).toBeNull()
    expect(result.attestedMetrics).toEqual(['mdd', 'roi', 'sharpe', 'sortino', 'win_rate'])
  })

  it('a parser value that the declared field does not supply fails the capture', () => {
    const result = runProfileContractFixture({
      contract: BYBIT_COPYTRADE_PROFILE_CAPTURE,
      timeframe: 7,
      pages: [bundlePage(7)],
      parseProfile: (payload, ctx) => {
        const profile = parseBybitCopytradeProfile(payload, ctx)
        return { ...profile, stats: profile.stats.map((s) => ({ ...s, pnl: (s.pnl ?? 0) + 1 })) }
      },
    })
    expect(result).toMatchObject({
      terminalState: 'processing_failed',
      reasonCode: 'projection_mismatch',
    })
  })
})

describe('bybit_copytrade getProfile surface', () => {
  function fakeSession(requests: string[]): FetchSession {
    const respond = (url: string): unknown => {
      if (url.includes('/pub-leader/info')) return fixture('pub-leader-info.json')
      if (url.includes('/leader-income')) return fixture('leader-income.json')
      const tf = url.includes('SEVEN') ? 7 : url.includes('THIRTY') ? 30 : 90
      return fixture(`yield-trend-${tf}.json`)
    }
    const page = {
      goto: async () => null,
      waitForLoadState: async () => undefined,
    }
    return {
      sourceSlug: 'bybit_copytrade',
      page: async () => page as never,
      api: async () => {
        throw new Error('not used')
      },
      pageFetch: async (template) => {
        requests.push(template.url)
        return { status: 200, json: respond(template.url) }
      },
      capture: async () => {
        throw new Error('not used')
      },
      paced: (fn) => fn(),
      saveState: async () => undefined,
      close: async () => undefined,
    }
  }

  const src = { slug: 'bybit_copytrade', meta: {}, leaderboard_url: null } as unknown as SourceRow

  it('every timeframe page passes the contract with an income response of its own call', async () => {
    const requests: string[] = []
    const session = fakeSession(requests)
    for (const timeframe of [7, 30, 90] as const) {
      const bundle = await bybitCopytradeAdapter.getProfile!(session, src, MARK, timeframe)
      expect(bundle.pages.map((page) => page.url)).toEqual([chartUrl(timeframe)])
      expectProfileContractAttests({
        contract: BYBIT_COPYTRADE_PROFILE_CAPTURE,
        timeframe,
        pages: bundle.pages,
        parseProfile: parseBybitCopytradeProfile,
        exchangeTraderId: MARK,
        metrics: ATTESTED,
      })
    }
    // Attested leader-income is fetched once per attempt; info stays cached.
    expect(requests.filter((url) => url.includes('/leader-income'))).toHaveLength(3)
    expect(requests.filter((url) => url.includes('/pub-leader/info'))).toHaveLength(1)
  })
})
