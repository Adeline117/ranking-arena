import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParseCtx, SourceRow, Timeframe } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { bitgetBotsAdapter } from '../bots'

type BotPayload = {
  code: string
  data: {
    data: Array<Record<string, unknown>>
    nextFlag: boolean
    pageNo: number
    totalRecord: string
  }
  params: unknown[]
}

function fixture(): BotPayload {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'bots-board-futures-grid.json'), 'utf8')
  ) as BotPayload
}

function profileFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'bots-strategy-info.json'), 'utf8')
  ) as Record<string, unknown>
}

const profileCtx: ParseCtx = {
  sourceSlug: 'bitget_bots_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

function validateProfile(
  strategyInfo: Record<string, unknown>,
  requestedTimeframe: Timeframe = 30,
  payloadTimeframe: number = requestedTimeframe
) {
  const raw = { strategyInfo, timeframe: payloadTimeframe }
  const parsed = bitgetBotsAdapter.parseProfile(raw, profileCtx)
  return bitgetBotsAdapter.validateProfile?.(parsed, profileCtx, requestedTimeframe, raw) ?? []
}

function profileData(strategyInfo: Record<string, unknown>): Record<string, unknown> {
  return strategyInfo.data as Record<string, unknown>
}

function performances(strategyInfo: Record<string, unknown>): Array<Record<string, unknown>> {
  return profileData(strategyInfo).performances as Array<Record<string, unknown>>
}

function source(boards: string[] = ['futures_grid', 'futures_martingale']): SourceRow {
  return {
    id: 41,
    slug: 'bitget_bots_futures',
    exchange_id: 5,
    product_type: 'futures',
    trader_kind_scope: 'bot',
    adapter_slug: 'bitget_bots',
    leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/bot',
    timeframes_native: [30],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 180,
    deep_profile_topn: 200,
    positions_topn: 0,
    profile_cache_ttl: '1 hour',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '1 hour',
    cadence_tier_b: '6 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 0,
    phase: 0,
    serving_mode: 'serving',
    status: 'active',
    meta: { boards },
  }
}

function payload(input: {
  strategyType: 2 | 4
  pageNo?: number
  total: number
  rowCount: number
  nextFlag: boolean
}): BotPayload {
  const value = fixture()
  value.data.data = value.data.data.slice(0, input.rowCount).map((card, index) => ({
    ...card,
    strategyId: `${String(card.strategyId)}${input.strategyType}${input.pageNo ?? 1}${index}`,
    strategyType: input.strategyType,
  }))
  value.data.pageNo = input.pageNo ?? 1
  value.data.totalRecord = String(input.total)
  value.data.nextFlag = input.nextFlag
  return value
}

function session(
  respond: (request: ReplayRequestTemplate) => Promise<{ status: number; json: unknown }>
): FetchSession {
  const page = {
    goto: jest.fn(async () => undefined),
    waitForLoadState: jest.fn(async () => undefined),
  }
  return {
    sourceSlug: 'bitget_bots_futures',
    page: async () => page,
    pageFetch: respond,
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

async function collect(sessionValue: FetchSession, src = source()) {
  const pages = []
  for await (const page of bitgetBotsAdapter.listLeaderboard(sessionValue, src, 30)) {
    pages.push(page)
  }
  return pages
}

describe('Bitget bot partitioned legacy capture boundary', () => {
  it('keeps request-local page identity while assigning collision-free aggregate page indexes', async () => {
    const requests: ReplayRequestTemplate[] = []
    const pages = await collect(
      session(async (request) => {
        requests.push(request)
        const strategyType = (request.body as { strategyType: 2 | 4 }).strategyType
        return {
          status: 200,
          json: payload({ strategyType, total: 20, rowCount: 20, nextFlag: false }),
        }
      })
    )

    expect(requests.map((request) => request.body)).toEqual([
      { strategyType: 2, orderType: 3, pageNo: 1, pageSize: 20 },
      { strategyType: 4, orderType: 3, pageNo: 1, pageSize: 20 },
    ])
    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2])
    expect(
      pages.map((page) => {
        const wrapper = page.payload as Record<string, unknown>
        return [wrapper.board, wrapper.requestPageIndex, wrapper.requestPageSize]
      })
    ).toEqual([
      ['futures_grid', 1, 20],
      ['futures_martingale', 1, 20],
    ])
  })

  it('rejects totalRecord drift within one strategy partition', async () => {
    await expect(
      collect(
        session(async (request) => {
          const pageNo = (request.body as { pageNo: number }).pageNo
          return {
            status: 200,
            json:
              pageNo === 1
                ? payload({ strategyType: 2, total: 21, rowCount: 20, nextFlag: true })
                : payload({
                    strategyType: 2,
                    pageNo: 2,
                    total: 22,
                    rowCount: 2,
                    nextFlag: false,
                  }),
          }
        }),
        source(['futures_grid'])
      )
    ).rejects.toThrow('totalRecord changed within one crawl')
  })
})

describe('Bitget bot profile publication boundary', () => {
  it('accepts the reviewed 7D/30D/90D fixture for its exact requested window', () => {
    expect(validateProfile(profileFixture(), 30)).toEqual([])
  })

  it('rejects a missing requested performance window', () => {
    const raw = profileFixture()
    profileData(raw).performances = performances(raw).filter(
      (performance) => performance.performanceType !== 30
    )

    const [reject] = validateProfile(raw, 30)
    expect(reject.payload.blocking_reasons).toContain('profile_requested_timeframe_count_invalid')
  })

  it('rejects duplicate reviewed performance windows', () => {
    const raw = profileFixture()
    const requested = performances(raw).find((row) => row.performanceType === 30)
    if (!requested) throw new Error('fixture must contain the requested 30D performance')
    performances(raw).push({ ...requested })

    const [reject] = validateProfile(raw, 30)
    expect(reject.payload.blocking_reasons).toContain('profile_performance_type_duplicate')
    expect(reject.payload.blocking_reasons).toContain('profile_requested_timeframe_count_invalid')
  })

  it('rejects unreviewed and malformed performanceType values', () => {
    const unreviewed = profileFixture()
    performances(unreviewed).push({ ...performances(unreviewed)[0], performanceType: 14 })
    expect(validateProfile(unreviewed, 30)[0].payload.blocking_reasons).toContain(
      'profile_performance_type_unreviewed'
    )

    const malformed = profileFixture()
    performances(malformed)[0] = { ...performances(malformed)[0], performanceType: '7' }
    expect(validateProfile(malformed, 30)[0].payload.blocking_reasons).toContain(
      'profile_performance_type_malformed'
    )
  })

  it('rejects a payload captured for a different requested window', () => {
    const [reject] = validateProfile(profileFixture(), 30, 90)
    expect(reject.payload.blocking_reasons).toContain('profile_requested_timeframe_mismatch')
  })
})
