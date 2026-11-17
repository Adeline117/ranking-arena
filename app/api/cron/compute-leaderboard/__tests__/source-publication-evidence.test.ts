/**
 * @jest-environment node
 */

import {
  SourcePublicationEvidenceError,
  buildSourcePublicationRows,
  lacksRequiredMetricEvidence,
  parseSourcePublicationEvidence,
  type SourcePublicationEvidenceErrorCode,
} from '../source-publication-evidence'

const NOW = new Date('2026-07-22T00:00:00.000Z')
const PUBLISH_ID = 'A1111111-1111-4111-8111-111111111111'

function scoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'alpha',
    market_type: 'futures',
    trader_key: 'trader-1',
    board_rank: 1,
    roi_pct: 12.5,
    pnl_usd: 250,
    win_rate: 60,
    max_drawdown: 8,
    copiers: 4,
    trades_count: 20,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    volatility_pct: 15,
    trader_kind: null,
    handle: 'Alpha',
    avatar_url: null,
    currency: 'USDT',
    as_of: '2026-07-21T22:30:00.000Z',
    board_as_of: '2026-07-21T23:00:00.000Z',
    ...overrides,
  }
}

function physicalBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry_slug: 'alpha-futures',
    filter_source: 'alpha',
    window: '30D',
    snapshot_id: 101,
    scraped_at: '2026-07-21T23:00:00.000Z',
    actual_count: 1,
    entry_count: 1,
    rank_limit: 1000,
    rank_limited_entry_count: 1,
    evidence_status: 'passed',
    latest_passed_tie_count: 1,
    latest_attempt_id: 101,
    latest_attempt_scraped_at: '2026-07-21T23:00:00.000Z',
    latest_attempt_passed: true,
    ...overrides,
  }
}

function parse(
  physicalBoards: Record<string, unknown>[],
  scoreRows: Record<string, unknown>[] = []
) {
  return parseSourcePublicationEvidence(
    { scoreRows, physicalBoards },
    { window: '30D', rankLimit: 1000, now: NOW, maxAgeHours: 48 }
  )
}

function captureError(
  operation: () => unknown,
  expectedCode: SourcePublicationEvidenceErrorCode
): SourcePublicationEvidenceError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(SourcePublicationEvidenceError)
    expect((error as SourcePublicationEvidenceError).code).toBe(expectedCode)
    return error as SourcePublicationEvidenceError
  }
  throw new Error(`expected SourcePublicationEvidenceError(${expectedCode})`)
}

describe('source publication evidence', () => {
  it('sums every shared physical board at MIN(scraped_at) and builds stable rows', () => {
    const parsed = parse(
      [
        physicalBoard({
          registry_slug: 'shared-z',
          filter_source: 'shared',
          snapshot_id: 202,
          actual_count: 1,
          entry_count: 1,
          latest_attempt_id: 202,
        }),
        physicalBoard({
          registry_slug: 'shared-a',
          filter_source: 'shared',
          snapshot_id: 201,
          scraped_at: '2026-07-21T22:00:00.123456Z',
          actual_count: 2,
          entry_count: 2,
          latest_attempt_id: 201,
          latest_attempt_scraped_at: '2026-07-21T22:00:00.123456Z',
        }),
      ],
      [
        scoreRow({
          platform: 'shared',
          board_as_of: '2026-07-21T22:00:00.123456Z',
        }),
        scoreRow({
          platform: 'shared',
          trader_key: 'trader-2',
          board_rank: 2,
          board_as_of: '2026-07-21T22:00:00.123456Z',
        }),
      ]
    )

    expect(parsed.freshAliases).toEqual([
      expect.objectContaining({
        source: 'shared',
        source_as_of: '2026-07-21T22:00:00.123456Z',
        raw_actual_count: 3,
        rank_limited_entry_count: 2,
        score_row_count: 2,
        registry_slugs: ['shared-a', 'shared-z'],
        snapshot_ids: [201, 202],
      }),
    ])

    expect(
      buildSourcePublicationRows(parsed, {
        publishId: PUBLISH_ID,
        finalRankCounts: new Map([['shared', 2]]),
      })
    ).toEqual([
      {
        source: 'shared',
        source_as_of: '2026-07-21T22:00:00.123456Z',
        published_rank_count: 2,
        score_cohort_id: PUBLISH_ID.toLowerCase(),
        registry_slugs: ['shared-a', 'shared-z'],
        snapshot_ids: [201, 202],
      },
    ])
  })

  it('keeps a shared alias on the old board when any physical member is missing', () => {
    const parsed = parse(
      [
        physicalBoard({ registry_slug: 'shared-live', filter_source: 'shared' }),
        physicalBoard({
          registry_slug: 'shared-missing',
          filter_source: 'shared',
          snapshot_id: null,
          scraped_at: null,
          actual_count: null,
          entry_count: null,
          rank_limited_entry_count: null,
          evidence_status: 'missing',
          latest_passed_tie_count: 0,
          latest_attempt_id: null,
          latest_attempt_scraped_at: null,
          latest_attempt_passed: null,
        }),
      ],
      [scoreRow({ platform: 'shared' })]
    )

    expect(parsed.freshAliases).toEqual([])
    expect(parsed.scoreRows).toHaveLength(1)
    expect(parsed.freshScoreRows).toEqual([])
    expect(parsed.retainedAliases).toEqual([
      expect.objectContaining({
        source: 'shared',
        state: 'retain',
        denial_reasons: ['missing'],
        registry_slugs: ['shared-live', 'shared-missing'],
      }),
    ])
    expect(
      buildSourcePublicationRows(parsed, {
        publishId: PUBLISH_ID,
        finalRankCounts: new Map(),
      })
    ).toEqual([])
    captureError(
      () =>
        buildSourcePublicationRows(parsed, {
          publishId: PUBLISH_ID,
          finalRankCounts: new Map([['shared', 9]]),
        }),
      'retained_rank_count'
    )
  })

  it('classifies failed, future, stale, and mismatched aliases without blocking fresh peers', () => {
    const parsed = parse(
      [
        physicalBoard(),
        physicalBoard({
          registry_slug: 'failed-board',
          filter_source: 'failed',
          snapshot_id: null,
          scraped_at: null,
          actual_count: null,
          entry_count: null,
          rank_limited_entry_count: null,
          evidence_status: 'failed',
          latest_passed_tie_count: 0,
          latest_attempt_id: 202,
          latest_attempt_scraped_at: '2026-07-21T23:30:00.000Z',
          latest_attempt_passed: false,
        }),
        physicalBoard({
          registry_slug: 'future-board',
          filter_source: 'future',
          snapshot_id: 203,
          scraped_at: '2026-07-22T00:05:00.000001Z',
          evidence_status: 'future',
          latest_attempt_id: 203,
          latest_attempt_scraped_at: '2026-07-22T00:05:00.000001Z',
        }),
        physicalBoard({
          registry_slug: 'stale-board',
          filter_source: 'stale',
          snapshot_id: 204,
          scraped_at: '2026-07-20T00:00:00.000Z',
          evidence_status: 'stale',
          latest_attempt_id: 204,
          latest_attempt_scraped_at: '2026-07-20T00:00:00.000Z',
        }),
        physicalBoard({
          registry_slug: 'mismatch-board',
          filter_source: 'mismatch',
          snapshot_id: 205,
          actual_count: 2,
          entry_count: 1,
          evidence_status: 'entry_count_mismatch',
          latest_attempt_id: 205,
        }),
      ],
      [scoreRow()]
    )

    expect(parsed.freshAliases.map((alias) => alias.source)).toEqual(['alpha'])
    expect(
      Object.fromEntries(
        parsed.retainedAliases.map((alias) => [alias.source, alias.denial_reasons])
      )
    ).toEqual({
      failed: ['failed'],
      future: ['future'],
      mismatch: ['count_mismatch'],
      stale: ['stale'],
    })
    expect(parsed.freshScoreRows.map((row) => row.platform)).toEqual(['alpha'])
  })

  it('retains a recent last-good PASSED board when a later attempt failed', () => {
    const parsed = parse(
      [
        physicalBoard({
          snapshot_id: 301,
          scraped_at: '2026-07-21T22:00:00.000Z',
          latest_attempt_id: 302,
          latest_attempt_scraped_at: '2026-07-21T23:30:00.000Z',
          latest_attempt_passed: false,
          evidence_status: 'latest_attempt_failed',
        }),
      ],
      [scoreRow({ board_as_of: '2026-07-21T22:00:00.000Z' })]
    )

    expect(parsed.freshAliases).toEqual([])
    expect(parsed.retainedAliases).toEqual([
      expect.objectContaining({
        source: 'alpha',
        snapshot_ids: [301],
        denial_reasons: ['latest_attempt_failed'],
      }),
    ])
  })

  it('retains an ambiguous latest PASSED snapshot tie without applying a score-count gate', () => {
    const parsed = parse(
      [
        physicalBoard({
          evidence_status: 'ambiguous_latest',
          latest_passed_tie_count: 2,
          rank_limited_entry_count: 7,
          actual_count: 7,
          entry_count: 7,
        }),
      ],
      [scoreRow()]
    )

    expect(parsed.freshAliases).toEqual([])
    expect(parsed.retainedAliases).toEqual([
      expect.objectContaining({
        source: 'alpha',
        rank_limited_entry_count: 7,
        score_row_count: 1,
        denial_reasons: ['ambiguous_latest'],
      }),
    ])
  })

  it('uses tie-first status while retaining both ambiguous and later-failed diagnostics', () => {
    const parsed = parse(
      [
        physicalBoard({
          snapshot_id: 301,
          scraped_at: '2026-07-21T22:00:00.000Z',
          evidence_status: 'ambiguous_latest',
          latest_passed_tie_count: 2,
          latest_attempt_id: 302,
          latest_attempt_scraped_at: '2026-07-21T23:30:00.000Z',
          latest_attempt_passed: false,
        }),
      ],
      [scoreRow({ board_as_of: '2026-07-21T22:00:00.000Z' })]
    )

    expect(parsed.retainedAliases).toEqual([
      expect.objectContaining({
        source: 'alpha',
        denial_reasons: ['ambiguous_latest', 'latest_attempt_failed'],
      }),
    ])

    captureError(
      () =>
        parse([
          physicalBoard({
            evidence_status: 'latest_attempt_failed',
            latest_passed_tie_count: 2,
            latest_attempt_id: 302,
            latest_attempt_scraped_at: '2026-07-21T23:30:00.000Z',
            latest_attempt_passed: false,
          }),
        ]),
      'invalid_bundle'
    )
  })

  it('accepts a real rank-gap board only when score rows equal the rank-limited count', () => {
    const rankLimitedRows = Array.from({ length: 925 }, (_, index) =>
      scoreRow({
        trader_key: `rank-gap-${index + 1}`,
        board_rank: index === 924 ? 1000 : index + 1,
      })
    )
    const board = physicalBoard({
      actual_count: 1588,
      entry_count: 1588,
      rank_limited_entry_count: 925,
    })

    const parsed = parse([board], rankLimitedRows)
    expect(parsed.freshAliases).toEqual([
      expect.objectContaining({
        source: 'alpha',
        raw_actual_count: 1588,
        rank_limited_entry_count: 925,
        score_row_count: 925,
      }),
    ])

    captureError(() => parse([board], rankLimitedRows.slice(0, -1)), 'query_omission')
  })

  it('rejects extra score rows not covered by the exact rank-limited physical count', () => {
    captureError(
      () =>
        parse(
          [physicalBoard({ actual_count: 2, entry_count: 2 })],
          [scoreRow(), scoreRow({ trader_key: 'boardless-extra' })]
        ),
      'query_omission'
    )
  })

  it('binds every physical board to the requested rank limit', () => {
    const error = captureError(
      () => parse([physicalBoard({ rank_limit: 999 })], [scoreRow()]),
      'invalid_count'
    )
    expect(error.message).toContain('rank_limit=999')
    expect(error.message).toContain('expected 1000')
  })

  it.each([
    ['snapshot without rank-limited count', physicalBoard({ rank_limited_entry_count: null })],
    ['snapshot without a PASSED tie', physicalBoard({ latest_passed_tie_count: 0 })],
    [
      'missing snapshot with rank-limited count',
      physicalBoard({
        snapshot_id: null,
        scraped_at: null,
        actual_count: null,
        entry_count: null,
        evidence_status: 'missing',
        latest_attempt_id: null,
        latest_attempt_scraped_at: null,
        latest_attempt_passed: null,
        latest_passed_tie_count: 0,
      }),
    ],
    [
      'missing snapshot with a PASSED tie',
      physicalBoard({
        snapshot_id: null,
        scraped_at: null,
        actual_count: null,
        entry_count: null,
        rank_limited_entry_count: null,
        evidence_status: 'missing',
        latest_attempt_id: null,
        latest_attempt_scraped_at: null,
        latest_attempt_passed: null,
        latest_passed_tie_count: 1,
      }),
    ],
  ])('rejects %s', (_label, board) => {
    captureError(() => parse([board]), 'invalid_bundle')
  })

  it('rejects incoherent latest-attempt diagnostics', () => {
    captureError(
      () =>
        parse([
          physicalBoard({
            latest_attempt_id: 102,
          }),
        ]),
      'invalid_bundle'
    )

    captureError(
      () =>
        parse([
          physicalBoard({
            snapshot_id: 301,
            scraped_at: '2026-07-21T23:00:00.000Z',
            latest_attempt_id: 302,
            latest_attempt_scraped_at: '2026-07-21T22:59:59.999999Z',
            latest_attempt_passed: false,
          }),
        ]),
      'invalid_bundle'
    )

    captureError(
      () =>
        parse([
          physicalBoard({
            snapshot_id: 301,
            scraped_at: '2026-07-21T23:00:00.000Z',
            evidence_status: 'latest_attempt_failed',
            latest_attempt_id: 301,
            latest_attempt_scraped_at: '2026-07-21T23:00:00.000Z',
            latest_attempt_passed: false,
          }),
        ]),
      'invalid_bundle'
    )

    expect(
      parse(
        [
          physicalBoard({
            snapshot_id: 301,
            scraped_at: '2026-07-21T23:00:00.000Z',
            evidence_status: 'latest_attempt_failed',
            latest_attempt_id: 302,
            latest_attempt_scraped_at: '2026-07-21T23:00:00.000Z',
            latest_attempt_passed: false,
          }),
        ],
        [scoreRow()]
      ).retainedAliases[0]
    ).toEqual(expect.objectContaining({ denial_reasons: ['latest_attempt_failed'] }))
  })

  it('accepts exactly five minutes of clock skew but not one microsecond more', () => {
    expect(
      parse(
        [
          physicalBoard({
            scraped_at: '2026-07-22T00:05:00.000000Z',
            latest_attempt_scraped_at: '2026-07-22T00:05:00.000000Z',
          }),
        ],
        [
          scoreRow({
            as_of: '2026-07-22T00:00:00.000Z',
            board_as_of: '2026-07-22T00:05:00.000000Z',
          }),
        ]
      ).freshAliases
    ).toHaveLength(1)

    const future = parse([
      physicalBoard({
        scraped_at: '2026-07-22T00:05:00.000001Z',
        latest_attempt_scraped_at: '2026-07-22T00:05:00.000001Z',
      }),
    ])
    expect(future.retainedAliases[0]).toEqual(
      expect.objectContaining({ denial_reasons: ['future'] })
    )
  })

  it('requires score observations to be strictly newer than the max-age cutoff', () => {
    captureError(
      () => parse([physicalBoard()], [scoreRow({ as_of: '2026-07-20T00:00:00.000000Z' })]),
      'invalid_timestamp'
    )

    expect(
      parse([physicalBoard()], [scoreRow({ as_of: '2026-07-20T00:00:00.000001Z' })]).freshScoreRows
    ).toHaveLength(1)
  })

  it('rejects duplicate physical identities and unknown or empty aliases', () => {
    captureError(
      () => parse([physicalBoard(), physicalBoard({ snapshot_id: 102, latest_attempt_id: 102 })]),
      'duplicate_registry_slug'
    )

    captureError(
      () => parse([physicalBoard()], [scoreRow({ platform: 'unknown-source' })]),
      'unknown_alias'
    )

    captureError(() => parse([physicalBoard({ filter_source: '' })]), 'invalid_bundle')
  })

  it('rejects completely identical score identities', () => {
    const duplicate = scoreRow()
    const error = captureError(
      () =>
        parse([physicalBoard({ actual_count: 2, entry_count: 2 })], [duplicate, { ...duplicate }]),
      'duplicate_score_identity'
    )

    expect(error.message).toContain('platform=alpha')
    expect(error.message).toContain('trader_key=trader-1')
  })

  it('rejects duplicate identities with complementary null metrics', () => {
    captureError(
      () =>
        parse(
          [physicalBoard({ actual_count: 2, entry_count: 2 })],
          [scoreRow({ roi_pct: 12.5, pnl_usd: null }), scoreRow({ roi_pct: null, pnl_usd: 250 })]
        ),
      'duplicate_score_identity'
    )
  })

  it('rejects case-variant EVM identities before complementary metrics can merge', () => {
    const error = captureError(
      () =>
        parse(
          [physicalBoard({ actual_count: 2, entry_count: 2, rank_limited_entry_count: 2 })],
          [
            scoreRow({ trader_key: '0xAbC', roi_pct: 12.5, pnl_usd: null }),
            scoreRow({ trader_key: '0xabc', roi_pct: null, pnl_usd: 250 }),
          ]
        ),
      'duplicate_score_identity'
    )

    expect(error.message).toContain('trader_key=0xabc')
  })

  it('rejects first-party score rows without a physical board rank', () => {
    const error = captureError(
      () => parse([physicalBoard()], [scoreRow({ board_rank: null })]),
      'unattested_first_party_input'
    )
    expect(error.message).toContain('platform=alpha')
    expect(error.message).toContain('trader_key=trader-1')
  })

  it('carries the evidence-refused metrics of each score row and rejects unknown names', () => {
    const parsed = parse(
      [physicalBoard()],
      [scoreRow({ win_rate: null, unevidenced_metrics: ['win_rate', 'sharpe_ratio'] })]
    )
    expect(parsed.scoreRows[0].unevidenced_metrics).toEqual(['win_rate', 'sharpe_ratio'])
    expect(lacksRequiredMetricEvidence(parsed.scoreRows[0])).toBe(true)

    // Optional-only refusal, a present value, and a pre-evidence bundle row
    // (no key) are all rankable on evidence grounds.
    const optionalOnly = parse(
      [physicalBoard()],
      [scoreRow({ sharpe_ratio: null, unevidenced_metrics: ['sharpe_ratio'] })]
    )
    expect(lacksRequiredMetricEvidence(optionalOnly.scoreRows[0])).toBe(false)
    const legacy = parse([physicalBoard()], [scoreRow()])
    expect(lacksRequiredMetricEvidence(legacy.scoreRows[0])).toBe(false)

    captureError(
      () => parse([physicalBoard()], [scoreRow({ unevidenced_metrics: ['arena_score'] })]),
      'invalid_bundle'
    )
  })

  it('accepts the same trader key on different platforms', () => {
    const parsed = parse(
      [
        physicalBoard(),
        physicalBoard({
          registry_slug: 'beta-futures',
          filter_source: 'beta',
          snapshot_id: 102,
          latest_attempt_id: 102,
        }),
      ],
      [scoreRow(), scoreRow({ platform: 'beta' })]
    )

    expect(parsed.freshScoreRows.map(({ platform, trader_key }) => [platform, trader_key])).toEqual(
      [
        ['alpha', 'trader-1'],
        ['beta', 'trader-1'],
      ]
    )
  })

  it('rejects a score-row watermark that differs from the physical alias MIN', () => {
    const error = captureError(
      () => parse([physicalBoard()], [scoreRow({ board_as_of: '2026-07-21T22:59:59Z' })]),
      'watermark_mismatch'
    )
    expect(error.message).toContain('MIN watermark')
  })

  it.each([
    ['wrong window', physicalBoard({ window: '7D' }), 'invalid_window'],
    ['negative count', physicalBoard({ actual_count: -1 }), 'invalid_bundle'],
    ['fractional count', physicalBoard({ entry_count: 0.5 }), 'invalid_bundle'],
    ['invalid board timestamp', physicalBoard({ scraped_at: 'yesterday' }), 'invalid_timestamp'],
  ] as const)('rejects %s', (_label, board, code) => {
    captureError(() => parse([board]), code)
  })

  it('strictly rejects malformed score timestamps and extra bundle fields', () => {
    captureError(
      () => parse([physicalBoard()], [scoreRow({ as_of: '2026-02-30T00:00:00Z' })]),
      'invalid_timestamp'
    )
    captureError(
      () =>
        parseSourcePublicationEvidence(
          { scoreRows: [], physicalBoards: [physicalBoard()], unexpected: true },
          { window: '30D', rankLimit: 1000, now: NOW }
        ),
      'invalid_bundle'
    )
  })

  it('distinguishes an explicitly empty board from query omission', () => {
    const empty = parse([
      physicalBoard({ actual_count: 0, entry_count: 0, rank_limited_entry_count: 0 }),
    ])
    expect(empty.freshAliases[0]).toEqual(
      expect.objectContaining({ explicit_empty: true, raw_actual_count: 0, score_row_count: 0 })
    )
    expect(
      buildSourcePublicationRows(empty, {
        publishId: PUBLISH_ID,
        finalRankCounts: new Map([['alpha', 0]]),
      })[0]
    ).toEqual(expect.objectContaining({ source: 'alpha', published_rank_count: 0 }))

    captureError(
      () => parse([physicalBoard({ actual_count: 2, entry_count: 2 })]),
      'query_omission'
    )
  })

  it('sorts publication rows by alias regardless of physical or count-map order', () => {
    const parsed = parse([
      physicalBoard({
        registry_slug: 'zeta-board',
        filter_source: 'zeta',
        snapshot_id: 402,
        actual_count: 0,
        entry_count: 0,
        rank_limited_entry_count: 0,
        latest_attempt_id: 402,
      }),
      physicalBoard({
        registry_slug: 'alpha-board',
        snapshot_id: 401,
        actual_count: 0,
        entry_count: 0,
        rank_limited_entry_count: 0,
        latest_attempt_id: 401,
      }),
    ])

    expect(
      buildSourcePublicationRows(parsed, {
        publishId: PUBLISH_ID,
        finalRankCounts: new Map([
          ['zeta', 0],
          ['alpha', 0],
        ]),
      }).map((row) => row.source)
    ).toEqual(['alpha', 'zeta'])
  })

  it('fails closed when final counts omit a fresh source', () => {
    const parsed = parse([physicalBoard()], [scoreRow()])
    captureError(
      () =>
        buildSourcePublicationRows(parsed, {
          publishId: PUBLISH_ID,
          finalRankCounts: new Map(),
        }),
      'missing_rank_count'
    )
  })

  it('allows complete non-empty input to publish zero ranks when every row is ineligible', () => {
    const parsed = parse([physicalBoard()], [scoreRow({ pnl_usd: null })])

    expect(
      buildSourcePublicationRows(parsed, {
        publishId: PUBLISH_ID,
        finalRankCounts: new Map([['alpha', 0]]),
      })
    ).toEqual([
      expect.objectContaining({
        source: 'alpha',
        published_rank_count: 0,
        snapshot_ids: [101],
      }),
    ])
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid final rank count %s',
    (count) => {
      const parsed = parse([physicalBoard()], [scoreRow()])
      captureError(
        () =>
          buildSourcePublicationRows(parsed, {
            publishId: PUBLISH_ID,
            finalRankCounts: new Map([['alpha', count]]),
          }),
        'invalid_count'
      )
    }
  )

  it('rejects count expansion from raw rows through final publication', () => {
    captureError(
      () =>
        parse(
          [physicalBoard()],
          [scoreRow(), scoreRow({ trader_key: 'duplicate-or-forged-trader' })]
        ),
      'unsafe_count_expansion'
    )

    const parsed = parse([physicalBoard()], [scoreRow()])
    captureError(
      () =>
        buildSourcePublicationRows(parsed, {
          publishId: PUBLISH_ID,
          finalRankCounts: new Map([['alpha', 2]]),
        }),
      'unsafe_count_expansion'
    )
  })

  it('rejects nonzero ranks for an explicitly empty board and unknown count aliases', () => {
    const empty = parse([
      physicalBoard({ actual_count: 0, entry_count: 0, rank_limited_entry_count: 0 }),
    ])
    captureError(
      () =>
        buildSourcePublicationRows(empty, {
          publishId: PUBLISH_ID,
          finalRankCounts: new Map([['alpha', 1]]),
        }),
      'unsafe_empty_publication'
    )
    captureError(
      () =>
        buildSourcePublicationRows(empty, {
          publishId: PUBLISH_ID,
          finalRankCounts: new Map([
            ['alpha', 0],
            ['ghost', 0],
          ]),
        }),
      'unknown_alias'
    )
    captureError(
      () =>
        buildSourcePublicationRows(empty, {
          publishId: 'not-a-uuid',
          finalRankCounts: new Map([['alpha', 0]]),
        }),
      'invalid_publish_id'
    )
  })
})
