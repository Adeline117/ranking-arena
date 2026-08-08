import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  KUCOIN_COPIER_PAGE_SIZE,
  kucoinCopierHistoryUrl,
  validateKucoinCopierPage,
} from '../copier-snapshot'
import { kucoinAdapter } from '../index'

const TRADER_ID = '1007359'
const PARSED_AT = '2026-08-03T10:00:00.000Z'

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'copy-traders-p1.json'), 'utf8')
  ) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 28,
    slug: 'kucoin_futures',
    exchange_id: 28,
    product_type: 'futures',
    trader_kind_scope: 'mixed',
    adapter_slug: 'kucoin',
    leaderboard_url: 'https://www.kucoin.com/copytrading',
    timeframes_native: [30],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 120,
    deep_profile_topn: 100,
    positions_topn: 0,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 100,
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
  return data(payload).items as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const rows = sourceRows(fixture())
  return Array.from({ length: count }, (_, index) => {
    const ordinal = start + index
    const template = clone(rows[index % rows.length])
    return {
      ...template,
      avatar: `https://assets.staticimg.com/kc-v2-config/avatar/snapshot-${ordinal}.png`,
      nickName: `KUCOIN-SNAPSHOT-${ordinal}`,
    }
  })
}

function envelope(page: number, total: number, rows: Dict[]): Dict {
  return {
    success: true,
    code: '200',
    msg: 'success',
    retry: false,
    data: {
      currentPage: page,
      pageSize: KUCOIN_COPIER_PAGE_SIZE,
      totalNum: total,
      totalPage: Math.ceil(total / KUCOIN_COPIER_PAGE_SIZE),
      items: rows,
    },
  }
}

function session(respond: (request: ReplayRequestTemplate) => unknown): {
  fetchSession: FetchSession
  pageFetch: jest.Mock
} {
  const page = {
    goto: jest.fn(async () => undefined),
    waitForLoadState: jest.fn(async () => undefined),
  }
  const pageFetch = jest.fn(async (template: ReplayRequestTemplate) => ({
    status: 200,
    json: respond(template),
  }))
  return {
    pageFetch,
    fetchSession: {
      sourceSlug: 'kucoin_futures',
      page: async () => page,
      pageFetch,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = kucoinAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed KuCoin copier verifier')
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
    stream: kucoinAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', null),
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
      kucoinAdapter.parseHistory(page.payload, 'copiers', {
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
    envelope(1, 47, syntheticRows(10, 0)),
    envelope(2, 47, syntheticRows(10, 10)),
    envelope(3, 47, syntheticRows(10, 20)),
    envelope(4, 47, syntheticRows(10, 30)),
    envelope(5, 47, syntheticRows(7, 40)),
  ]
}

describe('KuCoin full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures mixed USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.kucoin.copiers@1',
    })
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'human' }))).toBeNull()
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(kucoinAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      kucoinAdapter.verifyCopierSnapshot?.(source({ slug: 'kucoin_spot', product_type: 'spot' }))
    ).toBeNull()
    expect(
      kucoinAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { copiers: 'https://proxy.example.test/followers' } } })
      )
    ).toBeNull()
  })

  it('captures exact 10+10+10+10+7 pages and proves terminal/parser conservation', async () => {
    const payloads = completeSnapshot()
    const { acquisition, pageFetch } = await capture(payloads)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(5)
    expect(acquisition.pages.map((page) => page.payload)).toEqual(payloads)
    const expectedUrls = Array.from({ length: 5 }, (_, index) =>
      kucoinCopierHistoryUrl(TRADER_ID, index + 1)
    )
    expect(acquisition.pages.map((page) => page.url)).toEqual(expectedUrls)
    expect(pageFetch.mock.calls.map(([request]) => request.url)).toEqual(expectedUrls)
    expect(pageFetch.mock.calls.map(([request]) => request.method)).toEqual(Array(5).fill('GET'))
    expect(pageFetch.mock.calls.map(([request]) => request.body)).toEqual(Array(5).fill(undefined))
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 5 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(47)
    const capturedSourceRows = acquisition.pages.flatMap((page) => sourceRows(page.payload as Dict))
    rows.forEach((row, index) => expect(row.raw).toBe(capturedSourceRows[index]))
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 47 })
  })

  it('uses the reviewed 100-page default instead of truncating at the legacy 30-page cap', async () => {
    const total = 301
    const payloads = Array.from({ length: 31 }, (_, index) =>
      envelope(
        index + 1,
        total,
        syntheticRows(index === 30 ? 1 : KUCOIN_COPIER_PAGE_SIZE, index * KUCOIN_COPIER_PAGE_SIZE)
      )
    )
    const { acquisition, pageFetch } = await capture(payloads)
    const rows = parseRows(acquisition.pages)

    expect(pageFetch).toHaveBeenCalledTimes(31)
    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(31)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
    })
    expect(rows).toHaveLength(total)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: total })
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
        pages: acquisition.pages,
        rows: [],
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it('binds the exact encoded request coordinates', async () => {
    const exchangeTraderId = '100 7359/A+B'
    const complete = envelope(1, 10, syntheticRows(10, 0))
    const { acquisition, pageFetch } = await capture([complete], source(), exchangeTraderId)

    expect(kucoinCopierHistoryUrl(exchangeTraderId, 1)).toBe(
      'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/copyTraders' +
        '?lang=en_US&leadConfigId=100%207359%2FA%2BB&currentPage=1&pageSize=10'
    )
    expect(kucoinCopierHistoryUrl(exchangeTraderId, 2)).toContain('&currentPage=2&')
    expect(kucoinCopierHistoryUrl(exchangeTraderId, 2)).not.toContain('pageNum')
    expect(pageFetch.mock.calls[0][0]).toMatchObject({
      url: kucoinCopierHistoryUrl(exchangeTraderId, 1),
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    expect(acquisition.pages[0].url).toBe(kucoinCopierHistoryUrl(exchangeTraderId, 1))
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it('rejects the deliberately truncated real page-1 fixture', () => {
    expect(data(fixture())).toMatchObject({
      currentPage: 1,
      pageSize: 10,
      totalNum: 47,
      totalPage: 5,
    })
    expect(sourceRows(fixture())).toHaveLength(3)
    expect(validateKucoinCopierPage(fixture(), 1)).toBeNull()
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
    const { acquisition, pageFetch } = await capture([completeSnapshot()[0]], src)

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[kucoin] copiers reached page cap 1 before reported total 47',
      })
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
      blocker_reasons: ['upstream_error'],
    })
  })

  it('retains both pages but fails closed when total drifts during pagination', async () => {
    const drifting = envelope(2, 48, syntheticRows(10, 10))
    const { acquisition } = await capture([completeSnapshot()[0], drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[kucoin] copiers changed totalNum during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('does not mistake a shared stock avatar for a duplicate follower', async () => {
    const pages = completeSnapshot()
    sourceRows(pages[1])[0].avatar = sourceRows(pages[0])[0].avatar
    const { acquisition } = await capture(pages)

    expect(acquisition.error).toBeNull()
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    expect(parseRows(acquisition.pages)).toHaveLength(47)
  })

  it('rejects a repeated parser identity across otherwise exact pages', async () => {
    const pages = completeSnapshot()
    const first = sourceRows(pages[0])[0]
    const repeated = sourceRows(pages[1])[0]
    repeated.nickName = first.nickName
    repeated.copyPrincipal = first.copyPrincipal
    repeated.copyDays = first.copyDays
    const { acquisition } = await capture(pages.slice(0, 2))

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[kucoin] copiers returned a missing or duplicate parser projection',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    ['top-level extra key', (payload) => void (payload.extra = true)],
    ['data extra key', (payload) => void (data(payload).hasNext = true)],
    ['numeric code', (payload) => void (payload.code = 200)],
    ['message drift', (payload) => void (payload.msg = 'Success')],
    ['retry drift', (payload) => void (payload.retry = true)],
    ['wrong currentPage', (payload) => void (data(payload).currentPage = 2)],
    ['pageSize drift', (payload) => void (data(payload).pageSize = 20)],
    ['totalPage drift', (payload) => void (data(payload).totalPage = 4)],
    [
      'truncated nonterminal page',
      (payload) => void (data(payload).items = sourceRows(payload).slice(0, 9)),
    ],
    ['row schema drift', (payload) => void (sourceRows(payload)[0].id = 'unexpected')],
  ]

  it.each(malformedCases)(
    'retains but rejects exact-envelope drift: %s',
    async (_label, mutate) => {
      const payload = envelope(1, 47, syntheticRows(10, 0))
      mutate(payload)
      const { acquisition } = await capture([payload])

      expect(acquisition.pages).toHaveLength(1)
      expect(acquisition.error).toEqual(
        expect.objectContaining({
          message: '[kucoin] copiers returned a malformed exact page envelope',
        })
      )
      expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
    }
  )

  it.each([
    ['non-null uid', 'uid', 1],
    ['blank label', 'nickName', ''],
    ['whitespace-only label', 'nickName', '   '],
    ['non-https avatar', 'avatar', 'http://assets.example.test/a.png'],
    ['fractional duration', 'copyDays', 1.5],
    ['negative investment', 'copyPrincipal', '-1'],
    ['negative-zero investment', 'copyPrincipal', '-0'],
    ['leading-zero investment', 'copyPrincipal', '01.5'],
    ['exponent investment', 'copyPrincipal', '1e2'],
    ['negative-zero PnL', 'pnl', '-0'],
    ['whitespace PnL', 'pnl', ' 1'],
  ] as const)('fails closed on a non-canonical copier field: %s', (_label, field, value) => {
    const payload = envelope(1, 10, syntheticRows(10, 0))
    sourceRows(payload)[0][field] = value
    expect(validateKucoinCopierPage(payload, 1)).toBeNull()
  })

  it('preserves a nonblank nickname with upstream leading and trailing spaces', async () => {
    const payload = envelope(1, 10, syntheticRows(10, 0))
    sourceRows(payload)[0].nickName = ' follower '
    const { acquisition } = await capture([payload])
    const rows = parseRows(acquisition.pages)

    expect(acquisition.error).toBeNull()
    expect(rows[0].copierLabel).toBe(' follower ')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 10 })
  })

  it('rejects missing pages, parser omission/reordering, clock, projection, RAW and hash drift', async () => {
    const { acquisition } = await capture(completeSnapshot())
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (
      candidateRows: readonly ParsedCopierRow[],
      candidatePages = acquisition.pages
    ) =>
      selected.verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: candidatePages,
        rows: candidateRows,
      })

    expect(verify(rows)).toEqual({ verified: true, envelopeRowCount: 47 })
    expect(
      verify(
        rows,
        acquisition.pages.filter((page) => page.pageIndex !== 2)
      )
    ).toEqual({ verified: false })
    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) =>
          index === 0 ? { ...row, ts: new Date(Date.parse(PARSED_AT) - 1).toISOString() } : row
        )
      )
    ).toEqual({ verified: false })
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

  it('rejects invalid page-cap metadata before the first request', async () => {
    for (const value of [0, -0, 1.5, '2']) {
      const src = source({ meta: { copier_max_pages: value } })
      const { acquisition, pageFetch } = await capture([], src)
      expect(pageFetch).not.toHaveBeenCalled()
      expect(acquisition.error).toEqual(
        expect.objectContaining({
          message: '[kucoin] copier_max_pages must be a positive safe integer',
        })
      )
    }
  })
})
