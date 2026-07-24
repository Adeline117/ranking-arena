import {
  LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
  buildLeaderboardAcquisitionManifest,
  buildLeaderboardAcquisitionManifestV3,
  type BuildLeaderboardAcquisitionManifestInput,
} from '@/lib/ingest/acquisition-manifest'
import type { RankingTimeframe } from '@/lib/ingest/core/types'
import { buildOkxWeb3LeaderboardListUrl } from '@/lib/ingest/adapters/okx-web3/request-evidence'
import {
  BINANCE_LEADERBOARD_LIST_URLS,
  BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
  BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS,
  BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT,
  OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
  OKX_WEB3_SOLANA_SINGLE_RESPONSE_POPULATION_CONTRACT,
  assessLeaderboardMetricAuthorities,
  assessLeaderboardNativeWindowRequest,
  binanceLeaderboardListRequestSha256,
  buildBinanceLeaderboardListBody,
  okxWeb3LeaderboardListRequestSha256,
} from '@/lib/ingest/leaderboard-request-evidence'

type BinanceSourceSlug = 'binance_futures' | 'binance_spot'

interface ManifestOptions {
  sourceSlug?: string
  adapterSlug?: string
  timeframe?: RankingTimeframe
  configuredPageSize?: number | null
  requestHashPageIndex?: number
  requestHashPageSize?: number
  requestHashTimeframe?: RankingTimeframe
  requestSha256?: string
  url?: string
  reportedCurrentPage?: number | null
  reportedPageSize?: number | null
  callerLimited?: boolean
  secondPageFetchedAt?: string
  secondRequestSha256?: string
  manifestVersion?: 2 | 3
  reportedPopulation?: number | null
  sourceRowCount?: number
}

function isOkxWeb3(sourceSlug: string): boolean {
  return sourceSlug === 'okx_web3_solana'
}

function listUrl(
  sourceSlug: string,
  pageIndex: number,
  pageSize: number,
  timeframe: RankingTimeframe
): string {
  if (isOkxWeb3(sourceSlug)) {
    return buildOkxWeb3LeaderboardListUrl({ pageIndex, pageSize, timeframe })
  }
  return sourceSlug === 'binance_spot'
    ? BINANCE_LEADERBOARD_LIST_URLS.spot
    : BINANCE_LEADERBOARD_LIST_URLS.futures
}

function reviewedRequestSha256(input: {
  sourceSlug: string
  pageIndex: number
  pageSize: number
  timeframe: RankingTimeframe
}): string | null {
  return isOkxWeb3(input.sourceSlug)
    ? okxWeb3LeaderboardListRequestSha256(input)
    : binanceLeaderboardListRequestSha256(input)
}

function manifest(options: ManifestOptions = {}) {
  const sourceSlug = options.sourceSlug ?? 'binance_futures'
  const timeframe = options.timeframe ?? 30
  const configuredPageSize =
    options.configuredPageSize === undefined ? 20 : options.configuredPageSize
  const effectivePageSize = configuredPageSize ?? 20
  const okxWeb3 = isOkxWeb3(sourceSlug)
  const callerLimited = options.callerLimited ?? false
  const sourceRowCount = options.sourceRowCount ?? 1
  const reportedPopulation =
    options.reportedPopulation === undefined ? (callerLimited ? 2 : 1) : options.reportedPopulation
  const completedAt = options.secondPageFetchedAt
    ? new Date(Date.parse(options.secondPageFetchedAt) + 1_000).toISOString()
    : '2026-07-21T10:00:02.000Z'
  const rawPage = {
    pageIndex: 1,
    payload: {
      code: '000000',
      success: true,
      data: {
        ...(reportedPopulation === null ? {} : { total: reportedPopulation }),
        list: Array.from({ length: sourceRowCount }, () => ({})),
      },
    },
    url: options.url ?? listUrl(sourceSlug, 1, effectivePageSize, timeframe),
    fetchedAt: '2026-07-21T10:00:01.000Z',
  }
  const requestSha256 =
    options.requestSha256 ??
    reviewedRequestSha256({
      sourceSlug,
      pageIndex: options.requestHashPageIndex ?? 1,
      pageSize: options.requestHashPageSize ?? effectivePageSize,
      timeframe: options.requestHashTimeframe ?? timeframe,
    }) ??
    'f'.repeat(64)

  const sourcePages: BuildLeaderboardAcquisitionManifestInput['source_pages'] = [
    {
      raw_page: rawPage,
      source_row_count: sourceRowCount,
      request_sha256: requestSha256,
      http_status: 200,
      pagination_position: { kind: 'page_index', request_page_index: 1 },
      source_reports: {
        population:
          reportedPopulation === null
            ? { state: 'not_reported' }
            : { state: 'reported', value: reportedPopulation },
        page_count: { state: 'not_reported' },
        current_page: okxWeb3
          ? options.reportedCurrentPage === null
            ? { state: 'not_reported' }
            : { state: 'reported', value: options.reportedCurrentPage ?? 1 }
          : { state: 'not_reported' },
        page_size:
          okxWeb3 && options.reportedPageSize === undefined
            ? { state: 'reported', value: effectivePageSize }
            : options.reportedPageSize === null || options.reportedPageSize === undefined
              ? { state: 'not_reported' }
              : { state: 'reported', value: options.reportedPageSize },
      },
    },
  ]
  if (options.secondPageFetchedAt) {
    const secondRequestSha256 =
      options.secondRequestSha256 ??
      reviewedRequestSha256({
        sourceSlug,
        pageIndex: 2,
        pageSize: effectivePageSize,
        timeframe,
      })
    if (secondRequestSha256 === null) throw new Error('test source has no request contract')
    sourcePages.push({
      raw_page: {
        pageIndex: 2,
        payload: { code: '000000', success: true, data: { total: 1, list: [] } },
        url: options.url ?? listUrl(sourceSlug, 2, effectivePageSize, timeframe),
        fetchedAt: options.secondPageFetchedAt,
      },
      source_row_count: 0,
      request_sha256: secondRequestSha256,
      http_status: 200,
      pagination_position: { kind: 'page_index', request_page_index: 2 },
      source_reports: {
        population: { state: 'reported', value: 1 },
        page_count: { state: 'not_reported' },
        current_page: okxWeb3 ? { state: 'reported', value: 2 } : { state: 'not_reported' },
        page_size: okxWeb3
          ? { state: 'reported', value: effectivePageSize }
          : { state: 'not_reported' },
      },
    })
  }

  const input: BuildLeaderboardAcquisitionManifestInput = {
    source: {
      id: 1,
      slug: sourceSlug,
      adapter_slug: options.adapterSlug ?? (okxWeb3 ? 'okx_web3' : 'binance'),
      configured_page_size: configuredPageSize,
      configured_pagination_kind: 'numeric',
    },
    surface: 'tier_a_leaderboard',
    timeframe,
    started_at: '2026-07-21T10:00:00.000Z',
    completed_at: completedAt,
    runner_git_sha: 'a'.repeat(40),
    observation_cycle_id: `tier-a:${sourceSlug}:request-evidence-test`,
    capture_evidence_state: 'verified',
    termination_reason: callerLimited
      ? 'caller_limit'
      : options.secondPageFetchedAt || (sourceRowCount === 0 && reportedPopulation === null)
        ? 'empty_page'
        : 'reported_population_reached',
    capture_config: { caller_page_cap: callerLimited ? 1 : null, safety_page_cap: 5_000 },
    source_pages: sourcePages,
    parse_pages: [rawPage],
    parser_transformation: { kind: 'identity_projection', source_page_ordinals: [1] },
    accepted_population: sourceRowCount,
    rejected_row_count: 0,
  }
  if (options.manifestVersion === 2) return buildLeaderboardAcquisitionManifest(input).manifest
  return buildLeaderboardAcquisitionManifestV3({
    ...input,
    acquisition_attempt: {
      binding_contract: LEADERBOARD_ACQUISITION_ATTEMPT_BINDING_CONTRACT,
      attempt_id: '00000000-0000-4000-8000-000000000001',
      attempt_seq: 1,
    },
  }).manifest
}

describe('reviewed leaderboard native-window request evidence', () => {
  it.each([
    ['binance_futures', 7, '0d8c66eff34d3eb25f9d99a637bb829736af62bc22245e3d17b0677a90a77194'],
    ['binance_futures', 30, '22ef408e2675445875028931919c4f450d3e6853a78ed175f55d32307d5483f7'],
    ['binance_futures', 90, 'dee891b7b7924d44a7678fd4b6f57b039e30c7596ffca32a3678446a449fa5d9'],
    ['binance_spot', 7, '9a2d75f5af0e641800cdca6b639c065f2cb7d148de6fa9a7089d3b458e1f1af4'],
    ['binance_spot', 30, '5e70d4b6a3ac05f88fe91a7e9c094dcab4a0db7b0ac39db673326e240cfbfcd4'],
    ['binance_spot', 90, '38c6369b1418bb0066d50ba259ee4c664066dcf84c81a5735d6d5d40973c81c4'],
  ] as const)(
    'matches the independently reviewed %s %dD request digest',
    (sourceSlug, timeframe, expectedSha256) => {
      expect(
        binanceLeaderboardListRequestSha256({
          sourceSlug,
          pageIndex: 1,
          pageSize: 20,
          timeframe,
        })
      ).toBe(expectedSha256)
      expect(buildBinanceLeaderboardListBody(1, 20, timeframe).timeRange).toBe(`${timeframe}D`)
    }
  )

  it.each([
    [7, 1, 20, 'ee1c20e0869371d26c779c479831043de045409131729c1e53e2193a2e812309'],
    [30, 1, 20, 'd3a91344415264887cfa9b356242d792b0aef0cbf049a97beb85e9621dba93a4'],
    [90, 1, 20, '3e740c28a55655da793819414c6b9964d80d178f12c5b0c5648a67fea5238a56'],
    [30, 2, 20, 'd6ffeca0f4ea4242f1a9f02804edf4f32722e04f10773343722250436b64e30e'],
    [30, 1, 2, 'a7e934c00b83d9427d39b0e1de41313daf230ba3cb15903a8c6d2571034c64a5'],
    [30, 2, 2, '2daefe10221095f90dbbcc00457fe03398f140d0baa8a00d8ebc87cb51c6ae3c'],
  ] as const)(
    'matches the reviewed OKX Solana %dD page %d size %d request digest',
    (timeframe, pageIndex, pageSize, expectedSha256) => {
      expect(okxWeb3LeaderboardListRequestSha256({ pageIndex, pageSize, timeframe })).toBe(
        expectedSha256
      )
    }
  )

  it.each([7, 30, 90] as const)(
    'separates the exact OKX Solana %dD request and single-response population from its unknown boundary',
    (timeframe) => {
      const input = manifest({ sourceSlug: 'okx_web3_solana', timeframe })
      const authorities = assessLeaderboardMetricAuthorities(input)
      expect(authorities).toMatchObject({
        request: {
          state: 'verified',
          contractId: OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
          semantics: 'provider_native_period_aggregate',
        },
        population: {
          state: 'verified',
          contractId: OKX_WEB3_SOLANA_SINGLE_RESPONSE_POPULATION_CONTRACT,
          semantics: 'reviewed_board_single_response_population',
        },
        window: {
          state: 'request_verified',
          contractId: OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
          reason: 'native_window_boundary_unverified',
          diagnostic: 'provider_window_boundary_unavailable',
        },
      })
      expect(
        [
          authorities,
          authorities.request,
          authorities.population,
          authorities.window,
          authorities.diagnostics,
        ].every((value) => Object.isFrozen(value))
      ).toBe(true)
      expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
    }
  )

  it.each([
    ['binance_futures', 7],
    ['binance_futures', 30],
    ['binance_futures', 90],
    ['binance_spot', 7],
    ['binance_spot', 30],
    ['binance_spot', 90],
  ] as const)(
    'separates exact %s %dD request and single-response population authority from its unknown window boundary',
    (sourceSlug, timeframe) => {
      const authorities = assessLeaderboardMetricAuthorities(manifest({ sourceSlug, timeframe }))
      expect(authorities).toMatchObject({
        request: {
          state: 'verified',
          contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
          semantics: 'provider_native_period_aggregate',
        },
        population: {
          state: 'verified',
          contractId: BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT,
          semantics: 'reviewed_board_single_response_population',
        },
        window: {
          state: 'request_verified',
          contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
          semantics: 'provider_native_period_aggregate',
          reason: 'native_window_boundary_unverified',
          diagnostic: 'provider_window_boundary_unavailable',
        },
      })
      expect(assessLeaderboardNativeWindowRequest(manifest({ sourceSlug, timeframe }))).toEqual(
        authorities.window
      )
      expect(
        [
          authorities,
          authorities.request,
          authorities.population,
          authorities.window,
          authorities.diagnostics,
        ].every((value) => Object.isFrozen(value))
      ).toBe(true)
    }
  )

  it('builds one frozen body for the adapter and independent verifier', () => {
    const body = buildBinanceLeaderboardListBody(3, 100, 30)
    expect(body).toEqual({
      pageNumber: 3,
      pageSize: 100,
      timeRange: '30D',
      dataType: 'ROI',
      favoriteOnly: false,
      hideFull: false,
      nickname: '',
      order: 'DESC',
      userAsset: 0,
      portfolioType: 'ALL',
      useAiRecommended: false,
    })
    expect(Object.isFrozen(body)).toBe(true)
  })

  it.each([
    ['wrong timeframe digest', { requestHashTimeframe: 7 }],
    ['wrong page digest', { requestHashPageIndex: 2 }],
    ['wrong page-size digest', { requestHashPageSize: 100 }],
    ['arbitrary digest', { requestSha256: '1'.repeat(64) }],
  ] as const)('fails closed on %s', (_label, drift) => {
    const input = manifest(drift)
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: { state: 'unknown', diagnostics: ['request_digest_mismatch'] },
      population: { state: 'unknown', diagnostics: ['request_digest_mismatch'] },
      window: {
        state: 'unknown',
        reason: 'native_window_boundary_unverified',
        diagnostic: 'request_digest_mismatch',
      },
    })
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it.each([
    ['endpoint drift', { url: 'https://www.binance.com/wrong' }, 'page_binding_mismatch'],
    ['unknown source', { sourceSlug: 'okx_futures' }, 'source_contract_unavailable'],
    ['adapter drift', { adapterSlug: 'not-binance' }, 'source_contract_mismatch'],
    [
      'response page-size drift',
      { configuredPageSize: null, reportedPageSize: 100 },
      'page_binding_mismatch',
    ],
  ] as const)(
    'keeps %s unknown on both request and population axes',
    (_label, options, diagnostic) => {
      const input = manifest(options)
      const authorities = assessLeaderboardMetricAuthorities(input)
      expect(authorities.request).toEqual({ state: 'unknown', diagnostics: [diagnostic] })
      expect(authorities.population).toEqual({ state: 'unknown', diagnostics: [diagnostic] })
      expect(authorities.window).toMatchObject({ state: 'unknown', diagnostic })
      expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
    }
  )

  it('keeps an exact request but quarantines a caller-truncated population', () => {
    const input = manifest({ callerLimited: true })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: {
        state: 'verified',
        contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
        semantics: 'provider_native_period_aggregate',
      },
      population: { state: 'unknown', diagnostics: ['capture_not_rankable'] },
      window: { state: 'unknown', diagnostic: 'capture_not_rankable' },
    })
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('keeps a v2 single-page request exact but population and window attempt-unbound', () => {
    const input = manifest({ manifestVersion: 2 })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: {
        state: 'verified',
        contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
        semantics: 'provider_native_period_aggregate',
      },
      population: { state: 'unknown', diagnostics: ['attempt_binding_unavailable'] },
      window: { state: 'unknown', diagnostic: 'attempt_binding_unavailable' },
    })
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('retains both independent v2 and stitched-pagination population blockers', () => {
    const input = manifest({
      manifestVersion: 2,
      secondPageFetchedAt: '2026-07-21T10:00:02.000Z',
    })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: {
        state: 'verified',
        contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
        semantics: 'provider_native_period_aggregate',
      },
      population: {
        state: 'unknown',
        diagnostics: ['attempt_binding_unavailable', 'pagination_snapshot_unavailable'],
      },
      window: { state: 'unknown', diagnostic: 'attempt_binding_unavailable' },
    })
    expect(Object.isFrozen(authorities.population)).toBe(true)
    if (authorities.population.state !== 'unknown') {
      throw new Error('expected a v2 multi-page population to remain unknown')
    }
    expect(Object.isFrozen(authorities.population.diagnostics)).toBe(true)
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('limits an invalid page timestamp to the window axis', () => {
    const valid = manifest()
    const invalid = {
      ...valid,
      source_pages: valid.source_pages.map((page, index) => ({
        ...page,
        fetched_at: index === 0 ? 'not-a-time' : page.fetched_at,
      })),
    }
    const authorities = assessLeaderboardMetricAuthorities(invalid)
    expect(authorities).toMatchObject({
      request: { state: 'verified' },
      population: { state: 'verified' },
      window: { state: 'unknown', diagnostic: 'page_timestamp_invalid' },
    })
    expect(authorities.diagnostics).toContain('page_timestamp_invalid')
    expect(Object.isFrozen(authorities.diagnostics)).toBe(true)
    expect(assessLeaderboardNativeWindowRequest(invalid)).toEqual(authorities.window)
  })

  it('limits a long multi-page capture span to the window axis while pagination stays unknown', () => {
    const input = manifest({
      secondPageFetchedAt: new Date(
        Date.parse('2026-07-21T10:00:01.000Z') + BINANCE_NATIVE_WINDOW_MAX_PAGE_SKEW_MS + 1
      ).toISOString(),
    })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: { state: 'verified' },
      population: { state: 'unknown', diagnostics: ['pagination_snapshot_unavailable'] },
      window: { state: 'unknown', diagnostic: 'page_time_span_exceeds_tolerance' },
    })
    expect(authorities.diagnostics).toEqual([
      'page_time_span_exceeds_tolerance',
      'pagination_snapshot_unavailable',
    ])
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('keeps exact multi-page requests but quarantines the stitched population', () => {
    // Even with stable totals and no duplicate IDs, a reorder between page 1
    // and page 2 can turn [A,B,C,D] into captured [A,B,D,E], omitting C while
    // retaining an exited A. Exact request hashes cannot detect that churn.
    const input = manifest({ secondPageFetchedAt: '2026-07-21T10:00:02.000Z' })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: {
        state: 'verified',
        contractId: BINANCE_NATIVE_PERIOD_REQUEST_CONTRACT,
        semantics: 'provider_native_period_aggregate',
      },
      population: {
        state: 'unknown',
        diagnostics: ['pagination_snapshot_unavailable'],
      },
      window: {
        state: 'unknown',
        reason: 'native_window_boundary_unverified',
        diagnostic: 'pagination_snapshot_unavailable',
      },
    })
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('distinguishes an explicit empty population from a missing total', () => {
    const explicitZero = assessLeaderboardMetricAuthorities(
      manifest({ reportedPopulation: 0, sourceRowCount: 0 })
    )
    expect(explicitZero.population).toMatchObject({
      state: 'verified',
      contractId: BINANCE_SINGLE_RESPONSE_POPULATION_CONTRACT,
    })

    const missingTotal = assessLeaderboardMetricAuthorities(
      manifest({ reportedPopulation: null, sourceRowCount: 0 })
    )
    expect(missingTotal.population).toEqual({
      state: 'unknown',
      diagnostics: ['capture_not_rankable'],
    })
    expect(missingTotal.request).toMatchObject({ state: 'verified' })
  })

  it('rejects request and population authority when only the second-page digest drifts', () => {
    const input = manifest({
      secondPageFetchedAt: '2026-07-21T10:00:02.000Z',
      secondRequestSha256: '2'.repeat(64),
    })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: { state: 'unknown', diagnostics: ['request_digest_mismatch'] },
      population: {
        state: 'unknown',
        diagnostics: ['request_digest_mismatch', 'pagination_snapshot_unavailable'],
      },
      window: { state: 'unknown', diagnostic: 'request_digest_mismatch' },
    })
    expect(assessLeaderboardNativeWindowRequest(input)).toEqual(authorities.window)
  })

  it('keeps exact OKX multi-page requests but quarantines the live-offset population', () => {
    const input = manifest({
      sourceSlug: 'okx_web3_solana',
      secondPageFetchedAt: '2026-07-21T10:00:02.000Z',
    })
    const authorities = assessLeaderboardMetricAuthorities(input)
    expect(authorities).toMatchObject({
      request: {
        state: 'verified',
        contractId: OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
      },
      population: {
        state: 'unknown',
        diagnostics: ['pagination_snapshot_unavailable'],
      },
      window: {
        state: 'unknown',
        diagnostic: 'pagination_snapshot_unavailable',
      },
    })
  })

  it.each([
    ['missing reported current page', { reportedCurrentPage: null }, 'page_binding_mismatch'],
    ['wrong reported current page', { reportedCurrentPage: 2 }, 'page_binding_mismatch'],
    ['missing reported page size', { reportedPageSize: null }, 'page_binding_mismatch'],
    ['wrong reported page size', { reportedPageSize: 19 }, 'page_binding_mismatch'],
    ['adapter drift', { adapterSlug: 'okx' }, 'source_contract_mismatch'],
    [
      'query drift',
      {
        url: buildOkxWeb3LeaderboardListUrl({
          pageIndex: 1,
          pageSize: 20,
          timeframe: 30,
        }).replace('periodType=4', 'periodType=3'),
      },
      'page_binding_mismatch',
    ],
    ['digest drift', { requestSha256: '3'.repeat(64) }, 'request_digest_mismatch'],
    [
      'unsupported page size',
      {
        configuredPageSize: 21,
        url: buildOkxWeb3LeaderboardListUrl({ pageIndex: 1, pageSize: 20, timeframe: 30 }),
        requestSha256: '4'.repeat(64),
      },
      'source_contract_mismatch',
    ],
  ] as const)(
    'fails the OKX request and population contracts on %s',
    (_label, drift, diagnostic) => {
      const authorities = assessLeaderboardMetricAuthorities(
        manifest({ sourceSlug: 'okx_web3_solana', ...drift })
      )
      expect(authorities.request).toEqual({ state: 'unknown', diagnostics: [diagnostic] })
      expect(authorities.population.state).toBe('unknown')
      if (authorities.population.state !== 'unknown') throw new Error('expected unknown population')
      expect(authorities.population.diagnostics).toContain(diagnostic)
      expect(authorities.window.state).toBe('unknown')
      expect(authorities.diagnostics).toContain(diagnostic)
    }
  )

  it.each([
    [2, ['attempt_binding_unavailable']],
    [3, ['capture_not_rankable']],
  ] as const)(
    'keeps an exact OKX request while manifest mode %d leaves population unknown',
    (manifestVersion, populationDiagnostics) => {
      const authorities = assessLeaderboardMetricAuthorities(
        manifest({
          sourceSlug: 'okx_web3_solana',
          manifestVersion,
          callerLimited: manifestVersion === 3,
        })
      )
      expect(authorities.request).toMatchObject({
        state: 'verified',
        contractId: OKX_WEB3_SOLANA_NATIVE_PERIOD_REQUEST_CONTRACT,
      })
      expect(authorities.population).toEqual({
        state: 'unknown',
        diagnostics: populationDiagnostics,
      })
      expect(authorities.window).toMatchObject({
        state: 'unknown',
        diagnostic: populationDiagnostics[0],
      })
    }
  )

  it('does not resolve prototype property names as reviewed sources', () => {
    const authorities = assessLeaderboardMetricAuthorities(manifest({ sourceSlug: 'toString' }))
    expect(authorities.request).toEqual({
      state: 'unknown',
      diagnostics: ['source_contract_unavailable'],
    })
    expect(authorities.population).toEqual({
      state: 'unknown',
      diagnostics: ['source_contract_unavailable'],
    })
  })

  it('keeps board-specific endpoint hashes distinct', () => {
    const hashes = (['binance_futures', 'binance_spot'] as BinanceSourceSlug[]).map((sourceSlug) =>
      binanceLeaderboardListRequestSha256({
        sourceSlug,
        pageIndex: 1,
        pageSize: 20,
        timeframe: 30,
      })
    )
    expect(hashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))).toBe(
      true
    )
    expect(new Set(hashes).size).toBe(2)
  })
})
