import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  COINEX_COPIER_PAGE_SIZE,
  coinexCopierHistoryUrl,
  validateCoinexCopierPage,
} from '../copier-snapshot'
import { coinexAdapter } from '../index'

const TRADER_ID = 'F6D0B209'
const PARSED_AT = '2026-08-03T10:00:00.000Z'

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'followers-p1.json'), 'utf8')) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 12,
    slug: 'coinex_futures',
    exchange_id: 12,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'coinex',
    leaderboard_url: 'https://www.coinex.com/en/copy-trading/traders',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 192,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 12,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 500,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: {},
    ...overrides,
  }
}

function data(payload: Dict): Dict {
  return payload.data as Dict
}

function sourceRows(payload: Dict): Dict[] {
  return data(payload).data as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const rows = sourceRows(fixture())
  return Array.from({ length: count }, (_, index) => {
    const template = clone(rows[index % rows.length])
    return {
      ...template,
      follower_name: `COINEX-SNAPSHOT-${start + index}`,
    }
  })
}

function envelope(page: number, total: number, rows: Dict[]): Dict {
  const totalPages = Math.ceil(total / COINEX_COPIER_PAGE_SIZE)
  return {
    code: 0,
    data: {
      has_next: page < totalPages,
      curr_page: page,
      count: rows.length,
      data: rows,
      total,
      total_page: totalPages,
    },
    message: 'Success',
  }
}

function session(respond: (url: string) => unknown): {
  fetchSession: FetchSession
  pageFetch: jest.Mock
} {
  const page = {
    goto: jest.fn(async () => undefined),
    waitForLoadState: jest.fn(async () => undefined),
  }
  const pageFetch = jest.fn(async (template: ReplayRequestTemplate) => ({
    status: 200,
    json: respond(template.url),
  }))
  return {
    pageFetch,
    fetchSession: {
      sourceSlug: 'coinex_futures',
      page: async () => page as Awaited<ReturnType<FetchSession['page']>>,
      api: async () => {
        throw new Error('API context is not used by this test session')
      },
      pageFetch,
      capture: async () => {
        throw new Error('request capture is not used by this test session')
      },
      paced: async <T>(fn: () => Promise<T>) => fn(),
      saveState: async () => undefined,
      close: async () => undefined,
    },
  }
}

function verifier(src = source()) {
  const selected = coinexAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed CoinEx copier verifier')
  return selected
}

async function capture(
  responses: readonly unknown[],
  src = source(),
  exchangeTraderId = TRADER_ID,
  callerPageCap: number | null = null
) {
  let requestIndex = 0
  const { fetchSession, pageFetch } = session(() => responses[requestIndex++])
  const selected = verifier(src)
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: 91,
    exchangeTraderId,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt: new Date(Date.now() - 1_000).toISOString(),
    callerPageCap,
    stream: coinexAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', null),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
  return { acquisition, pageFetch }
}

function parseRows(
  pages: Awaited<ReturnType<typeof capture>>['acquisition']['pages'],
  src = source()
): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      coinexAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: PARSED_AT,
        meta: src.meta,
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

function completeSnapshot(): Dict[] {
  return [
    fixture(),
    envelope(2, 43, syntheticRows(10, 10)),
    envelope(3, 43, syntheticRows(10, 20)),
    envelope(4, 43, syntheticRows(10, 30)),
    envelope(5, 43, syntheticRows(3, 40)),
  ]
}

describe('CoinEx full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures human USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.coinex.copiers@2',
    })
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'bot' }))).toBeNull()
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(coinexAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      coinexAdapter.verifyCopierSnapshot?.(source({ slug: 'coinex_spot', product_type: 'spot' }))
    ).toBeNull()
    expect(
      coinexAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { copiers: 'https://proxy.example.test/followers' } } })
      )
    ).toBeNull()
  })

  it('captures exact 10+10+10+10+3 pages and proves terminal/parser conservation', async () => {
    const payloads = completeSnapshot()
    const { acquisition, pageFetch } = await capture(payloads)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(5)
    expect(acquisition.pages.map((page) => page.payload)).toEqual(payloads)
    expect(acquisition.pages.map((page) => page.url)).toEqual(
      Array.from({ length: 5 }, (_, index) => coinexCopierHistoryUrl(TRADER_ID, index + 1))
    )
    expect(pageFetch.mock.calls.map(([request]) => request.url)).toEqual(
      Array.from({ length: 5 }, (_, index) => coinexCopierHistoryUrl(TRADER_ID, index + 1))
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 5 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(43)
    const capturedSourceRows = acquisition.pages.flatMap((page) => sourceRows(page.payload as Dict))
    rows.forEach((row, index) => expect(row.raw).toBe(capturedSourceRows[index]))
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 43 })
  })

  it('retains and proves the explicit successful zero snapshot', async () => {
    const empty = envelope(1, 0, [])
    const { acquisition, pageFetch } = await capture([empty])

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0].payload).toEqual(empty)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        parserClock: PARSED_AT,
        pages: acquisition.pages,
        rows: [],
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it('accepts a complete final page and binds encoded request coordinates', async () => {
    const exchangeTraderId = 'F6 D0/B+209'
    const complete = envelope(1, 10, syntheticRows(10, 0))
    const { acquisition, pageFetch } = await capture([complete], source(), exchangeTraderId)

    expect(coinexCopierHistoryUrl(exchangeTraderId, 1)).toBe(
      'https://www.coinex.com/res/copy-trading/public/followers' +
        '?trader_id=F6%20D0%2FB%2B209&page=1&limit=10'
    )
    expect(pageFetch.mock.calls[0][0].url).toBe(coinexCopierHistoryUrl(exchangeTraderId, 1))
    expect(acquisition.pages[0].url).toBe(coinexCopierHistoryUrl(exchangeTraderId, 1))
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it('marks a caller-limited prefix partial even when its first page is exact', async () => {
    const { acquisition, pageFetch } = await capture(completeSnapshot(), source(), TRADER_ID, 1)

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'caller_limited',
      scan_terminal_state: 'partial',
      blocker_reasons: ['caller_limit'],
    })
  })

  it('throws after retaining a safety-capped prefix that cannot reach total', async () => {
    const src = source({ meta: { copier_max_pages: 1 } })
    const { acquisition, pageFetch } = await capture([fixture()], src)

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[coinex] copiers reached page cap 1 before reported total 43',
      })
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
      blocker_reasons: ['upstream_error'],
    })
  })

  it('retains both pages but fails closed when total drifts during pagination', async () => {
    const drifting = envelope(2, 44, syntheticRows(10, 10))
    const { acquisition } = await capture([fixture(), drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[coinex] copiers changed total during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate identities across otherwise exact pages', async () => {
    const duplicate = envelope(2, 43, syntheticRows(10, 10))
    sourceRows(duplicate)[0].follower_name = sourceRows(fixture())[0].follower_name
    const { acquisition } = await capture([fixture(), duplicate])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[coinex] copiers returned a missing or duplicate identity',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    [
      'top-level extra key',
      (payload) => {
        payload.success = true
      },
    ],
    [
      'data extra key',
      (payload) => {
        data(payload).page_size = 10
      },
    ],
    [
      'string code',
      (payload) => {
        payload.code = '0'
      },
    ],
    [
      'message drift',
      (payload) => {
        payload.message = 'success'
      },
    ],
    [
      'wrong curr_page',
      (payload) => {
        data(payload).curr_page = 2
      },
    ],
    [
      'count mismatch',
      (payload) => {
        data(payload).count = 9
      },
    ],
    [
      'total_page drift',
      (payload) => {
        data(payload).total_page = 4
      },
    ],
    [
      'has_next drift',
      (payload) => {
        data(payload).has_next = false
      },
    ],
    [
      'truncated nonterminal page',
      (payload) => {
        data(payload).data = sourceRows(payload).slice(0, 9)
        data(payload).count = 9
      },
    ],
    [
      'row schema drift',
      (payload) => {
        sourceRows(payload)[0].follower_id = 'unexpected'
      },
    ],
  ]

  it.each(malformedCases)(
    'retains but rejects exact-envelope drift: %s',
    async (_label, mutate) => {
      const payload = fixture()
      mutate(payload)
      const { acquisition } = await capture([payload])

      expect(acquisition.pages).toHaveLength(1)
      expect(acquisition.error).toEqual(
        expect.objectContaining({
          message: '[coinex] copiers returned a malformed exact page envelope',
        })
      )
      expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
    }
  )

  it.each([
    ['blank label', 'follower_name', ''],
    ['padded label', 'follower_name', ' follower '],
    ['negative investment', 'fund_amount', '-1'],
    ['negative-zero investment', 'fund_amount', '-0'],
    ['leading-zero investment', 'fund_amount', '01.5'],
    ['exponent investment', 'fund_amount', '1e2'],
    ['negative-zero PnL', 'total_copy_earn_amount', '-0'],
    ['whitespace PnL', 'total_copy_earn_amount', ' 1'],
  ] as const)('fails closed on a non-canonical copier field: %s', (_label, field, value) => {
    const payload = fixture()
    sourceRows(payload)[0][field] = value
    expect(validateCoinexCopierPage(payload, 1)).toBeNull()
  })

  it('rejects missing pages, parser omission/reordering and projection/raw/hash drift', async () => {
    const { acquisition } = await capture(completeSnapshot())
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (
      candidateRows: readonly ParsedCopierRow[],
      candidatePages = acquisition.pages
    ) =>
      selected.verifyConservation({
        exchangeTraderId: TRADER_ID,
        parserClock: PARSED_AT,
        pages: candidatePages,
        rows: candidateRows,
      })

    expect(verify(rows)).toEqual({ verified: true, envelopeRowCount: 43 })
    expect(
      verify(
        rows,
        acquisition.pages.filter((page) => page.pageIndex !== 2)
      )
    ).toEqual({
      verified: false,
    })
    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) =>
          index === 0 ? { ...row, ts: new Date(Date.parse(PARSED_AT) - 1).toISOString() } : row
        )
      )
    ).toEqual({ verified: false })
    expect(verify(rows.map((row) => ({ ...row, ts: '2000-01-01T00:00:00.000Z' })))).toEqual({
      verified: false,
    })
    expect(verify(rows.map((row) => ({ ...row, ts: '2026-08-03T10:00:00Z' })))).toEqual({
      verified: false,
    })
    expect(
      verify(
        rows.map((row) => ({
          ...row,
          ts: new Date(Date.parse(acquisition.pages[0].fetchedAt) + 1).toISOString(),
        }))
      )
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copierLabel: 'wrong' } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copierPnl: 0 } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copierInvested: 0 } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, copyDurationDays: 0 } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, raw: { ...row.raw } } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(rows.map((row, index) => (index === 0 ? { ...row, dedupeHash: '0'.repeat(40) } : row)))
    ).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) => (index === 1 ? { ...row, dedupeHash: rows[0].dedupeHash } : row))
      )
    ).toEqual({ verified: false })
  })
})
