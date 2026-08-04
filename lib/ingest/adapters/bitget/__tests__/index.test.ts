import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { bitgetAdapter } from '../index'

const TRADER_ID = 'bitget-trader-1'

const src: SourceRow = {
  id: 4,
  slug: 'bitget_futures',
  exchange_id: 4,
  product_type: 'futures',
  trader_kind_scope: 'human',
  adapter_slug: 'bitget',
  leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/futures',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 200,
  positions_topn: 200,
  profile_cache_ttl: '1 hour',
  copier_table_depth: 'top50',
  currency: 'USDT',
  page_size: 30,
  pagination_kind: 'numeric',
  cadence_tier_a: '2 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 1_000,
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: { history_max_pages: 1 },
}

function session(response: unknown): FetchSession {
  return {
    sourceSlug: src.slug,
    page: async () =>
      ({
        goto: async () => null,
        waitForLoadState: async () => null,
      }) as unknown as Awaited<ReturnType<FetchSession['page']>>,
    pageFetch: async (_template: ReplayRequestTemplate) => ({ status: 200, json: response }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function positionRows(count: number) {
  const closeBase = Date.parse('2026-07-20T00:00:00.000Z')
  return Array.from({ length: count }, (_, index) => ({
    orderNo: `order-${index}`,
    closeTime: closeBase - index,
  }))
}

function fullPositionPage(nextFlag: boolean): unknown {
  return {
    code: '00000',
    data: {
      rows: positionRows(20),
      nextFlag,
    },
  }
}

function historyVerifier() {
  const verifier = bitgetAdapter.historyTerminalVerifier?.(src, 'position_history')
  if (!verifier) throw new Error('expected the reviewed Bitget position-history verifier')
  return verifier
}

describe('Bitget history termination', () => {
  it('selects terminal verification only for the reviewed futures endpoint', () => {
    expect(bitgetAdapter.historyTerminalVerifier?.(src, 'position_history')).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.bitget.position_history@2',
    })
    expect(bitgetAdapter.historyTerminalVerifier?.(src, 'copiers')).toBeNull()
    expect(
      bitgetAdapter.historyTerminalVerifier?.(
        {
          ...src,
          meta: {
            ...src.meta,
            endpoints: { positionHistory: 'https://proxy.example.test/history' },
          },
        },
        'position_history'
      )
    ).toBeNull()
  })

  it('yields replayable data before rejecting an unproven page-cap stop', async () => {
    const captured = []
    let failure: unknown = null
    try {
      for await (const page of bitgetAdapter.getHistory(
        session(fullPositionPage(true)),
        src,
        TRADER_ID,
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
        message: '[bitget] position_history reached page cap 1 without terminal proof',
      })
    )
  })

  it('accepts an explicit upstream end marker on a full final page', async () => {
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session(fullPositionPage(false)),
        src,
        TRADER_ID,
        'position_history',
        null
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
  })

  it('rejects a complete capture with a negative numeric orderNo identity', async () => {
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session({
          code: '00000',
          data: {
            rows: [{ orderNo: -1, closeTime: Date.parse('2026-07-20T00:00:00.000Z') }],
            nextFlag: false,
          },
        }),
        src,
        TRADER_ID,
        'position_history',
        null
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it.each(['0x1', '0o1', '0b1'] as const)(
    'rejects radix-prefixed closeTime %s as terminal evidence',
    async (closeTime) => {
      const acquisition = await captureHistoryAcquisition({
        source: src,
        traderId: 44,
        exchangeTraderId: TRADER_ID,
        kind: 'position_history',
        cursor: null,
        attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
        stream: bitgetAdapter.getHistory(
          session({
            code: '00000',
            data: { rows: [{ orderNo: 'radix-order', closeTime }], nextFlag: false },
          }),
          src,
          TRADER_ID,
          'position_history',
          null
        ),
        terminalVerifier: historyVerifier(),
      })

      expect(acquisition.artifact.termination).toMatchObject({
        evidence_state: 'rejected',
        scan_terminal_state: 'unknown',
        blocker_reasons: ['terminal_claim_rejected'],
      })
    }
  )

  it('captures an empty success page before verifying exhaustion', async () => {
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session({ code: '00000', data: { rows: [] } }),
        src,
        TRADER_ID,
        'position_history',
        null
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
  })

  it('verifies an unambiguous short page as exhausted', async () => {
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session({ code: '00000', data: { rows: positionRows(3) } }),
        src,
        TRADER_ID,
        'position_history',
        null
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'short_page', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
  })

  it('verifies cursor overlap from the oldest close on a full ordered page', async () => {
    const cursor = '2026-07-19T23:59:59.990Z'
    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session(fullPositionPage(true)),
        src,
        TRADER_ID,
        'position_history',
        cursor
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'cursor_overlap', page_ordinal: 1 }],
      scan_terminal_state: 'cursor_overlap',
      overlap_event_at: '2026-07-19T23:59:59.981Z',
    })
  })

  it('rejects a short page that still reports a continuation', async () => {
    const iterator = bitgetAdapter
      .getHistory(
        session({ code: '00000', data: { rows: positionRows(3), nextFlag: true } }),
        src,
        TRADER_ID,
        'position_history',
        null
      )
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(iterator.next()).rejects.toThrow('short page still claims continuation')
  })

  it('yields the API error envelope before rejecting it as terminal evidence', async () => {
    const iterator = bitgetAdapter
      .getHistory(
        session({ code: '40017', msg: 'request failed', data: null }),
        src,
        TRADER_ID,
        'position_history',
        null
      )
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { payload: { response: { code: '40017' } } },
    })
    await expect(iterator.next()).rejects.toThrow('returned a non-success API envelope')
  })

  it('rejects an overlap claim when one captured close time is malformed', async () => {
    const closeBase = Date.parse('2026-07-20T00:00:00.000Z')
    const response = {
      code: '00000',
      data: {
        rows: Array.from({ length: 20 }, (_, index) => ({
          orderNo: `order-${index}`,
          closeTime: index === 0 ? 'not-an-epoch' : closeBase - index,
        })),
        nextFlag: true,
      },
    }

    const acquisition = await captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'position_history',
      cursor: '2026-07-20T00:00:00.000Z',
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(
        session(response),
        src,
        TRADER_ID,
        'position_history',
        '2026-07-20T00:00:00.000Z'
      ),
      terminalVerifier: historyVerifier(),
    })

    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
    })
  })
})

describe('Bitget copier snapshot authority', () => {
  function verifier() {
    const selected = bitgetAdapter.verifyCopierSnapshot?.(src)
    if (!selected) throw new Error('expected the reviewed Bitget copier verifier')
    return selected
  }

  async function captureCopiers(response: unknown) {
    const selected = verifier()
    return captureHistoryAcquisition({
      source: src,
      traderId: 44,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers',
      cursor: null,
      attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
      stream: bitgetAdapter.getHistory(session(response), src, TRADER_ID, 'copiers', null),
      terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
    })
  }

  it('selects only the reviewed production endpoint', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.bitget.copiers@1',
    })
    expect(
      bitgetAdapter.verifyCopierSnapshot?.({
        ...src,
        meta: { ...src.meta, endpoints: { copiers: 'https://proxy.example.test/copiers' } },
      })
    ).toBeNull()
  })

  it.each([2, 0])('proves terminal and parser conservation for %i rows', async (rowCount) => {
    const response = {
      code: '00000',
      success: true,
      data: {
        nextFlag: false,
        rows: Array.from({ length: rowCount }, (_, index) => ({
          userName: `BGUSER-${index}`,
          totalProfit: String(index),
          totalMargin: String(index + 1),
        })),
      },
    }
    const acquisition = await captureCopiers(response)
    expect(acquisition.error).toBeNull()
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = acquisition.pages.flatMap((page) =>
      bitgetAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: page.fetchedAt,
        meta: src.meta,
      })
    )
    const copierRows = rows.filter((row) => row.kind === 'copiers')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: copierRows,
      })
    ).toEqual({ verified: true, envelopeRowCount: rowCount })
  })

  it('rejects a parser-empty schema drift instead of publishing a false empty snapshot', async () => {
    const acquisition = await captureCopiers({
      code: '00000',
      success: true,
      data: { nextFlag: false, items: [] },
    })

    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
    expect(acquisition.error).toEqual(expect.any(Error))
  })

  it('rejects duplicate copier identities even when their values differ', async () => {
    const acquisition = await captureCopiers({
      code: '00000',
      success: true,
      data: {
        nextFlag: false,
        rows: [
          { userName: 'same-copier', totalProfit: '1', totalMargin: '10' },
          { userName: 'same-copier', totalProfit: '2', totalMargin: '20' },
        ],
      },
    })

    expect(acquisition.error).toBeNull()
    expect(acquisition.artifact.termination.evidence_state).toBe('rejected')
  })
})
