import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { LeaderboardCaptureUpstreamError } from '../../../fetch/capture'
import { okxWeb3Adapter } from '../index'

const WALLET = '3CkgBB2ryzxQuSmzPSQ53jtVffPf1Wb1t1HBVs8GmGfw'

function source(meta: Record<string, unknown> = {}): SourceRow {
  return {
    id: 28,
    slug: 'okx_web3_solana',
    exchange_id: 28,
    product_type: 'onchain',
    trader_kind_scope: 'human',
    adapter_slug: 'okx_web3',
    leaderboard_url: 'https://web3.okx.com/copy-trade/leaderboard/solana',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: { '7D': 7, '1M': 30, '3M': 90 },
    expected_count: 4_000,
    deep_profile_topn: 240,
    positions_topn: 0,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'none',
    currency: 'USDC',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 2_000,
    phase: 2,
    serving_mode: 'shadow',
    status: 'active',
    meta,
  }
}

function session(): FetchSession {
  return {
    sourceSlug: 'okx_web3_solana',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function row(index: number, periodType = '4', chainId: string | number = 501) {
  return {
    walletAddress: index === 0 ? WALLET : `${WALLET.slice(0, -2)}${String(index).padStart(2, '0')}`,
    periodType,
    chainId,
    roi: '10',
    pnl: '100',
    winRate: '50',
  }
}

function boardPayload(
  options: {
    rankStart?: number
    rankEnd?: number
    totalCount?: number
    rows?: unknown[]
    periodType?: string
    code?: number
  } = {}
) {
  const periodType = options.periodType ?? '4'
  return {
    code: options.code ?? 0,
    msg: '',
    data: {
      rankStart: options.rankStart ?? 0,
      rankEnd: options.rankEnd ?? 20,
      totalCount: options.totalCount ?? 1,
      rankingInfos: options.rows ?? [row(0, periodType)],
      rankingFilter: {
        periodType,
        chainId: '501',
        rankBy: '1',
        desc: 'true',
        label: '',
      },
    },
  }
}

function response(status: number, json: unknown): Response {
  return { status, json: async () => json } as Response
}

describe('OKX Web3 evidence-preserving leaderboard capture', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it.each([
    [7, '3'],
    [30, '4'],
    [90, '5'],
  ] as const)(
    'captures the exact raw %dD native-period response',
    async (timeframe, periodType) => {
      const payload = boardPayload({ periodType, rows: [row(0, periodType)] })
      global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch

      const capture = await okxWeb3Adapter.captureLeaderboard!(session(), source(), timeframe)

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const requestedUrl = String((global.fetch as jest.Mock).mock.calls[0][0])
      expect(requestedUrl).toContain(`rankStart=0&rankEnd=20&periodType=${periodType}`)
      expect(requestedUrl).toContain('rankBy=1&label=all&desc=true&chainId=501')
      expect(capture.terminationReason).toBe('reported_population_reached')
      expect(capture.sourcePages[0]).toMatchObject({
        sourceRowCount: 1,
        httpStatus: 200,
        rawPage: { payload },
        paginationPosition: { kind: 'page_index', request_page_index: 1 },
        sourceReports: {
          population: { state: 'reported', value: 1 },
          page_count: { state: 'not_reported' },
          current_page: { state: 'reported', value: 1 },
          page_size: { state: 'reported', value: 20 },
        },
      })
      expect(capture.sourcePages[0].requestSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  )

  it('binds adjacent 0-2 and 2-4 response windows without dropping the raw root', async () => {
    const pages = [
      boardPayload({ rankStart: 0, rankEnd: 2, totalCount: 3, rows: [row(0), row(1)] }),
      boardPayload({ rankStart: 2, rankEnd: 4, totalCount: 3, rows: [row(2)] }),
    ]
    let call = 0
    global.fetch = jest.fn(async () => response(200, pages[call++])) as unknown as typeof fetch

    const capture = await okxWeb3Adapter.captureLeaderboard!(
      session(),
      { ...source(), page_size: 2 },
      30
    )

    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.sourcePages.map((page) => page.rawPage.payload)).toEqual(pages)
    expect(capture.sourcePages.map((page) => page.rawPage.url)).toEqual([
      expect.stringContaining('rankStart=0&rankEnd=2'),
      expect.stringContaining('rankStart=2&rankEnd=4'),
    ])
    expect(capture.sourcePages.map((page) => page.sourceReports.current_page)).toEqual([
      { state: 'reported', value: 1 },
      { state: 'reported', value: 2 },
    ])
  })

  it('counts upstream rows before parser identity rejection', async () => {
    const payload = boardPayload({ rows: [{ ...row(0), walletAddress: 'short' }] })
    global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch

    const capture = await okxWeb3Adapter.captureLeaderboard!(session(), source(), 30)
    expect(capture.sourcePages[0].sourceRowCount).toBe(1)
    expect(
      okxWeb3Adapter.parseLeaderboard(capture.parsePages[0].payload, {
        sourceSlug: 'okx_web3_solana',
        currency: 'USDC',
        tfLabelMap: {},
        scrapedAt: '2026-07-24T12:00:00.000Z',
        meta: {},
      }).rows
    ).toHaveLength(0)
  })

  it('paces each HTTP request exactly once', async () => {
    const payload = boardPayload()
    const paced = jest.fn(async (fn: () => Promise<unknown>) => fn())
    const fetchSession = { ...session(), paced } as unknown as FetchSession
    global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch

    await okxWeb3Adapter.captureLeaderboard!(fetchSession, source(), 30)
    expect(paced).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy stream on the same exact-root capture path', async () => {
    const payload = boardPayload()
    global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch
    const pages = []
    for await (const page of okxWeb3Adapter.listLeaderboard(session(), source(), 30)) {
      pages.push(page)
    }

    expect(pages).toHaveLength(1)
    expect(pages[0].payload).toEqual(payload)
  })

  it('turns max_pages into an explicit caller limit', async () => {
    const payload = boardPayload({
      rankEnd: 2,
      totalCount: 4,
      rows: [row(0), row(1)],
    })
    global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch

    const capture = await okxWeb3Adapter.captureLeaderboard!(
      session(),
      { ...source({ max_pages: 1 }), page_size: 2 },
      30
    )
    expect(capture.terminationReason).toBe('caller_limit')
    expect(capture.captureConfig.caller_page_cap).toBe(1)
  })

  it('rejects unsafe source pagination and non-Solana configuration before fetch', async () => {
    const neverFetch = jest.fn(async () => response(200, boardPayload()))
    global.fetch = neverFetch as unknown as typeof fetch

    await expect(
      okxWeb3Adapter.captureLeaderboard!(session(), { ...source(), page_size: 21 }, 30)
    ).rejects.toThrow('page_size')
    for (const maxPages of [-0, 0, 1.5, '01', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        okxWeb3Adapter.captureLeaderboard!(session(), source({ max_pages: maxPages }), 30)
      ).rejects.toThrow('meta.max_pages')
    }
    await expect(
      okxWeb3Adapter.captureLeaderboard!(session(), source({ chain_id: '56' }), 30)
    ).rejects.toThrow('Solana 501')
    expect(neverFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['blocked', 403],
    ['server error', 500],
  ])('retains the exact %s HTTP response before failing', async (_label, status) => {
    const payload = { code: status, msg: 'upstream failure' }
    global.fetch = jest.fn(async () => response(status, payload)) as unknown as typeof fetch

    let captured: unknown
    try {
      await okxWeb3Adapter.captureLeaderboard!(session(), source(), 30)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(captured).toMatchObject({
      status,
      capture: {
        terminationReason: 'upstream_error',
        sourcePages: [{ httpStatus: status, rawPage: { payload } }],
      },
    })
  })

  it('keeps transport failures distinct from captured HTTP responses', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('socket closed')
    }) as unknown as typeof fetch

    await expect(okxWeb3Adapter.captureLeaderboard!(session(), source(), 30)).rejects.toMatchObject(
      {
        status: null,
        capture: { terminationReason: 'upstream_error', sourcePages: [] },
      }
    )
  })

  it('retains a non-JSON 200 as null before schema validation fails', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError('not JSON')
      },
    })) as unknown as typeof fetch

    await expect(okxWeb3Adapter.captureLeaderboard!(session(), source(), 30)).rejects.toMatchObject(
      {
        status: 200,
        capture: { sourcePages: [{ httpStatus: 200, rawPage: { payload: null } }] },
      }
    )
  })

  it.each([
    ['API code', () => boardPayload({ code: 1 })],
    [
      'missing rows',
      () => {
        const payload = boardPayload()
        ;(payload.data as Record<string, unknown>).rankingInfos = null
        return payload
      },
    ],
    ['response offset', () => boardPayload({ rankStart: 1, rankEnd: 21 })],
    ['response page size', () => boardPayload({ rankEnd: 19 })],
    ['undersized total', () => boardPayload({ totalCount: 0 })],
    [
      'filter drift',
      () => {
        const payload = boardPayload()
        payload.data.rankingFilter.periodType = '3'
        return payload
      },
    ],
    ['row drift', () => boardPayload({ rows: [row(0, '3')] })],
    [
      'too many rows',
      () => boardPayload({ rankEnd: 2, totalCount: 3, rows: [row(0), row(1), row(2)] }),
    ],
  ])('stores malformed 200 %s evidence and fails closed', async (_label, makePayload) => {
    const payload = makePayload()
    global.fetch = jest.fn(async () => response(200, payload)) as unknown as typeof fetch

    let captured: unknown
    try {
      await okxWeb3Adapter.captureLeaderboard!(
        session(),
        { ...source(), page_size: _label === 'too many rows' ? 2 : 20 },
        30
      )
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(captured).toMatchObject({
      status: 200,
      capture: {
        terminationReason: 'upstream_error',
        parsePages: [],
        sourcePages: [{ sourceRowCount: 0, httpStatus: 200, rawPage: { payload } }],
      },
    })
  })

  it('preserves conflicting live totalCount reports for later population quarantine', async () => {
    const pages = [
      boardPayload({ rankEnd: 2, totalCount: 3, rows: [row(0), row(1)] }),
      boardPayload({ rankStart: 2, rankEnd: 4, totalCount: 4, rows: [row(2)] }),
    ]
    let call = 0
    global.fetch = jest.fn(async () => response(200, pages[call++])) as unknown as typeof fetch

    const capture = await okxWeb3Adapter.captureLeaderboard!(
      session(),
      { ...source(), page_size: 2 },
      30
    )
    expect(capture.terminationReason).toBe('short_page')
    expect(capture.sourcePages.map((page) => page.sourceReports.population)).toEqual([
      { state: 'reported', value: 3 },
      { state: 'reported', value: 4 },
    ])
  })
})
