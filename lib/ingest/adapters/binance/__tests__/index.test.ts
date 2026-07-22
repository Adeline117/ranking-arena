import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  buildLeaderboardAcquisitionManifestV3,
} from '../../../acquisition-manifest'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { LeaderboardCaptureUpstreamError } from '../../../fetch/capture'
import { assessLeaderboardNativeWindowRequest } from '../../../leaderboard-request-evidence'
import { binanceAdapter, projectBinanceLeaderboardRequest } from '../index'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >
}

function source(meta: Record<string, unknown> = {}): SourceRow {
  return {
    id: 1,
    slug: 'binance_futures',
    exchange_id: 1,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'binance',
    leaderboard_url: 'https://www.binance.com/en/copy-trading',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 9_806,
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
    serving_mode: 'shadow',
    status: 'active',
    meta: { boardKey: 'futures', ...meta },
  }
}

function session(
  respond: (request: ReplayRequestTemplate) => Promise<{ status: number; json: unknown }>
): { session: FetchSession; page: { goto: jest.Mock; waitForLoadState: jest.Mock } } {
  const page = {
    goto: jest.fn(async () => undefined),
    waitForLoadState: jest.fn(async () => undefined),
  }
  return {
    page,
    session: {
      sourceSlug: 'binance_futures',
      page: async () => page,
      pageFetch: respond,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as unknown as FetchSession,
  }
}

function withRows(
  name: string,
  rows: unknown[],
  total: unknown = rows.length
): Record<string, unknown> {
  const payload = fixture(name)
  const data = payload.data as Record<string, unknown>
  data.list = rows
  data.total = total
  return payload
}

describe('Binance evidence-preserving leaderboard capture', () => {
  it.each([
    ['leaderboard-p1.json', 'futures', 9_806],
    ['spot-leaderboard-p1.json', 'spot', 2_509],
  ] as const)(
    'reads exact raw population semantics from %s',
    async (fixtureName, boardKey, expectedTotal) => {
      const first = fixture(fixtureName)
      const terminal = fixture(fixtureName)
      ;(terminal.data as Record<string, unknown>).list = []
      let requestCount = 0
      const fetchSession = session(async () => ({
        status: 200,
        json: requestCount++ === 0 ? first : terminal,
      })).session

      const capture = await binanceAdapter.captureLeaderboard!(
        fetchSession,
        source({ boardKey }),
        30
      )

      expect(capture.terminationReason).toBe('empty_page')
      expect(capture.sourcePages[0].sourceRowCount).toBe(20)
      expect(capture.sourcePages[0].sourceReports).toEqual({
        population: { state: 'reported', value: expectedTotal },
        page_count: { state: 'not_reported' },
        current_page: { state: 'not_reported' },
        page_size: { state: 'not_reported' },
      })
      expect(capture.parsePages).toHaveLength(1)
    }
  )

  it('uses the upstream list length before parser ID rejection', async () => {
    const original = fixture('leaderboard-p1.json')
    const fixtureRows = (original.data as { list: Array<Record<string, unknown>> }).list
    const valid = { ...fixtureRows[0] }
    const missingIdentity = { ...fixtureRows[1] }
    delete missingIdentity.leadPortfolioId
    const payload = withRows('leaderboard-p1.json', [valid, missingIdentity])
    const { session: fetchSession } = session(async () => ({ status: 200, json: payload }))

    const capture = await binanceAdapter.captureLeaderboard!(
      fetchSession,
      { ...source(), page_size: 20 },
      30
    )

    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.sourcePages[0].sourceRowCount).toBe(2)
    expect(capture.sourcePages[0].sourceReports).toEqual({
      population: { state: 'reported', value: 2 },
      page_count: { state: 'not_reported' },
      current_page: { state: 'not_reported' },
      page_size: { state: 'not_reported' },
    })
    expect(
      binanceAdapter.parseLeaderboard(capture.parsePages[0].payload, {
        sourceSlug: 'binance_futures',
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: '2026-07-21T12:00:00.000Z',
        meta: {},
      }).rows
    ).toHaveLength(1)
  })

  it('turns max_pages into an explicit caller limit instead of a silent return', async () => {
    const original = fixture('leaderboard-p1.json')
    const rows = (original.data as { list: Array<Record<string, unknown>> }).list.slice(0, 2)
    const payload = withRows('leaderboard-p1.json', rows, 4)
    const { session: fetchSession } = session(async () => ({ status: 200, json: payload }))

    const capture = await binanceAdapter.captureLeaderboard!(
      fetchSession,
      { ...source({ max_pages: 1 }), page_size: 2 },
      30
    )

    expect(capture.terminationReason).toBe('caller_limit')
    expect(capture.captureConfig.caller_page_cap).toBe(1)
    expect(capture.sourcePages).toHaveLength(1)
  })

  it('keeps a missing total explicitly not_reported and binds the requested window', async () => {
    const original = fixture('leaderboard-p1.json')
    const rows = (original.data as { list: Array<Record<string, unknown>> }).list.slice(0, 1)
    const payload = withRows('leaderboard-p1.json', rows)
    delete (payload.data as Record<string, unknown>).total

    const seven = await binanceAdapter.captureLeaderboard!(
      session(async () => ({ status: 200, json: payload })).session,
      source(),
      7
    )
    const thirty = await binanceAdapter.captureLeaderboard!(
      session(async () => ({ status: 200, json: payload })).session,
      source(),
      30
    )

    expect(seven.terminationReason).toBe('short_page')
    expect(seven.sourcePages[0].sourceReports.population).toEqual({ state: 'not_reported' })
    expect(seven.sourcePages[0].requestSha256).not.toBe(thirty.sourcePages[0].requestSha256)
  })

  it('round-trips a real adapter capture into the reviewed v3 window contract', async () => {
    const sourceRow = source()
    const original = fixture('leaderboard-p1.json')
    const payload = withRows(
      'leaderboard-p1.json',
      [(original.data as { list: Array<Record<string, unknown>> }).list[0]],
      1
    )
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    const capture = await binanceAdapter.captureLeaderboard!(
      session(async () => ({ status: 200, json: payload })).session,
      sourceRow,
      30
    )
    const completedAt = new Date(Date.now() + 1_000).toISOString()
    const parsed = binanceAdapter.parseLeaderboard(capture.parsePages[0].payload, {
      sourceSlug: sourceRow.slug,
      currency: sourceRow.currency,
      tfLabelMap: sourceRow.tf_label_map,
      scrapedAt: completedAt,
      meta: sourceRow.meta,
    })
    const built = buildLeaderboardAcquisitionManifestV3({
      source: {
        id: sourceRow.id,
        slug: sourceRow.slug,
        adapter_slug: sourceRow.adapter_slug,
        configured_page_size: sourceRow.page_size,
        configured_pagination_kind: sourceRow.pagination_kind,
      },
      surface: 'tier_a_leaderboard',
      timeframe: 30,
      started_at: startedAt,
      completed_at: completedAt,
      runner_git_sha: 'a'.repeat(40),
      observation_cycle_id: 'tier-a:binance_futures:adapter-round-trip',
      capture_evidence_state: 'verified',
      termination_reason: capture.terminationReason,
      capture_config: capture.captureConfig,
      source_pages: capture.sourcePages.map((page) => ({
        raw_page: page.rawPage,
        source_row_count: page.sourceRowCount,
        request_sha256: page.requestSha256,
        http_status: page.httpStatus,
        pagination_position: page.paginationPosition,
        source_reports: page.sourceReports,
      })),
      parse_pages: capture.parsePages,
      parser_transformation: capture.parserTransformation,
      accepted_population: parsed.rows.length,
      rejected_row_count: 0,
      acquisition_attempt: {
        binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
        attempt_id: '00000000-0000-4000-8000-000000000001',
        attempt_seq: 1,
      },
    })

    expect(assessLeaderboardNativeWindowRequest(built.manifest)).toMatchObject({
      state: 'request_verified',
      diagnostic: 'provider_window_boundary_unavailable',
    })
  })

  it('excludes headers and rejects unknown query/body request semantics', () => {
    const projection = projectBinanceLeaderboardRequest({
      url: 'https://www.binance.com/bapi/query-list',
      method: 'POST',
      headers: { authorization: 'SUPERSECRET' },
      body: {
        pageNumber: 1,
        pageSize: 20,
        timeRange: '30D',
        dataType: 'ROI',
        favoriteOnly: false,
        hideFull: false,
        nickname: '',
        order: 'DESC',
        userAsset: 0,
        portfolioType: 'ALL',
        useAiRecommended: false,
      },
    })

    expect(projection.url).toBe('https://www.binance.com/bapi/query-list')
    expect(JSON.stringify(projection)).not.toContain('SUPERSECRET')

    expect(() =>
      projectBinanceLeaderboardRequest({
        ...projection,
        url: `${projection.url}?sig=SUPERSECRET`,
        headers: {},
      })
    ).toThrow('must not contain query parameters')
    expect(() =>
      projectBinanceLeaderboardRequest({
        ...projection,
        headers: {},
        body: { ...(projection.body as Record<string, unknown>), ticket: 'SUPERSECRET' },
      })
    ).toThrow('contains non-public fields')
  })

  it('fails closed on malformed source reports and invalid smoke caps', async () => {
    const original = fixture('leaderboard-p1.json')
    const rows = (original.data as { list: Array<Record<string, unknown>> }).list.slice(0, 1)
    const malformed = withRows('leaderboard-p1.json', rows, '9806')
    const malformedSession = session(async () => ({ status: 200, json: malformed }))

    let malformedError: unknown
    try {
      await binanceAdapter.captureLeaderboard!(malformedSession.session, source(), 30)
    } catch (error) {
      malformedError = error
    }
    expect(malformedError).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(malformedError).toMatchObject({
      status: 200,
      capture: {
        terminationReason: 'upstream_error',
        parsePages: [],
        sourcePages: [
          {
            sourceRowCount: 0,
            httpStatus: 200,
            rawPage: { payload: { data: { total: '9806' } } },
          },
        ],
      },
    })
    expect((malformedError as Error).message).toContain('data.total must be numeric')

    const neverFetch = jest.fn(async () => ({ status: 200, json: malformed }))
    const invalidCapSession = session(neverFetch)
    await expect(
      binanceAdapter.captureLeaderboard!(invalidCapSession.session, source({ max_pages: 0 }), 30)
    ).rejects.toThrow('meta.max_pages must be a positive safe integer')
    expect(invalidCapSession.page.goto).not.toHaveBeenCalled()
    expect(neverFetch).not.toHaveBeenCalled()
  })
})
