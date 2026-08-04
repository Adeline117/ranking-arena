import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { BITGET_BOTS_COPIER_PAGE_CONTRACT, BITGET_BOTS_COPIER_URL } from '../bots-copier-snapshot'
import { bitgetBotsAdapter } from '../bots'

const STRATEGY_ID = '1257030511528857600'
const PARSED_AT = '2026-08-03T10:00:00.000Z'

type Dict = Record<string, unknown>

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(
  productType: 'futures' | 'spot' = 'futures',
  overrides: Partial<SourceRow> = {}
): SourceRow {
  const futures = productType === 'futures'
  return {
    id: futures ? 41 : 42,
    slug: futures ? 'bitget_bots_futures' : 'bitget_bots_spot',
    exchange_id: 5,
    product_type: productType,
    trader_kind_scope: 'bot',
    adapter_slug: 'bitget_bots',
    leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/bot',
    timeframes_native: [30],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: futures ? 180 : 130,
    deep_profile_topn: 200,
    positions_topn: 0,
    profile_cache_ttl: '1 hour',
    copier_table_depth: 'top10',
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
    meta: {
      boards: futures ? ['futures_grid', 'futures_martingale'] : ['spot_grid', 'spot_martingale'],
    },
    ...overrides,
  }
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

function verifier(src = source()) {
  const selected = bitgetBotsAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed Bitget bots copier verifier')
  return selected
}

async function capture(payload: unknown, src = source()) {
  const requests: ReplayRequestTemplate[] = []
  const selected = verifier(src)
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: 99,
    exchangeTraderId: STRATEGY_ID,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
    stream: bitgetBotsAdapter.getHistory(
      session(async (request) => {
        requests.push(request)
        return { status: 200, json: payload }
      }),
      src,
      STRATEGY_ID,
      'copiers',
      null
    ),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
  return { acquisition, requests }
}

function parseRows(
  pages: Awaited<ReturnType<typeof capture>>['acquisition']['pages']
): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      bitgetBotsAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: 'bitget_bots_futures',
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: PARSED_AT,
        meta: {},
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('Bitget bots copier snapshot authority', () => {
  it('selects only canonical active-serving top-10 futures and spot sources', () => {
    expect(verifier(source('futures'))).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.bitget_bots.copiers@1',
    })
    expect(verifier(source('spot'))).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.bitget_bots.copiers@1',
    })
    expect(
      bitgetBotsAdapter.verifyCopierSnapshot?.(source('futures', { copier_table_depth: 'full' }))
    ).toBeNull()
    expect(
      bitgetBotsAdapter.verifyCopierSnapshot?.(
        source('futures', { meta: { boards: ['futures_martingale', 'futures_grid'] } })
      )
    ).toBeNull()
    expect(
      bitgetBotsAdapter.verifyCopierSnapshot?.(
        source('futures', {
          meta: {
            boards: ['futures_grid', 'futures_martingale'],
            endpoints: { copiers: 'https://proxy.example.test/followRank' },
          },
        })
      )
    ).toBeNull()
    expect(
      bitgetBotsAdapter.verifyCopierSnapshot?.(source('spot', { slug: 'bitget_bots_futures' }))
    ).toBeNull()
  })

  it('binds the exact POST request and complete response before proving conservation', async () => {
    const response = fixture('bots-follow-rank.json')
    const { acquisition, requests } = await capture(response)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: BITGET_BOTS_COPIER_URL,
      method: 'POST',
      body: { strategyId: STRATEGY_ID },
    })
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0]).toMatchObject({
      pageIndex: 1,
      url: BITGET_BOTS_COPIER_URL,
      payload: {
        contract: BITGET_BOTS_COPIER_PAGE_CONTRACT,
        historyTraderIdentity: STRATEGY_ID,
        request: { strategyId: STRATEGY_ID },
        response,
      },
    })
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'snapshot_complete', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(10)
    expect(rows[0].ts).toBe('2026-06-11T07:31:04.838Z')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: STRATEGY_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 10 })
  })

  it('proves explicit empty only with the exact success envelope and valid source clock', async () => {
    const { acquisition } = await capture(fixture('bots-follow-rank-empty.json'))
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
    })
    const rows = parseRows(acquisition.pages)
    expect(rows).toEqual([])
    expect(
      verifier().verifyConservation({
        exchangeTraderId: STRATEGY_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it.each([
    ['missing clock', undefined],
    ['null clock', null],
    ['zero clock', '0'],
    ['non-canonical clock', '1781163064838.0'],
    ['out-of-range clock', '9007199254740991'],
    ['garbage clock', 'not-a-clock'],
  ])('rejects an otherwise empty response with %s', async (_label, lastUpdateTime) => {
    const payload = clone<Dict>(fixture('bots-follow-rank-empty.json'))
    const data = payload.data as Dict
    if (lastUpdateTime === undefined) delete data.lastUpdateTime
    else data.lastUpdateTime = lastUpdateTime

    const { acquisition } = await capture(payload)
    expect(acquisition.artifact.termination.evidence_state).toBe('rejected')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: STRATEGY_ID,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: false })
  })

  it.each([
    [
      'numeric response code',
      (payload: Dict) => {
        payload.code = 200
      },
    ],
    [
      'response total drift',
      (payload: Dict) => {
        payload.total = 10
      },
    ],
    [
      'non-empty params',
      (payload: Dict) => {
        payload.params = ['unexpected']
      },
    ],
    [
      'data nextFlag drift',
      (payload: Dict) => {
        const data = payload.data as Dict
        data.nextFlag = false
      },
    ],
    [
      'eleventh follower',
      (payload: Dict) => {
        const followers = (payload.data as Dict).followers as Dict[]
        followers.push({ ...followers[0], followerUserName: 'BGUSER-ELEVENTH' })
      },
    ],
    [
      'row clock mismatch',
      (payload: Dict) => {
        const followers = (payload.data as Dict).followers as Dict[]
        followers[0].lastUpdateTime = '1781163064837'
      },
    ],
    [
      'negative investment',
      (payload: Dict) => {
        const followers = (payload.data as Dict).followers as Dict[]
        followers[0].followerInvestmentAmount = '-1'
      },
    ],
    [
      'negative-zero PnL',
      (payload: Dict) => {
        const followers = (payload.data as Dict).followers as Dict[]
        followers[0].followerProfitAmount = '-0'
      },
    ],
  ] as const)('rejects exact response/list drift: %s', async (_label, mutate) => {
    const payload = clone<Dict>(fixture('bots-follow-rank.json'))
    mutate(payload)
    const { acquisition } = await capture(payload)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'rejected',
      scan_terminal_state: 'unknown',
      blocker_reasons: ['terminal_claim_rejected'],
    })
  })

  it('rejects a non-empty source-clock drift instead of trusting the parser fallback', async () => {
    const payload = clone<Dict>(fixture('bots-follow-rank.json'))
    const data = payload.data as Dict
    data.lastUpdateTime = 'not-a-clock'
    for (const follower of data.followers as Dict[]) {
      follower.lastUpdateTime = 'not-a-clock'
    }

    const { acquisition } = await capture(payload)
    const fallbackRows = parseRows(acquisition.pages)
    expect(fallbackRows).toHaveLength(10)
    expect(fallbackRows.every((row) => row.ts === PARSED_AT)).toBe(true)
    expect(acquisition.artifact.termination.evidence_state).toBe('rejected')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: STRATEGY_ID,
        pages: acquisition.pages,
        rows: fallbackRows,
      })
    ).toEqual({ verified: false })
  })

  it('rejects wrapper identity, request and exact-key drift', async () => {
    const { acquisition } = await capture(fixture('bots-follow-rank.json'))
    const page = acquisition.pages[0]
    const wrapper = page.payload as Dict
    const claim = {
      contract: 'arena.ingest.history-terminal-claim@1' as const,
      observations: [
        { segment_id: 'default', reason: 'snapshot_complete' as const, page_ordinal: 1 },
      ],
    }
    const verify = (payload: Dict) =>
      verifier().verifyTerminal({
        claim,
        pages: [{ ...page, payload }],
        cursor: null,
        source: source(),
        traderId: 99,
        exchangeTraderId: STRATEGY_ID,
        kind: 'copiers',
      })

    expect(verify({ ...wrapper, historyTraderIdentity: 'another-bot' })).toEqual({
      verified: false,
    })
    expect(verify({ ...wrapper, request: { strategyId: 'another-bot' } })).toEqual({
      verified: false,
    })
    expect(verify({ ...wrapper, unexpected: true })).toEqual({ verified: false })
  })

  it('rejects parser omission, reordering, raw substitution, time fallback and duplicate hashes', async () => {
    const { acquisition } = await capture(fixture('bots-follow-rank.json'))
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: STRATEGY_ID,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, raw: { ...row.raw } } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, ts: PARSED_AT } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) => (index === 1 ? { ...row, dedupeHash: rows[0].dedupeHash } : row))
      )
    ).toEqual({ verified: false })
  })
})
