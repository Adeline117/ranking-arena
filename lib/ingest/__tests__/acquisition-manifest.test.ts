import { createHash } from 'node:crypto'

import {
  LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT,
  buildLeaderboardAcquisitionManifest,
  parseLeaderboardAcquisitionManifest,
  type BuildLeaderboardAcquisitionManifestInput,
  type LeaderboardAcquisitionReportEvidence,
} from '@/lib/ingest/acquisition-manifest'

const GIT_SHA = 'a'.repeat(40)
const REQUEST_SHA_1 = 'b'.repeat(64)
const REQUEST_SHA_2 = 'c'.repeat(64)
const CURSOR_SHA_1 = 'd'.repeat(64)
const CURSOR_SHA_2 = 'e'.repeat(64)

const reported = (value: number): LeaderboardAcquisitionReportEvidence => ({
  state: 'reported',
  value,
})
const notReported = (): LeaderboardAcquisitionReportEvidence => ({ state: 'not_reported' })

function input(
  overrides: Partial<BuildLeaderboardAcquisitionManifestInput> = {}
): BuildLeaderboardAcquisitionManifestInput {
  const source_pages: BuildLeaderboardAcquisitionManifestInput['source_pages'] = [
    {
      raw_page: {
        pageIndex: 1,
        payload: { data: [{ id: 'one' }, { id: 'two' }], total: 3 },
        url: 'https://example.test/board?page=1',
        fetchedAt: '2026-07-21T10:00:01.000Z',
      },
      source_row_count: 2,
      request_sha256: REQUEST_SHA_1,
      http_status: 200,
      pagination_position: { kind: 'page_index', page_index: 1 },
      source_reports: {
        population: reported(3),
        page_count: notReported(),
      },
    },
    {
      raw_page: {
        pageIndex: 2,
        payload: { data: [{ id: 'three' }], total: 3 },
        url: 'https://example.test/board?page=2',
        fetchedAt: '2026-07-21T10:00:02.000Z',
      },
      source_row_count: 1,
      request_sha256: REQUEST_SHA_2,
      http_status: 200,
      pagination_position: { kind: 'page_index', page_index: 2 },
      source_reports: {
        population: reported(3),
        page_count: notReported(),
      },
    },
  ]

  return {
    source: {
      id: 1,
      slug: 'binance_futures',
      adapter_slug: 'binance',
      configured_page_size: 2,
      configured_pagination_kind: 'numeric',
    },
    surface: 'tier_a_leaderboard',
    timeframe: 30,
    started_at: '2026-07-21T10:00:00.000Z',
    completed_at: '2026-07-21T10:00:03.000Z',
    runner_git_sha: GIT_SHA,
    observation_cycle_id: 'tier-a:binance_futures:job-1:1784628000000',
    capture_evidence_state: 'verified',
    termination_reason: 'reported_population_reached',
    source_pages,
    parse_pages: source_pages.map((page) => page.raw_page),
    accepted_population: 3,
    rejected_row_count: 0,
    ...overrides,
  }
}

function unavailableInput(): BuildLeaderboardAcquisitionManifestInput {
  const base = input()
  return {
    ...base,
    runner_git_sha: null,
    capture_evidence_state: 'unavailable',
    termination_reason: 'unknown',
    source_pages: base.source_pages.map((page) => ({
      ...page,
      request_sha256: null,
      http_status: null,
      pagination_position: null,
      source_reports: null,
    })),
  }
}

describe('leaderboard acquisition manifest', () => {
  it('builds a total-only Binance manifest without inventing a page-count report', () => {
    const built = buildLeaderboardAcquisitionManifest(input())

    expect(built.manifest.data_contract).toBe('arena.ingest.leaderboard-acquisition-manifest@1')
    expect(LEADERBOARD_ACQUISITION_MANIFEST_CONTRACT).toBe(
      'arena.ingest.leaderboard-acquisition-manifest@1'
    )
    expect(built.manifest).not.toHaveProperty('sourceRunId')
    expect(built.manifest).not.toHaveProperty('source_run_id')
    expect(built.manifest.population.reports).toEqual({
      population: { state: 'consistent', value: 3 },
      page_count: { state: 'unknown', value: null },
    })
    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'complete',
      population_state: 'verified',
    })
  })

  it('binds source pages and normalized parser inputs separately', () => {
    const original = buildLeaderboardAcquisitionManifest(input())
    const normalized = input({
      parse_pages: [
        {
          pageIndex: 1,
          payload: { normalized: ['one', 'two', 'three'] },
          url: 'https://example.test/derived/board',
          fetchedAt: '2026-07-21T10:00:02.000Z',
        },
      ],
    })
    const changed = buildLeaderboardAcquisitionManifest(normalized)

    expect(changed.manifest.source_pages.map((page) => page.payload.sha256)).toEqual(
      original.manifest.source_pages.map((page) => page.payload.sha256)
    )
    expect(changed.manifest.parser_input).not.toEqual(original.manifest.parser_input)
    expect(changed.sourceRunId).not.toBe(original.sourceRunId)
  })

  it('keeps page-count-only moving-board population unknown', () => {
    const web3 = input()
    web3.source = {
      ...web3.source,
      slug: 'binance_web3',
      adapter_slug: 'binance_web3',
    }
    web3.termination_reason = 'reported_page_count_reached'
    web3.source_pages = web3.source_pages.map((page) => ({
      ...page,
      source_reports: {
        population: notReported(),
        page_count: reported(2),
      },
    }))
    const built = buildLeaderboardAcquisitionManifest(web3)

    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'complete',
      population_state: 'unknown',
    })
    expect(built.manifest.population.reports.population).toEqual({
      state: 'unknown',
      value: null,
    })
  })

  it('rejects known continuation evidence for a short or total-reached claim', () => {
    const movingShort = input()
    movingShort.source = { ...movingShort.source, configured_page_size: 25 }
    movingShort.termination_reason = 'short_page'
    movingShort.source_pages = movingShort.source_pages.map((page, index) => ({
      ...page,
      source_row_count: index === 0 ? 25 : 23,
      source_reports: {
        population: notReported(),
        page_count: reported(9),
      },
    }))
    movingShort.accepted_population = 48
    expect(buildLeaderboardAcquisitionManifest(movingShort).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })

    const totalButMorePages = input()
    totalButMorePages.source_pages = totalButMorePages.source_pages.map((page) => ({
      ...page,
      source_reports: {
        population: reported(3),
        page_count: reported(3),
      },
    }))
    expect(buildLeaderboardAcquisitionManifest(totalButMorePages).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })

    const conflictingPageCounts = input({ termination_reason: 'short_page' })
    conflictingPageCounts.source_pages = conflictingPageCounts.source_pages.map((page, index) => ({
      ...page,
      source_reports: {
        population: reported(3),
        page_count: reported(index === 0 ? 2 : 3),
      },
    }))
    expect(buildLeaderboardAcquisitionManifest(conflictingPageCounts).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })

    const pastReportedEnd = input({ termination_reason: 'short_page' })
    pastReportedEnd.source_pages = pastReportedEnd.source_pages.map((page) => ({
      ...page,
      source_reports: {
        population: reported(3),
        page_count: reported(1),
      },
    }))
    expect(buildLeaderboardAcquisitionManifest(pastReportedEnd).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('forces both assessments unknown when capture evidence is unavailable', () => {
    const built = buildLeaderboardAcquisitionManifest(unavailableInput())

    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
    expect(built.manifest.population.reports).toEqual({
      population: { state: 'unknown', value: null },
      page_count: { state: 'unknown', value: null },
    })
  })

  it('requires capture metadata when verified and clears it when unavailable', () => {
    const missing = input()
    missing.source_pages[0] = { ...missing.source_pages[0], request_sha256: null }
    expect(() => buildLeaderboardAcquisitionManifest(missing)).toThrow(
      'verified capture evidence requires request, response, pagination, and report metadata'
    )

    const unavailable = unavailableInput()
    unavailable.source_pages[0] = { ...unavailable.source_pages[0], http_status: 200 }
    expect(() => buildLeaderboardAcquisitionManifest(unavailable)).toThrow(
      'unavailable capture evidence requires null capture metadata'
    )
  })

  it('supports an honestly reported empty board with pages=0', () => {
    const empty = input()
    empty.termination_reason = 'empty_page'
    empty.source_pages = [
      {
        ...empty.source_pages[0],
        raw_page: {
          ...empty.source_pages[0].raw_page,
          payload: { data: [], pages: 0, total: 0 },
        },
        source_row_count: 0,
        source_reports: {
          population: reported(0),
          page_count: reported(0),
        },
      },
    ]
    empty.parse_pages = [empty.source_pages[0].raw_page]
    empty.accepted_population = 0
    const built = buildLeaderboardAcquisitionManifest(empty)

    expect(built.manifest.population.reports.page_count).toEqual({
      state: 'consistent',
      value: 0,
    })
    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'complete',
      population_state: 'verified',
    })
  })

  it('validates a cursor chain without imposing numeric page indexes', () => {
    const cursor = input()
    cursor.source = {
      ...cursor.source,
      configured_page_size: null,
      configured_pagination_kind: 'api_cursor',
    }
    cursor.termination_reason = 'cursor_exhausted'
    cursor.source_pages = cursor.source_pages.map((page, index) => ({
      ...page,
      pagination_position:
        index === 0
          ? {
              kind: 'cursor' as const,
              request_cursor_sha256: null,
              response_next_cursor_sha256: CURSOR_SHA_1,
            }
          : {
              kind: 'cursor' as const,
              request_cursor_sha256: CURSOR_SHA_1,
              response_next_cursor_sha256: null,
            },
    }))
    expect(buildLeaderboardAcquisitionManifest(cursor).manifest.assessment).toEqual({
      acquisition_state: 'complete',
      population_state: 'verified',
    })

    const broken = JSON.parse(JSON.stringify(cursor)) as BuildLeaderboardAcquisitionManifestInput
    const position = broken.source_pages[1].pagination_position
    if (position?.kind !== 'cursor') throw new Error('bad test fixture')
    position.request_cursor_sha256 = REQUEST_SHA_2
    expect(() => buildLeaderboardAcquisitionManifest(broken)).toThrow(
      'cursor requests must bind the preceding response cursor'
    )
  })

  it('binds evidence position kind to source configuration and rejects cursor cycles', () => {
    const mismatched = input()
    mismatched.source_pages = mismatched.source_pages.map((page, index) => ({
      ...page,
      pagination_position:
        index === 0
          ? {
              kind: 'cursor' as const,
              request_cursor_sha256: null,
              response_next_cursor_sha256: CURSOR_SHA_1,
            }
          : {
              kind: 'cursor' as const,
              request_cursor_sha256: CURSOR_SHA_1,
              response_next_cursor_sha256: null,
            },
    }))
    expect(() => buildLeaderboardAcquisitionManifest(mismatched)).toThrow(
      'incompatible with configured kind numeric'
    )

    const cycle = input()
    cycle.source = { ...cycle.source, configured_pagination_kind: 'api_cursor' }
    cycle.termination_reason = 'cursor_exhausted'
    cycle.source_pages = [
      {
        ...cycle.source_pages[0],
        pagination_position: {
          kind: 'cursor',
          request_cursor_sha256: null,
          response_next_cursor_sha256: CURSOR_SHA_1,
        },
      },
      {
        ...cycle.source_pages[1],
        pagination_position: {
          kind: 'cursor',
          request_cursor_sha256: CURSOR_SHA_1,
          response_next_cursor_sha256: CURSOR_SHA_2,
        },
      },
      {
        ...cycle.source_pages[1],
        raw_page: {
          ...cycle.source_pages[1].raw_page,
          pageIndex: 3,
          url: 'https://example.test/board?cursor=e',
          fetchedAt: '2026-07-21T10:00:02.500Z',
        },
        source_row_count: 0,
        pagination_position: {
          kind: 'cursor',
          request_cursor_sha256: CURSOR_SHA_2,
          response_next_cursor_sha256: CURSOR_SHA_1,
        },
      },
    ]
    cycle.accepted_population = 3
    cycle.rejected_row_count = 0
    expect(() => buildLeaderboardAcquisitionManifest(cycle)).toThrow(
      'cursor responses must advance without cycles'
    )
  })

  it('does not accept a single snapshot contradicted by a multi-page report', () => {
    const single = input()
    single.source = {
      ...single.source,
      configured_page_size: null,
      configured_pagination_kind: null,
    }
    single.termination_reason = 'single_snapshot'
    single.source_pages = [
      {
        ...single.source_pages[0],
        pagination_position: { kind: 'single_snapshot' },
        source_reports: {
          population: reported(2),
          page_count: reported(2),
        },
      },
    ]
    single.parse_pages = [single.source_pages[0].raw_page]
    single.accepted_population = 2
    expect(buildLeaderboardAcquisitionManifest(single).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('fails closed before assigning partial states to capped runs', () => {
    const callerLimited = buildLeaderboardAcquisitionManifest(
      input({ termination_reason: 'caller_limit' })
    ).manifest
    expect(callerLimited.caller_limited).toBe(true)
    expect(callerLimited.safety_limited).toBe(false)
    expect(callerLimited.assessment).toEqual({
      acquisition_state: 'partial',
      population_state: 'partial',
    })

    const noRunner = input({ termination_reason: 'caller_limit', runner_git_sha: null })
    expect(buildLeaderboardAcquisitionManifest(noRunner).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })

    const failedHttp = input({ termination_reason: 'safety_limit' })
    failedHttp.source_pages[1] = { ...failedHttp.source_pages[1], http_status: 500 }
    const failed = buildLeaderboardAcquisitionManifest(failedHttp).manifest
    expect(failed.caller_limited).toBe(false)
    expect(failed.safety_limited).toBe(true)
    expect(failed.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('does not treat parser loss as a natural short or empty source page', () => {
    const parserLoss = input({ termination_reason: 'short_page' })
    parserLoss.source_pages[1] = {
      ...parserLoss.source_pages[1],
      source_row_count: 2,
      source_reports: {
        population: reported(4),
        page_count: notReported(),
      },
    }
    parserLoss.source_pages[0] = {
      ...parserLoss.source_pages[0],
      source_reports: {
        population: reported(4),
        page_count: notReported(),
      },
    }
    parserLoss.accepted_population = 3
    parserLoss.rejected_row_count = 1

    expect(buildLeaderboardAcquisitionManifest(parserLoss).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('keeps degenerate and upstream-error terminations unrankable', () => {
    expect(
      buildLeaderboardAcquisitionManifest(input({ termination_reason: 'degenerate_page' })).manifest
        .assessment
    ).toEqual({ acquisition_state: 'partial', population_state: 'unknown' })

    const upstreamError = input({ termination_reason: 'upstream_error' })
    upstreamError.source_pages[1] = { ...upstreamError.source_pages[1], http_status: 503 }
    expect(buildLeaderboardAcquisitionManifest(upstreamError).manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('derives conflicting reports and refuses to verify the population', () => {
    const conflicting = input()
    conflicting.source_pages[1] = {
      ...conflicting.source_pages[1],
      source_reports: {
        population: reported(4),
        page_count: notReported(),
      },
    }
    const built = buildLeaderboardAcquisitionManifest(conflicting)

    expect(built.manifest.population.reports.population).toEqual({
      state: 'conflicting',
      value: null,
    })
    expect(built.manifest.assessment).toEqual({
      acquisition_state: 'unknown',
      population_state: 'unknown',
    })
  })

  it('derives population rejection and deduplication from source-row counts', () => {
    const rejected = buildLeaderboardAcquisitionManifest(
      input({ accepted_population: 2, rejected_row_count: 1 })
    ).manifest
    expect(rejected.population).toMatchObject({
      observed_row_count: 3,
      accepted_population: 2,
      rejected_row_count: 1,
      deduplicated_row_count: 0,
    })
    expect(rejected.assessment).toEqual({
      acquisition_state: 'complete',
      population_state: 'partial',
    })

    const deduplicated = buildLeaderboardAcquisitionManifest(
      input({ accepted_population: 2, rejected_row_count: 0 })
    ).manifest
    expect(deduplicated.population.deduplicated_row_count).toBe(1)
    expect(deduplicated.assessment.population_state).toBe('partial')
  })

  it('rejects unsafe integers, negative zero, non-canonical timestamps, and lossy JSON', () => {
    expect(() => buildLeaderboardAcquisitionManifest(input({ accepted_population: -0 }))).toThrow(
      'negative zero'
    )
    expect(() =>
      buildLeaderboardAcquisitionManifest(
        input({ accepted_population: Number.MAX_SAFE_INTEGER + 1 })
      )
    ).toThrow('safe integer')
    expect(() =>
      buildLeaderboardAcquisitionManifest(input({ completed_at: '2026-07-21T10:00:03Z' }))
    ).toThrow('canonical ISO')

    const lossy = input()
    lossy.source_pages[0] = {
      ...lossy.source_pages[0],
      raw_page: { ...lossy.source_pages[0].raw_page, payload: { hidden: undefined } },
    }
    expect(() => buildLeaderboardAcquisitionManifest(lossy)).toThrow(
      'strict canonical JSON rejects undefined'
    )
  })

  it('rejects broken page order, timestamps, and population identities', () => {
    const pageGap = input()
    pageGap.source_pages[1] = {
      ...pageGap.source_pages[1],
      raw_page: { ...pageGap.source_pages[1].raw_page, pageIndex: 3 },
    }
    expect(() => buildLeaderboardAcquisitionManifest(pageGap)).toThrow(
      'stored page indexes must be contiguous from one'
    )

    const backwards = input()
    backwards.source_pages[1] = {
      ...backwards.source_pages[1],
      raw_page: {
        ...backwards.source_pages[1].raw_page,
        fetchedAt: '2026-07-21T09:59:59.000Z',
      },
    }
    expect(() => buildLeaderboardAcquisitionManifest(backwards)).toThrow(
      'page timestamp must fall inside the run'
    )

    expect(() =>
      buildLeaderboardAcquisitionManifest(input({ accepted_population: 3, rejected_row_count: 1 }))
    ).toThrow('cannot exceed observed_row_count')
  })

  it('rejects forged reports, limits, dedupe counts, and assessments on parse', () => {
    const manifest = buildLeaderboardAcquisitionManifest(input()).manifest
    const forgeries: unknown[] = [
      {
        ...manifest,
        population: {
          ...manifest.population,
          reports: {
            ...manifest.population.reports,
            population: { state: 'unknown', value: null },
          },
        },
      },
      { ...manifest, caller_limited: true },
      { ...manifest, safety_limited: true },
      {
        ...manifest,
        population: { ...manifest.population, deduplicated_row_count: 1 },
      },
      {
        ...manifest,
        assessment: { acquisition_state: 'partial', population_state: 'partial' },
      },
    ]

    for (const forgery of forgeries) {
      expect(() => parseLeaderboardAcquisitionManifest(forgery)).toThrow()
    }
  })

  it('rejects caller-supplied derived fields and malformed digests before building', () => {
    expect(() =>
      buildLeaderboardAcquisitionManifest({
        ...input(),
        caller_limited: false,
      } as BuildLeaderboardAcquisitionManifestInput)
    ).toThrow('Unrecognized key')

    const uppercase = input()
    uppercase.source_pages[0] = {
      ...uppercase.source_pages[0],
      request_sha256: 'A'.repeat(64),
    }
    expect(() => buildLeaderboardAcquisitionManifest(uppercase)).toThrow('lowercase SHA-256')
  })

  it('hashes the exact canonical manifest bytes and changes on evidence mutations', () => {
    const built = buildLeaderboardAcquisitionManifest(input())
    const byteHash = createHash('sha256').update(built.canonicalJson, 'utf8').digest('hex')
    expect(built.sourceRunId).toBe(byteHash)
    expect(JSON.parse(built.canonicalJson)).toEqual(built.manifest)

    const mutations: BuildLeaderboardAcquisitionManifestInput[] = [
      input({ source: { ...input().source, slug: 'binance_spot' } }),
      (() => {
        const changed = input()
        changed.source_pages[0] = { ...changed.source_pages[0], http_status: 201 }
        return changed
      })(),
      input({ termination_reason: 'caller_limit' }),
    ]
    for (const mutation of mutations) {
      expect(buildLeaderboardAcquisitionManifest(mutation).sourceRunId).not.toBe(built.sourceRunId)
    }
  })

  it('pins the complete v1 manifest contract to a golden sourceRunId', () => {
    expect(buildLeaderboardAcquisitionManifest(input()).sourceRunId).toBe(
      'bf7864ef31c7e535854130e87f64da0dd15b19e2b8d67b171e7d2491399eb5c3'
    )
  })
})
