import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParseCtx, SourceRow, Timeframe } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT } from '../../../acquisition-manifest'
import {
  bitgetBotsAdapter,
  captureBitgetBotsLeaderboard,
  projectBitgetBotsLeaderboardRequest,
} from '../bots'

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

function spotSource(boards: string[] = ['spot_grid', 'spot_martingale']): SourceRow {
  return {
    ...source(),
    slug: 'bitget_bots_spot',
    product_type: 'spot',
    meta: { boards },
  }
}

function payload(input: {
  strategyType: 1 | 2 | 3 | 4
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

describe('Bitget bot V4 adapter activation', () => {
  it('binds the exact V4 capture hook and canonical ordered partitions', () => {
    expect(bitgetBotsAdapter.leaderboardAcquisitionContract).toBe(
      LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT
    )
    expect(bitgetBotsAdapter.captureLeaderboard).toBe(captureBitgetBotsLeaderboard)
    expect(bitgetBotsAdapter.leaderboardPartitionIds?.(source(), 30)).toEqual([
      'futures_grid',
      'futures_martingale',
    ])
    expect(bitgetBotsAdapter.leaderboardPartitionIds?.(spotSource(), 30)).toEqual([
      'spot_grid',
      'spot_martingale',
    ])
  })

  it('uses the V4 capture hook without entering the legacy list stream', async () => {
    const legacyList = jest.spyOn(bitgetBotsAdapter, 'listLeaderboard')
    try {
      const capture = await bitgetBotsAdapter.captureLeaderboard?.(
        session(async (request) => {
          const strategyType = (request.body as { strategyType: 2 | 4 }).strategyType
          return {
            status: 200,
            json: payload({ strategyType, total: 1, rowCount: 1, nextFlag: false }),
          }
        }),
        source(),
        30
      )

      expect(legacyList).not.toHaveBeenCalled()
      expect(capture?.paginationTopology.expected_partition_ids).toEqual([
        'futures_grid',
        'futures_martingale',
      ])
      expect(capture?.sourcePages).toHaveLength(2)
    } finally {
      legacyList.mockRestore()
    }
  })
})

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

describe('Bitget bot V4 partitioned capture boundary', () => {
  it('captures exact upstream payloads with global storage and partition-local request indexes', async () => {
    const requests: ReplayRequestTemplate[] = []
    const capture = await captureBitgetBotsLeaderboard(
      session(async (request) => {
        requests.push(request)
        const body = request.body as { strategyType: 2 | 4; pageNo: number }
        if (body.strategyType === 2) {
          return {
            status: 200,
            json:
              body.pageNo === 1
                ? payload({ strategyType: 2, total: 21, rowCount: 20, nextFlag: true })
                : payload({
                    strategyType: 2,
                    pageNo: 2,
                    total: 21,
                    rowCount: 1,
                    nextFlag: false,
                  }),
          }
        }
        return {
          status: 200,
          json: payload({ strategyType: 4, total: 3, rowCount: 3, nextFlag: false }),
        }
      }),
      source(),
      30
    )

    expect(requests.map((request) => request.body)).toEqual([
      { strategyType: 2, orderType: 3, pageNo: 1, pageSize: 20 },
      { strategyType: 2, orderType: 3, pageNo: 2, pageSize: 20 },
      { strategyType: 4, orderType: 3, pageNo: 1, pageSize: 20 },
    ])
    expect(capture.sourcePages.map((page) => page.rawPage.pageIndex)).toEqual([1, 2, 3])
    expect(
      capture.sourcePages.map((page) => [
        page.paginationPosition.partition_id,
        page.paginationPosition.request_page_index,
      ])
    ).toEqual([
      ['futures_grid', 1],
      ['futures_grid', 2],
      ['futures_martingale', 1],
    ])
    expect(capture.sourcePages[0].rawPage.payload).toEqual(
      payload({ strategyType: 2, total: 21, rowCount: 20, nextFlag: true })
    )
    expect(capture.sourcePages[0].rawPage.payload).not.toHaveProperty('partition_id')
    expect(capture.parsePages[0].payload).toMatchObject({
      data_contract: 'arena.ingest.partitioned-numeric-parser-page@1',
      partition_id: 'futures_grid',
      request_page_index: 1,
      request_page_size: 20,
      payload: capture.sourcePages[0].rawPage.payload,
    })
    expect(capture.paginationTopology.partitions).toMatchObject([
      {
        partition_id: 'futures_grid',
        source_page_ordinals: [1, 2],
        parser_page_ordinals: [1, 2],
      },
      {
        partition_id: 'futures_martingale',
        source_page_ordinals: [3],
        parser_page_ordinals: [3],
      },
    ])
    expect(
      capture.parsePages.flatMap(
        (page) => bitgetBotsAdapter.parseLeaderboard(page.payload, profileCtx).rows
      )
    ).toHaveLength(24)
  })

  it('uses the canonical spot partition order and strategy identities', async () => {
    const requests: ReplayRequestTemplate[] = []
    const capture = await captureBitgetBotsLeaderboard(
      session(async (request) => {
        requests.push(request)
        const strategyType = (request.body as { strategyType: 1 | 3 }).strategyType
        return {
          status: 200,
          json: payload({ strategyType, total: 1, rowCount: 1, nextFlag: false }),
        }
      }),
      spotSource(),
      30
    )

    expect(requests.map((request) => request.body)).toEqual([
      { strategyType: 1, orderType: 3, pageNo: 1, pageSize: 20 },
      { strategyType: 3, orderType: 3, pageNo: 1, pageSize: 20 },
    ])
    expect(capture.paginationTopology.expected_partition_ids).toEqual([
      'spot_grid',
      'spot_martingale',
    ])
    expect(capture.parserTransformation.page_bindings).toMatchObject([
      { partition_id: 'spot_grid', request_page_index: 1 },
      { partition_id: 'spot_martingale', request_page_index: 1 },
    ])
  })

  it('fails closed when the actual Bitget request drifts outside four reviewed fields', () => {
    const expected = {
      url: 'https://www.bitget.com/v1/strategyPlatform/public/traceRanks',
      strategyType: 2,
      pageIndex: 1,
      pageSize: 20,
    }
    const request: ReplayRequestTemplate = {
      url: expected.url,
      method: 'POST',
      headers: { authorization: 'never-persisted' },
      body: { strategyType: 2, orderType: 3, pageNo: 1, pageSize: 20 },
    }
    expect(projectBitgetBotsLeaderboardRequest(request, expected)).toEqual({
      url: expected.url,
      method: 'POST',
      body: request.body,
    })

    const invalidRequests: ReplayRequestTemplate[] = [
      { ...request, method: 'GET' },
      { ...request, url: `${expected.url}?hidden=semantic-drift` },
      { ...request, body: { strategyType: 2, orderType: 3, pageNo: 1 } },
      { ...request, body: { ...(request.body as object), extra: true } },
      { ...request, body: { ...(request.body as object), strategyType: 4 } },
      { ...request, body: { ...(request.body as object), orderType: 2 } },
      { ...request, body: { ...(request.body as object), pageNo: '1' } },
      { ...request, body: { ...(request.body as object), pageSize: 21 } },
    ]
    for (const invalid of invalidRequests) {
      expect(() => projectBitgetBotsLeaderboardRequest(invalid, expected)).toThrow()
    }
  })

  it('rejects every source-contract drift before warmup or replay I/O', async () => {
    const goto = jest.fn(async () => undefined)
    const pageFetch = jest.fn(async () => ({ status: 200, json: {} }))
    const noNetworkSession = {
      sourceSlug: 'bitget_bots_futures',
      page: async () => ({
        goto,
        waitForLoadState: jest.fn(async () => undefined),
      }),
      pageFetch,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as unknown as FetchSession
    const canonical = source()
    const invalidSources: SourceRow[] = [
      { ...canonical, slug: 'bitget_bots_unknown' },
      { ...canonical, adapter_slug: 'bitget' },
      { ...canonical, product_type: 'spot' },
      { ...canonical, page_size: 21 },
      { ...canonical, pagination_kind: 'api_cursor' },
      { ...canonical, timeframes_native: [7, 30] },
      { ...canonical, timeframes_derived: [7] },
      { ...canonical, status: 'disabled' },
      { ...canonical, meta: { boards: ['futures_martingale', 'futures_grid'] } },
      { ...spotSource(), meta: { boards: ['spot_martingale', 'spot_grid'] } },
      {
        ...canonical,
        meta: {
          boards: ['futures_grid', 'futures_martingale'],
          endpoints: { list: 'https://unreviewed.test/traceRanks' },
        },
      },
    ] as SourceRow[]

    for (const invalid of invalidSources) {
      await expect(
        bitgetBotsAdapter.captureLeaderboard!(noNetworkSession, invalid, 30)
      ).rejects.toThrow('leaderboard publication contract failed')
    }
    await expect(
      bitgetBotsAdapter.captureLeaderboard!(noNetworkSession, canonical, 7 as never)
    ).rejects.toThrow('leaderboard publication contract failed')
    expect(goto).not.toHaveBeenCalled()
    expect(pageFetch).not.toHaveBeenCalled()
  })

  it('rejects partition report drift and invalid source configuration before publication', async () => {
    await expect(
      captureBitgetBotsLeaderboard(
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
        source(),
        30
      )
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('totalRecord changed') }),
    })

    const request = jest.fn(async () => ({ status: 200, json: {} }))
    await expect(
      captureBitgetBotsLeaderboard(session(request), source(['futures_martingale']), 30)
    ).rejects.toThrow('source.meta.boards')
    expect(request).not.toHaveBeenCalled()
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
