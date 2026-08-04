import type { RawPage, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import {
  supportsSourceSurface,
  UnsupportedSourceSurfaceError,
} from '../../../core/surface-capabilities'
import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  captureHistoryAcquisition,
  type HistoryTerminalClaim,
} from '../../../history-acquisition'
import { okxAdapter } from '../index'

const UNIQUE_CODE = 'F503A5D5F1F6989F'
const HISTORY_FETCHED_AT = '2026-08-03T10:00:00.000Z'
const HISTORY_CLOSE_TIME = Date.parse('2026-08-03T09:00:00.000Z')

function source(productType: 'spot' | 'futures', instType: string): SourceRow {
  return {
    id: productType === 'spot' ? 35 : 34,
    slug: productType === 'spot' ? 'okx_spot' : 'okx_futures',
    exchange_id: 9,
    product_type: productType,
    trader_kind_scope: 'human',
    adapter_slug: 'okx',
    leaderboard_url: null,
    timeframes_native: [90],
    timeframes_derived: [7, 30],
    tf_label_map: {},
    expected_count: 200,
    deep_profile_topn: 100,
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
    rate_budget_ms: 500,
    phase: 3,
    serving_mode: 'serving',
    status: 'active',
    meta: { inst_type: instType },
  }
}

function session(): FetchSession {
  return {
    sourceSlug: 'okx',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function ok(data: unknown[] = []): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: '0', data, msg: '' }),
  } as Response
}

function historyVerifier(src: SourceRow) {
  const verifier = okxAdapter.historyTerminalVerifier?.(src, 'position_history')
  if (!verifier) throw new Error('expected the reviewed OKX position-history verifier')
  return verifier
}

function positionHistoryRow(subPosId: string, closeTime = HISTORY_CLOSE_TIME) {
  return {
    ccy: 'USDT',
    subPosId,
    instId: 'BTC-USDT-SWAP',
    instType: 'SWAP',
    openTime: String(closeTime - 60_000),
    closeTime: String(closeTime),
    posSide: 'long',
    uniqueCode: UNIQUE_CODE,
  }
}

function partialPositionHistoryRow(subPosId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...positionHistoryRow(subPosId),
    closeTime: '',
    ...overrides,
  }
}

function historyPage(
  pageIndex: number,
  data: unknown[],
  after: string | null = null,
  fetchedAt = HISTORY_FETCHED_AT
): RawPage {
  return {
    pageIndex,
    payload: { data, historyTraderIdentity: UNIQUE_CODE },
    url:
      'https://www.okx.com/api/v5/copytrading/public-subpositions-history' +
      `?instType=SWAP&uniqueCode=${UNIQUE_CODE}&limit=100` +
      (after === null ? '' : `&after=${encodeURIComponent(after)}`),
    fetchedAt,
  }
}

function verifyExhaustion(pages: RawPage[]) {
  const futures = source('futures', 'SWAP')
  return historyVerifier(futures).verify({
    claim: {
      contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
      observations: [{ segment_id: 'default', reason: 'empty_page', page_ordinal: pages.length }],
    },
    pages,
    cursor: null,
    source: futures,
    traderId: 99,
    exchangeTraderId: UNIQUE_CODE,
    kind: 'position_history',
  })
}

describe('OKX product-specific record contracts', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('declares SPOT record surfaces unsupported while keeping profile support', () => {
    const spot = source('spot', 'SPOT')

    expect(supportsSourceSurface(okxAdapter, spot, 'profile')).toBe(true)
    expect(supportsSourceSurface(okxAdapter, spot, 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, spot, 'positionHistory')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, spot, 'copiers')).toBe(false)
    expect(okxAdapter.historyTerminalVerifier?.(spot, 'position_history')).toBeNull()
  })

  it('selects terminal verification only for the reviewed production endpoint', () => {
    const futures = source('futures', 'SWAP')
    expect(okxAdapter.historyTerminalVerifier?.(futures, 'position_history')).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.okx.position_history@2',
    })
    expect(okxAdapter.historyTerminalVerifier?.(futures, 'orders')).toBeNull()
    expect(
      okxAdapter.historyTerminalVerifier?.(
        {
          ...futures,
          meta: { ...futures.meta, endpoints: { base: 'https://proxy.example.test' } },
        },
        'position_history'
      )
    ).toBeNull()
  })

  it('requires both the futures product dimension and SWAP instType', () => {
    expect(supportsSourceSurface(okxAdapter, source('spot', 'SWAP'), 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, source('futures', 'SPOT'), 'positions')).toBe(false)
    expect(supportsSourceSurface(okxAdapter, source('futures', 'SWAP'), 'positions')).toBe(true)
  })

  it('fails closed before HTTP when a SPOT caller requests record surfaces', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch
    const spot = source('spot', 'SPOT')

    await expect(okxAdapter.getPositions(session(), spot, UNIQUE_CODE)).rejects.toBeInstanceOf(
      UnsupportedSourceSurfaceError
    )
    await expect(
      okxAdapter.getHistory(session(), spot, UNIQUE_CODE, 'position_history', null).next()
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE_SURFACE',
      sourceSlug: 'okx_spot',
      surface: 'positionHistory',
    })
    await expect(
      okxAdapter.getHistory(session(), spot, UNIQUE_CODE, 'copiers', null).next()
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE_SURFACE',
      sourceSlug: 'okx_spot',
      surface: 'copiers',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('keeps SPOT profile requests on the explicit SPOT identity surface', async () => {
    const urls: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok()
    }) as unknown as typeof fetch

    await expect(
      okxAdapter.getProfile(session(), source('spot', 'SPOT'), UNIQUE_CODE, 90, null, {
        intent: 'scheduled_full',
      })
    ).resolves.toMatchObject({ pages: [{ payload: { timeframe: 90 } }] })

    expect(urls).toHaveLength(3)
    expect(urls.every((url) => url.includes('instType=SPOT'))).toBe(true)
    expect(urls.every((url) => url.includes(`uniqueCode=${UNIQUE_CODE}`))).toBe(true)
  })

  it('uses explicit SWAP on supported record requests', async () => {
    const urls: string[] = []
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok()
    }) as unknown as typeof fetch
    const futures = source('futures', 'SWAP')

    await okxAdapter.getPositions(session(), futures, UNIQUE_CODE)
    for await (const _page of okxAdapter.getHistory(
      session(),
      futures,
      UNIQUE_CODE,
      'position_history',
      null
    )) {
      // Empty response intentionally ends pagination.
    }
    for await (const _page of okxAdapter.getHistory(
      session(),
      futures,
      UNIQUE_CODE,
      'copiers',
      null
    )) {
      // One empty copier envelope is still a replayable page.
    }

    expect(urls).toEqual([
      expect.stringContaining(
        `public-current-subpositions?instType=SWAP&uniqueCode=${UNIQUE_CODE}`
      ),
      expect.stringContaining(
        `public-subpositions-history?instType=SWAP&uniqueCode=${UNIQUE_CODE}&limit=100`
      ),
      expect.stringContaining(`public-copy-traders?instType=SWAP&uniqueCode=${UNIQUE_CODE}`),
    ])
  })

  it('compares a stored close cursor with closeTime, not openTime', async () => {
    const urls: string[] = []
    const cursor = Date.parse('2026-07-01T00:00:00.000Z')
    const pages = [
      [
        {
          ...positionHistoryRow('newer-close', Date.parse('2026-07-10T00:00:00.000Z')),
          openTime: String(Date.parse('2026-06-01T00:00:00.000Z')),
        },
      ],
      [
        {
          ...positionHistoryRow('cursor-overlap', Date.parse('2026-06-30T00:00:00.000Z')),
          openTime: String(Date.parse('2026-05-01T00:00:00.000Z')),
        },
      ],
    ]
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return ok(pages[urls.length - 1] ?? [])
    }) as unknown as typeof fetch

    const futures = source('futures', 'SWAP')
    const acquisition = await captureHistoryAcquisition({
      source: futures,
      traderId: 99,
      exchangeTraderId: UNIQUE_CODE,
      kind: 'position_history',
      cursor: new Date(cursor).toISOString(),
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: okxAdapter.getHistory(
        session(),
        futures,
        UNIQUE_CODE,
        'position_history',
        new Date(cursor).toISOString()
      ),
      terminalVerifier: historyVerifier(futures),
    })

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages[0].payload).toMatchObject({ historyTraderIdentity: UNIQUE_CODE })
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'cursor_overlap',
      overlap_event_at: '2026-06-30T00:00:00.000Z',
    })
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('after=newer-close')
  })

  it('captures the terminal empty response and verifies exhaustion', async () => {
    global.fetch = jest.fn(async () => ok()) as unknown as typeof fetch
    const futures = source('futures', 'SWAP')

    const acquisition = await captureHistoryAcquisition({
      source: futures,
      traderId: 99,
      exchangeTraderId: UNIQUE_CODE,
      kind: 'position_history',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: okxAdapter.getHistory(session(), futures, UNIQUE_CODE, 'position_history', null),
      terminalVerifier: historyVerifier(futures),
    })

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0].payload).toEqual({
      data: [],
      historyTraderIdentity: UNIQUE_CODE,
    })
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
  })

  it('accepts a row-complete, unique and monotonic multi-page exhaustion proof', () => {
    expect(
      verifyExhaustion([
        historyPage(1, [
          positionHistoryRow('newest-row'),
          positionHistoryRow('continuation-row', HISTORY_CLOSE_TIME - 1_000),
        ]),
        historyPage(
          2,
          [positionHistoryRow('oldest-row', HISTORY_CLOSE_TIME - 2_000)],
          'continuation-row'
        ),
        historyPage(3, [], 'oldest-row'),
      ])
    ).toEqual({ verified: true, scanTerminalState: 'exhausted' })
  })

  it('accepts exact partial rows before closed rows only when exhaustion is captured', () => {
    expect(
      verifyExhaustion([
        historyPage(1, [
          partialPositionHistoryRow('partial-row'),
          positionHistoryRow('closed-row'),
        ]),
        historyPage(2, [], 'closed-row'),
      ])
    ).toEqual({ verified: true, scanTerminalState: 'exhausted' })
  })

  it.each([null, 0, '0', ' ', '\t', undefined] as const)(
    'rejects closeTime %p instead of laundering it as source partial evidence',
    (closeTime) => {
      expect(
        verifyExhaustion([
          historyPage(1, [partialPositionHistoryRow('bad-partial', { closeTime })]),
          historyPage(2, [], 'bad-partial'),
        ])
      ).toEqual({ verified: false })
    }
  )

  it.each([
    ['wrong uniqueCode', { uniqueCode: 'another-trader' }],
    ['wrong instType', { instType: 'SPOT' }],
    ['wrong ccy', { ccy: 'USDC' }],
    ['empty-base symbol', { instId: '-USDT-SWAP' }],
    ['wrong symbol suffix', { instId: 'BTC-USDC-SWAP' }],
    ['wrong side', { posSide: 'Long' }],
    ['future openTime', { openTime: String(Date.parse(HISTORY_FETCHED_AT) + 1) }],
  ] as const)('rejects partial and closed rows with %s', (_label, overrides) => {
    for (const row of [
      partialPositionHistoryRow('bad-partial-domain', overrides),
      { ...positionHistoryRow('bad-closed-domain'), ...overrides },
    ]) {
      expect(
        verifyExhaustion([historyPage(1, [row]), historyPage(2, [], String(row.subPosId))])
      ).toEqual({ verified: false })
    }
  })

  it('rejects a partial subPosId containing the legacy dedupe delimiter', () => {
    expect(
      verifyExhaustion([
        historyPage(1, [partialPositionHistoryRow('partial|identity')]),
        historyPage(2, [], 'partial|identity'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects a partial row after completed history and a duplicate partial/closed identity', () => {
    expect(
      verifyExhaustion([
        historyPage(1, [
          positionHistoryRow('closed-first'),
          partialPositionHistoryRow('partial-late'),
        ]),
        historyPage(2, [], 'partial-late'),
      ])
    ).toEqual({ verified: false })

    expect(
      verifyExhaustion([
        historyPage(1, [
          partialPositionHistoryRow('same-identity'),
          positionHistoryRow('same-identity'),
        ]),
        historyPage(2, [], 'same-identity'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects cursor-overlap proof whenever any captured row is partial', () => {
    const futures = source('futures', 'SWAP')
    const cursor = new Date(HISTORY_CLOSE_TIME).toISOString()

    expect(
      historyVerifier(futures).verify({
        claim: {
          contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
          observations: [{ segment_id: 'default', reason: 'cursor_overlap', page_ordinal: 1 }],
        },
        pages: [
          historyPage(1, [
            partialPositionHistoryRow('partial-row'),
            positionHistoryRow('overlap-row', HISTORY_CLOSE_TIME - 1_000),
          ]),
        ],
        cursor,
        source: futures,
        traderId: 99,
        exchangeTraderId: UNIQUE_CODE,
        kind: 'position_history',
      })
    ).toEqual({ verified: false })
  })

  it('scans to an empty page instead of stopping at cursor overlap after seeing a partial row', async () => {
    const responses = [
      [
        partialPositionHistoryRow('partial-row'),
        positionHistoryRow('overlap-row', Date.parse('2026-06-30T00:00:00.000Z')),
      ],
      [],
    ]
    let responseIndex = 0
    global.fetch = jest.fn(async () =>
      ok(responses[responseIndex++] ?? [])
    ) as unknown as typeof fetch
    const futures = source('futures', 'SWAP')

    const acquisition = await captureHistoryAcquisition({
      source: futures,
      traderId: 99,
      exchangeTraderId: UNIQUE_CODE,
      kind: 'position_history',
      cursor: '2026-07-01T00:00:00.000Z',
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: okxAdapter.getHistory(
        session(),
        futures,
        UNIQUE_CODE,
        'position_history',
        '2026-07-01T00:00:00.000Z'
      ),
      terminalVerifier: historyVerifier(futures),
    })

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
    })
  })

  it('rejects terminal proof when one RAW page contains 101 rows', () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      positionHistoryRow(`row-${index}`, HISTORY_CLOSE_TIME - index)
    )

    expect(verifyExhaustion([historyPage(1, rows), historyPage(2, [], 'row-100')])).toEqual({
      verified: false,
    })
  })

  it('rejects terminal proof when any non-terminal row lacks subPosId', () => {
    const rowWithoutSubPosId = { ...positionHistoryRow('removed-id'), subPosId: undefined }

    expect(
      verifyExhaustion([
        historyPage(1, [
          rowWithoutSubPosId,
          positionHistoryRow('continuation-row', HISTORY_CLOSE_TIME - 1_000),
        ]),
        historyPage(2, [], 'continuation-row'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects duplicate subPosId values across pages even when closeTime differs', () => {
    expect(
      verifyExhaustion([
        historyPage(1, [positionHistoryRow('duplicate-row')]),
        historyPage(
          2,
          [positionHistoryRow('duplicate-row', HISTORY_CLOSE_TIME - 1_000)],
          'duplicate-row'
        ),
        historyPage(3, [], 'duplicate-row'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects terminal proof when a RAW row lacks canonical instId', () => {
    const rowWithoutInstrument = {
      ...positionHistoryRow('missing-inst-id'),
      instId: undefined,
    }

    expect(
      verifyExhaustion([
        historyPage(1, [rowWithoutInstrument]),
        historyPage(2, [], 'missing-inst-id'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects terminal proof when closeTime precedes openTime', () => {
    const closeTime = HISTORY_CLOSE_TIME - 1
    const reversedLifecycle = {
      ...positionHistoryRow('reversed-lifecycle', closeTime),
      openTime: String(HISTORY_CLOSE_TIME),
    }

    expect(
      verifyExhaustion([
        historyPage(1, [reversedLifecycle]),
        historyPage(2, [], 'reversed-lifecycle'),
      ])
    ).toEqual({ verified: false })
  })

  it('rejects terminal proof when closeTime follows its page fetchedAt', () => {
    const fetchedAtMs = Date.parse(HISTORY_FETCHED_AT)
    const futureLifecycle = positionHistoryRow('future-close', fetchedAtMs + 1)

    expect(
      verifyExhaustion([historyPage(1, [futureLifecycle]), historyPage(2, [], 'future-close')])
    ).toEqual({ verified: false })
  })

  it('rejects a terminal claim when the captured request chain has extra query inputs', async () => {
    const futures = source('futures', 'SWAP')
    const fetchedAt = new Date().toISOString()
    async function* forgedStream(): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
      yield {
        pageIndex: 1,
        payload: {
          data: [
            {
              ...positionHistoryRow('row-1', Date.parse('2026-06-30T00:00:00.000Z')),
              openTime: String(Date.parse('2026-06-29T00:00:00.000Z')),
            },
          ],
          historyTraderIdentity: UNIQUE_CODE,
        },
        url:
          'https://www.okx.com/api/v5/copytrading/public-subpositions-history' +
          `?instType=SWAP&uniqueCode=${UNIQUE_CODE}&limit=100&limit=100`,
        fetchedAt,
      }
      return {
        contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
        observations: [{ segment_id: 'default', reason: 'cursor_overlap', page_ordinal: 1 }],
      }
    }

    const acquisition = await captureHistoryAcquisition({
      source: futures,
      traderId: 99,
      exchangeTraderId: UNIQUE_CODE,
      kind: 'position_history',
      cursor: '2026-07-01T00:00:00.000Z',
      attemptStartedAt: new Date(Date.parse(fetchedAt) - 1_000).toISOString(),
      stream: forgedStream(),
      terminalVerifier: historyVerifier(futures),
    })

    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it('rejects an adapter overlap claim when any captured close time is malformed', async () => {
    global.fetch = jest.fn(async () =>
      ok([
        {
          ...positionHistoryRow('bad-time'),
          openTime: String(Date.parse('2026-06-29T00:00:00.000Z')),
          closeTime: 'not-an-epoch',
        },
        {
          ...positionHistoryRow('cursor-overlap', Date.parse('2026-06-30T00:00:00.000Z')),
          openTime: String(Date.parse('2026-06-28T00:00:00.000Z')),
        },
      ])
    ) as unknown as typeof fetch
    const futures = source('futures', 'SWAP')

    const acquisition = await captureHistoryAcquisition({
      source: futures,
      traderId: 99,
      exchangeTraderId: UNIQUE_CODE,
      kind: 'position_history',
      cursor: '2026-07-01T00:00:00.000Z',
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: okxAdapter.getHistory(
        session(),
        futures,
        UNIQUE_CODE,
        'position_history',
        '2026-07-01T00:00:00.000Z'
      ),
      terminalVerifier: historyVerifier(futures),
    })

    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
    })
  })

  it('yields replayable pages before rejecting an unproven page-cap stop', async () => {
    global.fetch = jest.fn(async () =>
      ok([
        {
          subPosId: 'still-has-older-rows',
          openTime: String(Date.parse('2026-07-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-07-10T00:00:00.000Z')),
        },
      ])
    ) as unknown as typeof fetch

    const captured = []
    let failure: unknown = null
    try {
      for await (const page of okxAdapter.getHistory(
        session(),
        {
          ...source('futures', 'SWAP'),
          meta: { inst_type: 'SWAP', history_max_pages: 1 },
        },
        UNIQUE_CODE,
        'position_history',
        null
      )) {
        captured.push(page)
      }
    } catch (error) {
      failure = error
    }

    expect(captured).toHaveLength(1)
    expect(failure).toEqual(
      expect.objectContaining({
        message: '[okx] position history reached page cap 1 without exhaustion or cursor overlap',
      })
    )
  })

  it('rejects a non-empty history page without its continuation identity', async () => {
    global.fetch = jest.fn(async () =>
      ok([
        {
          openTime: String(Date.parse('2026-07-01T00:00:00.000Z')),
          closeTime: String(Date.parse('2026-07-10T00:00:00.000Z')),
        },
      ])
    ) as unknown as typeof fetch

    const iterator = okxAdapter
      .getHistory(session(), source('futures', 'SWAP'), UNIQUE_CODE, 'position_history', null)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(iterator.next()).rejects.toThrow(
      '[okx] position history page is missing the pagination subPosId'
    )
  })

  it('treats an invalid instType as configuration failure, not unsupported data', () => {
    expect(() =>
      supportsSourceSurface(okxAdapter, source('futures', 'MARGIN'), 'positions')
    ).toThrow('[okx] invalid inst_type "MARGIN"')
  })
})
