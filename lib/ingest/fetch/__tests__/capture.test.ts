import {
  IncompleteCrawlError,
  LEADERBOARD_PUBLIC_REQUEST_PROJECTION_CONTRACT,
  LeaderboardCaptureUpstreamError,
  captureNumericLeaderboard,
  leaderboardPublicRequestProjection,
  leaderboardPublicRequestSha256,
  replayPaged,
} from '../capture'
import type { JsonFetcher } from '../capture'
import type { FetchSession, ReplayRequestTemplate } from '../types'
import { buildLeaderboardAcquisitionManifest } from '../../acquisition-manifest'
import { BlockedUpstreamError } from '../rate-limiter'
import { CircuitOpenError } from '../circuit'

/** Minimal paced-only session stub — replay never touches Playwright. */
const session = {
  sourceSlug: 'test',
  paced: <T>(fn: () => Promise<T>) => fn(),
} as unknown as FetchSession

function makeFetcher(pages: Array<{ rows: unknown[]; total?: number }>): JsonFetcher {
  return async (template: ReplayRequestTemplate) => {
    const idx = Number(new URL(template.url).searchParams.get('page')) - 1
    const page = pages[idx] ?? { rows: [] }
    return { status: 200, json: { rows: page.rows, total: page.total ?? null } }
  }
}

const opts = (fetcher: JsonFetcher, pageSize: number | null) => ({
  session,
  fetcher,
  buildRequest: (pageIndex: number) => ({
    url: `https://x.test/api?page=${pageIndex}`,
    method: 'GET' as const,
    headers: {},
  }),
  extractMeta: (payload: unknown) => {
    const p = payload as { rows: unknown[]; total: number | null }
    return { rowCount: p.rows.length, reportedTotal: p.total }
  },
  pageSize,
})

async function collect(gen: AsyncGenerator<{ pageIndex: number }>) {
  const out: number[] = []
  for await (const page of gen) out.push(page.pageIndex)
  return out
}

interface CapturePage {
  status?: number
  rows: unknown[]
  total?: number | null
  pages?: number | null
  current?: number | null
  size?: number | null
}

function makeCaptureFetcher(pages: CapturePage[]): JsonFetcher {
  return async (template) => {
    const body = template.body as { pageNumber: number }
    const page = pages[body.pageNumber - 1] ?? { rows: [] }
    return {
      status: page.status ?? 200,
      json: {
        rows: page.rows,
        total: page.total ?? null,
        pages: page.pages ?? null,
        current: page.current ?? null,
        size: page.size ?? null,
      },
    }
  }
}

function captureOptions(
  fetcher: JsonFetcher,
  overrides: Partial<Parameters<typeof captureNumericLeaderboard>[0]> = {}
): Parameters<typeof captureNumericLeaderboard>[0] {
  return {
    session,
    fetcher,
    buildRequest: (pageIndex) => ({
      url: `https://x.test/board?page=${pageIndex}`,
      method: 'POST',
      headers: { authorization: 'must-not-enter-request-identity' },
      body: { pageNumber: pageIndex, pageSize: 2 },
    }),
    projectPublicRequest: (template) => ({
      url: template.url,
      method: template.method,
      body: template.body,
    }),
    pageBinding: { location: 'body', path: ['pageNumber'] },
    extractMeta: (payload) => {
      const page = payload as {
        rows: unknown[]
        total: number | null
        pages: number | null
        current: number | null
        size: number | null
      }
      return {
        rowCount: page.rows.length,
        reportedPopulation: page.total,
        reportedPageCount: page.pages,
        reportedCurrentPage: page.current,
        reportedPageSize: page.size,
      }
    },
    pageSize: 2,
    safetyPageCap: 10,
    now: () => '2026-07-21T12:00:00.000Z',
    ...overrides,
  }
}

describe('captureNumericLeaderboard', () => {
  it('hashes the fixed caller-declared public projection and binds POST page bodies', () => {
    const first = {
      url: 'https://x.test/board',
      method: 'POST' as const,
      body: { pageNumber: 1 },
    }
    const secondPage = { ...first, body: { pageNumber: 2 } }

    const pageBinding = { location: 'body' as const, path: ['pageNumber'] }
    expect(leaderboardPublicRequestProjection(first, pageBinding)).toEqual({
      data_contract: LEADERBOARD_PUBLIC_REQUEST_PROJECTION_CONTRACT,
      method: 'POST',
      url: 'https://x.test/board',
      body: { pageNumber: 1 },
      pagination_binding: pageBinding,
      request_page_index: 1,
    })
    expect(leaderboardPublicRequestSha256(first, pageBinding)).toBe(
      'f1e0f91fc7c2bc05fbd4295eed3ad0c776062e67cc23275832a6079089e2280b'
    )
    expect(leaderboardPublicRequestSha256(first, pageBinding)).not.toBe(
      leaderboardPublicRequestSha256(secondPage, pageBinding)
    )
    expect(leaderboardPublicRequestSha256(first, pageBinding)).toMatch(/^[0-9a-f]{64}$/)
    expect(() =>
      leaderboardPublicRequestSha256(
        {
          url: 'https://x.test/board',
          method: 'GET',
          body: { ignored: true },
        },
        pageBinding
      )
    ).toThrow('must not declare an ignored body')
    expect(() =>
      leaderboardPublicRequestSha256(
        {
          url: 'https://x.test/board?access_token=secret',
          method: 'GET',
        },
        { location: 'query', key: 'access_token' }
      )
    ).toThrow('sensitive query field')
    expect(() =>
      leaderboardPublicRequestSha256(
        {
          url: 'https://x.test/board',
          method: 'POST',
          body: { api_key: 'secret' },
        },
        pageBinding
      )
    ).toThrow('sensitive field')

    for (const template of [
      {
        url: 'https://x.test/board?accessToken=secret',
        method: 'GET' as const,
      },
      {
        url: 'https://x.test/board',
        method: 'POST' as const,
        body: { sessionId: 'secret' },
      },
      {
        url: 'https://x.test/board',
        method: 'POST' as const,
        body: { auth: { jwt: 'secret' } },
      },
    ]) {
      expect(() => leaderboardPublicRequestSha256(template, pageBinding)).toThrow('sensitive')
    }
    expect(() =>
      leaderboardPublicRequestSha256(
        {
          url: 'https://x.test/board',
          method: 'POST',
          body: 'access_token=secret',
        },
        pageBinding
      )
    ).toThrow('must be a JSON object or null')

    expect(
      leaderboardPublicRequestProjection(
        {
          url: 'https://EXAMPLE.com:443/a/../board?x=1',
          method: 'GET',
        },
        { location: 'query', key: 'x' }
      ).url
    ).toBe('https://example.com/board?x=1')
  })

  it('persists only the explicit public projection, never the authenticated request URL', async () => {
    let actualUrl = ''
    const capture = await captureNumericLeaderboard(
      captureOptions(
        async (template) => {
          actualUrl = template.url
          return {
            status: 200,
            json: { rows: ['one'], total: 1, pages: 1, current: 1, size: 1 },
          }
        },
        {
          buildRequest: () => ({
            url: 'https://x.test/board?page=1&sig=SUPERSECRET',
            method: 'POST',
            headers: { authorization: 'SUPERSECRET' },
            body: { pageNumber: 1, pageSize: 2, ticket: 'SUPERSECRET' },
          }),
          projectPublicRequest: (template) => ({
            url: 'https://x.test/board?page=1',
            method: template.method,
            body: { pageNumber: 1, pageSize: 2 },
          }),
        }
      )
    )

    expect(actualUrl).toContain('SUPERSECRET')
    expect(capture.sourcePages[0].rawPage.url).toBe('https://x.test/board?page=1')
    expect(JSON.stringify(capture)).not.toContain('SUPERSECRET')
  })

  it('binds the public projection to the actual endpoint, fields, and numeric page', async () => {
    const onePage = makeCaptureFetcher([{ rows: ['one'] }])
    await expect(
      captureNumericLeaderboard(
        captureOptions(onePage, {
          projectPublicRequest: (template) => ({
            url: 'https://other.test/board?page=1',
            method: template.method,
            body: template.body,
          }),
        })
      )
    ).rejects.toThrow('retain the actual request origin and path')

    await expect(
      captureNumericLeaderboard(
        captureOptions(onePage, {
          projectPublicRequest: (template) => ({
            url: 'https://x.test/board?page=2',
            method: template.method,
            body: template.body,
          }),
        })
      )
    ).rejects.toThrow('query must be an exact subset')

    await expect(
      captureNumericLeaderboard(
        captureOptions(onePage, {
          projectPublicRequest: (template) => ({
            url: template.url,
            method: template.method,
            body: { pageNumber: 2, pageSize: 2 },
          }),
        })
      )
    ).rejects.toThrow('body must be an exact field subset')

    await expect(
      captureNumericLeaderboard(
        captureOptions(
          makeCaptureFetcher([{ rows: ['one', 'two'] }, { rows: ['three', 'four'] }]),
          {
            callerPageCap: 2,
            buildRequest: () => ({
              url: 'https://x.test/board?page=1',
              method: 'POST',
              headers: {},
              body: { pageNumber: 1, pageSize: 2 },
            }),
          }
        )
      )
    ).rejects.toThrow('actual request page index must match')
  })

  it('rejects an actual GET body before fetch semantics can diverge', async () => {
    const fetcher = jest.fn(async () => ({ status: 200, json: { rows: [] } }))
    await expect(
      captureNumericLeaderboard(
        captureOptions(fetcher, {
          buildRequest: () => ({
            url: 'https://x.test/board?page=1',
            method: 'GET',
            headers: {},
            body: { ignoredByApiFetcher: true },
          }),
          projectPublicRequest: () => ({
            url: 'https://x.test/board?page=1',
            method: 'GET',
          }),
          pageBinding: { location: 'query', key: 'page' },
        })
      )
    ).rejects.toThrow('actual GET leaderboard requests must not declare a body')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves each response status, URL, reports, and raw source row count', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'], total: 2 }]), {
        callerPageCap: 1,
      })
    )

    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.captureConfig).toEqual({ caller_page_cap: 1, safety_page_cap: 10 })
    expect(capture.parserTransformation).toEqual({
      kind: 'identity_projection',
      source_page_ordinals: [1],
    })
    expect(capture.sourcePages).toHaveLength(1)
    expect(capture.sourcePages[0]).toMatchObject({
      sourceRowCount: 2,
      httpStatus: 200,
      paginationPosition: { kind: 'page_index', request_page_index: 1 },
      sourceReports: {
        population: { state: 'reported', value: 2 },
        page_count: { state: 'not_reported' },
        current_page: { state: 'not_reported' },
        page_size: { state: 'not_reported' },
      },
      rawPage: {
        pageIndex: 1,
        url: 'https://x.test/board?page=1',
        fetchedAt: '2026-07-21T12:00:00.000Z',
      },
    })
    expect(capture.sourcePages[0].requestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(capture.parsePages).toEqual([capture.sourcePages[0].rawPage])
  })

  it('retains an empty terminal response but excludes it from parser pages', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'] }, { rows: [] }]), {
        pageSize: null,
      })
    )

    expect(capture.terminationReason).toBe('empty_page')
    expect(capture.sourcePages.map((page) => page.sourceRowCount)).toEqual([2, 0])
    expect(capture.parsePages.map((page) => page.pageIndex)).toEqual([1])
    expect(capture.parserTransformation.source_page_ordinals).toEqual([1])
  })

  it('retains a degenerate terminal response but excludes it from parser pages', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: [0, 0], total: 20 }]), {
        isDegenerate: (payload) =>
          (payload as { rows: number[] }).rows.every((value) => value === 0),
      })
    )

    expect(capture.terminationReason).toBe('degenerate_page')
    expect(capture.sourcePages).toHaveLength(1)
    expect(capture.sourcePages[0].sourceRowCount).toBe(2)
    expect(capture.parsePages).toEqual([])
    expect(capture.parserTransformation.source_page_ordinals).toEqual([])
  })

  it('prioritizes exact reported population on a full cap page over limitation', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'], total: 2 }]), {
        callerPageCap: 1,
        safetyPageCap: 1,
      })
    )

    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.parsePages).toHaveLength(1)
  })

  it('marks a full page with no report as caller-limited even when no next page is known', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'] }]), { callerPageCap: 1 })
    )

    expect(capture.terminationReason).toBe('caller_limit')
    expect(capture.sourcePages[0].sourceReports).toEqual({
      population: { state: 'not_reported' },
      page_count: { state: 'not_reported' },
      current_page: { state: 'not_reported' },
      page_size: { state: 'not_reported' },
    })
  })

  it('uses the safety limit when the configured caller cap is beyond it', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'] }]), {
        callerPageCap: 2,
        safetyPageCap: 1,
      })
    )

    expect(capture.terminationReason).toBe('safety_limit')
  })

  it('does not call a configured caller cap limited when a short page ends naturally', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one'] }]), { callerPageCap: 1 })
    )

    expect(capture.terminationReason).toBe('short_page')
  })

  it('records non-2xx inside paced, carries RAW evidence, and still rejects for retry', async () => {
    const extractMeta = jest.fn(() => ({
      rowCount: 0,
      reportedPopulation: null,
      reportedPageCount: null,
      reportedCurrentPage: null,
      reportedPageSize: null,
    }))
    let pacedSawFailure = false
    const failureSession = {
      sourceSlug: 'test',
      paced: async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn()
        } catch (error) {
          pacedSawFailure = true
          throw error
        }
      },
    } as unknown as FetchSession
    let thrown: unknown
    try {
      await captureNumericLeaderboard(
        captureOptions(makeCaptureFetcher([{ status: 503, rows: [] }]), {
          extractMeta,
          session: failureSession,
        })
      )
    } catch (error) {
      thrown = error
    }

    expect(pacedSawFailure).toBe(true)
    expect(thrown).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    const capture = (thrown as LeaderboardCaptureUpstreamError).capture
    expect(capture.terminationReason).toBe('upstream_error')
    expect(capture.sourcePages[0]).toMatchObject({
      httpStatus: 503,
      sourceRowCount: 0,
      rawPage: {
        payload: { rows: [], total: null, pages: null, current: null, size: null },
      },
    })
    expect(capture.parsePages).toEqual([])
    expect(extractMeta).not.toHaveBeenCalled()
  })

  it('turns a first-request transport failure into page-less unavailable evidence', async () => {
    const transportError = new Error('socket timed out before headers')
    let thrown: unknown
    try {
      await captureNumericLeaderboard(
        captureOptions(async () => {
          throw transportError
        })
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(thrown).toMatchObject({
      status: null,
      publicUrl: 'https://x.test/board?page=1',
      cause: transportError,
      capture: {
        terminationReason: 'upstream_error',
        sourcePages: [],
        parsePages: [],
        parserTransformation: { kind: 'identity_projection', source_page_ordinals: [] },
      },
    })
    expect((thrown as LeaderboardCaptureUpstreamError).cause).toBe(transportError)
    expect(Object.isFrozen((thrown as LeaderboardCaptureUpstreamError).capture)).toBe(true)
  })

  it('retains successful pages when a later request fails before a response', async () => {
    const transportError = new Error('connection reset on page two')
    let requestCount = 0
    const fetcher: JsonFetcher = async () => {
      requestCount += 1
      if (requestCount === 2) throw transportError
      return {
        status: 200,
        json: {
          rows: ['one', 'two'],
          total: 4,
          pages: 2,
          current: 1,
          size: 2,
        },
      }
    }

    let thrown: unknown
    try {
      await captureNumericLeaderboard(captureOptions(fetcher))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(thrown).toMatchObject({
      status: null,
      publicUrl: 'https://x.test/board?page=2',
      cause: transportError,
      capture: {
        terminationReason: 'upstream_error',
        parserTransformation: { kind: 'identity_projection', source_page_ordinals: [1] },
      },
    })
    const capture = (thrown as LeaderboardCaptureUpstreamError).capture
    expect(capture.sourcePages).toHaveLength(1)
    expect(capture.sourcePages[0]).toMatchObject({
      httpStatus: 200,
      sourceRowCount: 2,
      paginationPosition: { kind: 'page_index', request_page_index: 1 },
    })
    expect(capture.parsePages).toEqual([capture.sourcePages[0].rawPage])
    expect((thrown as LeaderboardCaptureUpstreamError).cause).toBe(transportError)
  })

  it('wraps an open circuit as a page-less no-response capture', async () => {
    const circuitError = new CircuitOpenError('test', Date.now() + 60_000)
    const circuitSession = {
      sourceSlug: 'test',
      paced: async () => {
        throw circuitError
      },
    } as unknown as FetchSession

    let thrown: unknown
    try {
      await captureNumericLeaderboard(
        captureOptions(makeCaptureFetcher([]), { session: circuitSession })
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(thrown).toMatchObject({
      status: null,
      capture: { sourcePages: [], parsePages: [], terminationReason: 'upstream_error' },
    })
    expect((thrown as LeaderboardCaptureUpstreamError).cause).toBe(circuitError)
  })

  it('does not relabel session lifecycle or response-contract errors as upstream transport', async () => {
    const lifecycleError = new Error('[ingest] test fetch session is closed')
    const closedSession = {
      sourceSlug: 'test',
      paced: async () => {
        throw lifecycleError
      },
    } as unknown as FetchSession

    await expect(
      captureNumericLeaderboard(captureOptions(makeCaptureFetcher([]), { session: closedSession }))
    ).rejects.toBe(lifecycleError)

    let contractFailure: unknown
    try {
      await captureNumericLeaderboard(
        captureOptions(async () => ({ status: 99, json: { rows: [] } }))
      )
    } catch (error) {
      contractFailure = error
    }
    expect(contractFailure).toBeInstanceOf(TypeError)
    expect(contractFailure).not.toBeInstanceOf(LeaderboardCaptureUpstreamError)
  })

  it('throws blocked statuses inside paced so backoff and circuit accounting see them', async () => {
    let pacedCause: unknown
    const observingSession = {
      sourceSlug: 'test',
      paced: async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn()
        } catch (error) {
          pacedCause = error
          throw error
        }
      },
    } as unknown as FetchSession

    await expect(
      captureNumericLeaderboard(
        captureOptions(makeCaptureFetcher([{ status: 429, rows: [] }]), {
          session: observingSession,
        })
      )
    ).rejects.toMatchObject({
      status: 429,
      capture: { terminationReason: 'upstream_error' },
    })
    expect(pacedCause).toBeInstanceOf(BlockedUpstreamError)
  })

  it('carries frozen RAW when a 2xx response fails metadata validation', async () => {
    const validationError = new TypeError('application envelope is invalid')
    let thrown: unknown
    try {
      await captureNumericLeaderboard(
        captureOptions(makeCaptureFetcher([{ rows: ['untrusted'], total: 1 }]), {
          extractMeta: () => {
            throw validationError
          },
        })
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(LeaderboardCaptureUpstreamError)
    expect(thrown).toMatchObject({
      status: 200,
      cause: validationError,
      capture: {
        terminationReason: 'upstream_error',
        parsePages: [],
        sourcePages: [
          {
            httpStatus: 200,
            sourceRowCount: 0,
            sourceReports: {
              population: { state: 'not_reported' },
              page_count: { state: 'not_reported' },
              current_page: { state: 'not_reported' },
              page_size: { state: 'not_reported' },
            },
            rawPage: {
              payload: {
                rows: ['untrusted'],
                total: 1,
                pages: null,
                current: null,
                size: null,
              },
            },
          },
        ],
      },
    })
    expect(Object.isFrozen((thrown as LeaderboardCaptureUpstreamError).capture)).toBe(true)
  })

  it('deep-freezes the canonical response before metadata and parser consumers see it', async () => {
    let callbackPayload: unknown
    const capture = await captureNumericLeaderboard(
      captureOptions(makeCaptureFetcher([{ rows: ['one', 'two'], total: 2 }]), {
        extractMeta: (payload) => {
          callbackPayload = payload
          const page = payload as {
            rows: unknown[]
            total: number | null
            pages: number | null
            current: number | null
            size: number | null
          }
          try {
            page.rows.length = 0
          } catch {
            // Expected: a parser cannot rewrite RAW evidence in place.
          }
          return {
            rowCount: page.rows.length,
            reportedPopulation: page.total,
            reportedPageCount: page.pages,
            reportedCurrentPage: page.current,
            reportedPageSize: page.size,
          }
        },
      })
    )

    expect(Object.isFrozen(callbackPayload)).toBe(true)
    expect(Object.isFrozen((callbackPayload as { rows: unknown[] }).rows)).toBe(true)
    expect(capture.sourcePages[0].sourceRowCount).toBe(2)
    expect(capture.sourcePages[0].rawPage.payload).toEqual({
      rows: ['one', 'two'],
      total: 2,
      pages: null,
      current: null,
      size: null,
    })
    expect(Object.isFrozen(capture)).toBe(true)
    expect(Object.isFrozen(capture.sourcePages)).toBe(true)
    expect(Object.isFrozen(capture.sourcePages[0].rawPage)).toBe(true)
  })

  it('supports page-count-only sources without inventing a population report', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(
        makeCaptureFetcher([
          { rows: ['one', 'two'], pages: 2 },
          { rows: ['three', 'four'], pages: 2 },
        ])
      )
    )

    expect(capture.terminationReason).toBe('reported_page_count_reached')
    expect(capture.sourcePages).toHaveLength(2)
    expect(capture.sourcePages.map((page) => page.rawPage.url)).toEqual([
      'https://x.test/board?page=1',
      'https://x.test/board?page=2',
    ])
    expect(capture.sourcePages[0].requestSha256).not.toBe(capture.sourcePages[1].requestSha256)
    expect(
      capture.sourcePages.every((page) => page.sourceReports.population.state === 'not_reported')
    ).toBe(true)
    expect(capture.sourcePages[1].sourceReports.page_count).toEqual({
      state: 'reported',
      value: 2,
    })
  })

  it('preserves mismatched upstream current evidence so the manifest fails closed', async () => {
    const capture = await captureNumericLeaderboard(
      captureOptions(
        makeCaptureFetcher([
          { rows: ['one', 'two'], total: 4, pages: 2, current: 1, size: 2 },
          { rows: ['three', 'four'], total: 4, pages: 2, current: 1, size: 2 },
        ])
      )
    )
    const built = buildLeaderboardAcquisitionManifest({
      source: {
        id: 1,
        slug: 'binance_web3',
        adapter_slug: 'binance_web3',
        configured_page_size: 2,
        configured_pagination_kind: 'numeric',
      },
      surface: 'tier_a_leaderboard',
      timeframe: 30,
      started_at: '2026-07-21T11:59:59.000Z',
      completed_at: '2026-07-21T12:00:01.000Z',
      runner_git_sha: 'a'.repeat(40),
      observation_cycle_id: 'capture-test',
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
      accepted_population: 4,
      rejected_row_count: 0,
    })

    expect(built.manifest.source_pages[1].source_reports?.current_page).toEqual({
      state: 'reported',
      value: 1,
    })
    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('rejects unsafe caps, status, counts, and reports', async () => {
    const onePage = makeCaptureFetcher([{ rows: ['one'] }])
    await expect(
      captureNumericLeaderboard(captureOptions(onePage, { callerPageCap: -0 }))
    ).rejects.toThrow('caller page cap')
    await expect(
      captureNumericLeaderboard(captureOptions(onePage, { safetyPageCap: 1.5 }))
    ).rejects.toThrow('safety page cap')
    await expect(
      captureNumericLeaderboard(
        captureOptions(onePage, {
          projectPublicRequest: () => ({ url: 'https://x.test/board?page=1', method: 'GET' }),
          pageBinding: { location: 'query', key: 'page' },
        })
      )
    ).rejects.toThrow('public request method must match')

    for (const status of [-0, 99, 600, 200.5]) {
      await expect(
        captureNumericLeaderboard(captureOptions(async () => ({ status, json: { rows: [] } })))
      ).rejects.toThrow('HTTP status')
    }

    for (const meta of [
      {
        rowCount: -0,
        reportedPopulation: null,
        reportedPageCount: null,
        reportedCurrentPage: null,
        reportedPageSize: null,
      },
      {
        rowCount: 1,
        reportedPopulation: Number.MAX_SAFE_INTEGER + 1,
        reportedPageCount: null,
        reportedCurrentPage: null,
        reportedPageSize: null,
      },
      {
        rowCount: 1,
        reportedPopulation: null,
        reportedPageCount: -0,
        reportedCurrentPage: null,
        reportedPageSize: null,
      },
    ]) {
      await expect(
        captureNumericLeaderboard(
          captureOptions(onePage, {
            extractMeta: () => meta,
          })
        )
      ).rejects.toThrow(/safe integer|negative zero/)
    }
  })
})

describe('replayPaged', () => {
  it('walks pages until a short page and yields each', async () => {
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 8 },
      { rows: [4, 5, 6] },
      { rows: [7, 8] }, // short page → stop
    ])
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2, 3])
  })

  it('stops on an empty page', async () => {
    const fetcher = makeFetcher([{ rows: [1, 2] }, { rows: [] }])
    expect(await collect(replayPaged(opts(fetcher, null)))).toEqual([1])
  })

  it('stops once reportedTotal rows are seen', async () => {
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 6 },
      { rows: [4, 5, 6] },
      { rows: [99, 99, 99] }, // must never be fetched
    ])
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2])
  })

  it('applies the degenerate-page stop rule without failing completeness', async () => {
    // XT failure mode: source claims 1000 but pages turn all-zero after 2.
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 1000 },
      { rows: [4, 5, 6] },
      { rows: [0, 0, 0] },
      { rows: [0, 0, 0] },
    ])
    const pages = await collect(
      replayPaged({
        ...opts(fetcher, 3),
        isDegenerate: (payload) => (payload as { rows: number[] }).rows.every((r) => r === 0),
      })
    )
    expect(pages).toEqual([1, 2]) // degenerate page not yielded, no throw
  })

  it('ending on an empty page short of total is a natural end (stale total)', async () => {
    // Source claims 9 rows but only 6 exist; empty page 3 is a legitimate
    // end per spec §5.6 (last page short or empty) — count-check at staging
    // catches real shrinkage via the rolling baseline instead.
    const fetcher: JsonFetcher = async (template) => {
      const page = Number(new URL(template.url).searchParams.get('page'))
      if (page <= 2) return { status: 200, json: { rows: [1, 2, 3], total: 9 } }
      return { status: 200, json: { rows: [], total: 9 } }
    }
    expect(await collect(replayPaged(opts(fetcher, 3)))).toEqual([1, 2])
  })

  it('throws IncompleteCrawlError when stopping on a full page short of total', async () => {
    // maxPages cap (or a stuck cursor) ends the crawl while the last page
    // was still full and the total was not reached → truncated crawl.
    const fetcher = makeFetcher([
      { rows: [1, 2, 3], total: 12 },
      { rows: [4, 5, 6] },
      { rows: [7, 8, 9] },
      { rows: [10, 11, 12] },
    ])
    await expect(collect(replayPaged({ ...opts(fetcher, 3), maxPages: 2 }))).rejects.toThrow(
      IncompleteCrawlError
    )
  })
})
