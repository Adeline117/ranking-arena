import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  MEXC_COPIER_PAGE_SIZE,
  mexcCopierHistoryUrl,
  validateMexcCopierPage,
} from '../copier-snapshot'
import { mexcAdapter } from '../index'

const TRADER_ID = '02298603'
const PARSED_AT = new Date(Date.now() - 1_000).toISOString()

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'followers-p1.json'), 'utf8')) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 10,
    slug: 'mexc_futures',
    exchange_id: 10,
    product_type: 'futures',
    trader_kind_scope: 'mixed',
    adapter_slug: 'mexc',
    leaderboard_url: 'https://www.mexc.com/zh-CN/futures/copyTrade/home',
    timeframes_native: [7],
    timeframes_derived: [30, 90],
    tf_label_map: {},
    expected_count: 7_664,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 30,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 500,
    phase: 1,
    serving_mode: 'serving',
    status: 'active',
    meta: { derived_board_sort: 'roi', ai_traders_tab_is_bot: true },
    ...overrides,
  }
}

function data(payload: Dict): Dict {
  return payload.data as Dict
}

function rows(payload: Dict): Dict[] {
  return data(payload).content as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const templates = rows(fixture())
  return Array.from({ length: count }, (_, index) => {
    const serial = String(start + index).padStart(3, '0')
    const row = clone(templates[index % templates.length])
    return {
      ...row,
      followerUid: `${serial.slice(0, 2)}*****${serial.slice(2)}`,
      nickname: `m${serial}****@***.com`,
      copyFunds: start + index + 0.25,
      copyProfit: index % 2 === 0 ? start + index + 0.5 : -(start + index + 0.5),
      reverseCopy: index % 2,
    }
  })
}

function envelope(page: number, total: number, content: Dict[]): Dict {
  return {
    code: 0,
    data: {
      content,
      currentPage: page,
      offset: (page - 1) * MEXC_COPIER_PAGE_SIZE,
      pageSize: MEXC_COPIER_PAGE_SIZE,
      total,
      totalPage: Math.ceil(total / MEXC_COPIER_PAGE_SIZE),
    },
    message: '',
    success: true,
  }
}

function completeSnapshot(): Dict[] {
  return [
    fixture(),
    envelope(2, 33, syntheticRows(10, 100)),
    envelope(3, 33, syntheticRows(10, 110)),
    envelope(4, 33, syntheticRows(3, 120)),
  ]
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
      sourceSlug: 'mexc_futures',
      page: async () => page,
      pageFetch,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = mexcAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed MEXC copier verifier')
  return selected
}

async function capture(
  responses: readonly unknown[],
  src = source(),
  exchangeTraderId = TRADER_ID,
  callerPageCap: number | null = null,
  cursor: string | null = null
) {
  let responseIndex = 0
  const { fetchSession, pageFetch } = session(() => responses[responseIndex++])
  const selected = verifier(src)
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: 91,
    exchangeTraderId,
    kind: 'copiers',
    cursor,
    attemptStartedAt: PARSED_AT,
    callerPageCap,
    stream: mexcAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', cursor),
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
      mexcAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: PARSED_AT,
        meta: src.meta,
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('MEXC futures full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures mixed USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.mexc.copiers@1',
    })
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'human' }))).toBeNull()
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(mexcAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      mexcAdapter.verifyCopierSnapshot?.(
        source({ slug: 'mexc_spot', product_type: 'spot', trader_kind_scope: 'human' })
      )
    ).toBeNull()
    expect(
      mexcAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { copiers: 'https://proxy.example.test/followers' } } })
      )
    ).toBeNull()
  })

  it('captures the real 10-row page plus 10+10+3 and proves all 33 rows', async () => {
    const payloads = completeSnapshot()
    const { acquisition, pageFetch } = await capture(payloads)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(4)
    expect(acquisition.pages.map((page) => page.payload)).toEqual(payloads)
    expect(acquisition.pages.map((page) => page.url)).toEqual(
      [1, 2, 3, 4].map((page) => mexcCopierHistoryUrl(TRADER_ID, page))
    )
    expect(pageFetch.mock.calls.map(([request]) => request.url)).toEqual(
      [1, 2, 3, 4].map((page) => mexcCopierHistoryUrl(TRADER_ID, page))
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 4 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const parsed = parseRows(acquisition.pages)
    const sourceRows = acquisition.pages.flatMap((page) => rows(page.payload as Dict))
    expect(parsed).toHaveLength(33)
    parsed.forEach((row, index) => expect(row.raw).toBe(sourceRows[index]))
    expect(parsed.every((row) => row.ts === PARSED_AT)).toBe(true)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parsed,
      })
    ).toEqual({ verified: true, envelopeRowCount: 33 })
  })

  it('retains and proves an explicit successful zero snapshot', async () => {
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

  it('proves a full terminal page and preserves a leading-zero trader id in the exact URL', async () => {
    const payloads = [
      envelope(1, 20, syntheticRows(10, 100)),
      envelope(2, 20, syntheticRows(10, 110)),
    ]
    const { acquisition, pageFetch } = await capture(payloads)

    expect(mexcCopierHistoryUrl(TRADER_ID, 2)).toBe(
      'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/trader/followers/v2' +
        '?limit=10&page=2&uid=02298603'
    )
    expect(pageFetch).toHaveBeenCalledTimes(2)
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it('marks an exact caller-limited prefix partial', async () => {
    const { acquisition, pageFetch } = await capture(completeSnapshot(), source(), TRADER_ID, 2)

    expect(pageFetch).toHaveBeenCalledTimes(2)
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'caller_limited',
      scan_terminal_state: 'partial',
      blocker_reasons: ['caller_limit'],
    })
  })

  it('retains a config-capped prefix and fails closed before the reported total', async () => {
    const src = source({ meta: { copier_max_pages: 2 } })
    const { acquisition, pageFetch } = await capture(completeSnapshot().slice(0, 2), src)

    expect(pageFetch).toHaveBeenCalledTimes(2)
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[mexc] copiers reached page cap 2 before reported total 33',
      })
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
      blocker_reasons: ['upstream_error'],
    })
  })

  it.each([-0, '100'] as const)(
    'rejects invalid configured cap %p before publication evidence can be claimed',
    async (copierMaxPages) => {
      const src = source({ meta: { copier_max_pages: copierMaxPages } })
      const { acquisition, pageFetch } = await capture([], src)

      expect(pageFetch).not.toHaveBeenCalled()
      expect(acquisition.error).toEqual(
        expect.objectContaining({
          message: '[mexc] copier_max_pages must be a positive safe integer',
        })
      )
      expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
    }
  )

  it('retains both pages but fails closed when total metadata drifts', async () => {
    const drifting = envelope(2, 34, syntheticRows(10, 100))
    const { acquisition } = await capture([fixture(), drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[mexc] copiers changed total during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate masked follower identities across otherwise exact pages', async () => {
    const payloads = completeSnapshot()
    rows(payloads[1])[0].followerUid = rows(payloads[0])[0].followerUid
    const { acquisition } = await capture(payloads)

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[mexc] copiers returned a duplicate follower identity',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    ['top-level extra key', (payload) => (payload.unexpected = true)],
    ['code drift', (payload) => (payload.code = 200)],
    ['message drift', (payload) => (payload.message = 'success')],
    ['success drift', (payload) => (payload.success = false)],
    ['data extra key', (payload) => (data(payload).unexpected = true)],
    ['wrong current page', (payload) => (data(payload).currentPage = 2)],
    ['wrong offset', (payload) => (data(payload).offset = 10)],
    ['wrong page size', (payload) => (data(payload).pageSize = 20)],
    ['wrong total pages', (payload) => (data(payload).totalPage = 2)],
    ['negative total', (payload) => (data(payload).total = -1)],
    [
      'truncated nonterminal content',
      (payload) => (data(payload).content = rows(payload).slice(1)),
    ],
    ['row schema drift', (payload) => (rows(payload)[0].unexpected = true)],
    ['noncanonical follower id', (payload) => (rows(payload)[0].followerUid = '85000009')],
    [
      'duplicate follower id',
      (payload) => (rows(payload)[1].followerUid = rows(payload)[0].followerUid),
    ],
    ['noncanonical nickname', (payload) => (rows(payload)[0].nickname = ' masked ')],
    ['negative funds', (payload) => (rows(payload)[0].copyFunds = -1)],
    ['non-numeric profit', (payload) => (rows(payload)[0].copyProfit = 'NaN')],
    ['wrong settlement currency', (payload) => (rows(payload)[0].currency = 'USDC')],
    ['invalid reverse-copy flag', (payload) => (rows(payload)[0].reverseCopy = 2)],
  ]

  it.each(malformedCases)('retains then rejects %s', async (_label, mutate) => {
    const malformed = envelope(1, 10, syntheticRows(10, 100))
    mutate(malformed)
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[mexc] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects wrong URL, page order, terminal reason, cursor, source, and trader binding', async () => {
    const { acquisition } = await capture([envelope(1, 10, syntheticRows(10, 100))])
    const selected = verifier()
    const baseInput = {
      claim: {
        contract: 'arena.ingest.history-terminal-claim@1' as const,
        observations: [
          { segment_id: 'default' as const, reason: 'reported_end' as const, page_ordinal: 1 },
        ],
      },
      pages: acquisition.pages,
      cursor: null,
      source: { id: 10, slug: 'mexc_futures' },
      traderId: 91,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers' as const,
    }

    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], url: `${acquisition.pages[0].url}&offset=0` }],
      })
    ).toEqual({ verified: false })
    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], pageIndex: 2 }],
      })
    ).toEqual({ verified: false })
    expect(
      selected.verifyTerminal({
        ...baseInput,
        claim: {
          ...baseInput.claim,
          observations: [{ ...baseInput.claim.observations[0], reason: 'short_page' }],
        },
      })
    ).toEqual({ verified: false })
    expect(selected.verifyTerminal({ ...baseInput, cursor: PARSED_AT })).toEqual({
      verified: false,
    })
    expect(
      selected.verifyTerminal({ ...baseInput, source: { id: 10, slug: 'mexc_spot' } })
    ).toEqual({ verified: false })
    expect(selected.verifyTerminal({ ...baseInput, exchangeTraderId: '02298604' })).toEqual({
      verified: false,
    })
  })

  it('rejects every parser projection, shared-clock, order, hash, and RAW identity drift', async () => {
    const { acquisition } = await capture(completeSnapshot())
    const parsed = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(parsed.slice(0, -1))).toEqual({ verified: false })
    expect(verify([parsed[1], parsed[0], ...parsed.slice(2)])).toEqual({ verified: false })

    const drifts: ParsedCopierRow[] = [
      { ...parsed[0], kind: 'copiers', ts: '2026-08-04T12:00:00Z' },
      { ...parsed[0], kind: 'copiers', ts: new Date(Date.now() + 60_000).toISOString() },
      { ...parsed[0], kind: 'copiers', copierLabel: 'other' },
      { ...parsed[0], kind: 'copiers', copierPnl: (parsed[0].copierPnl ?? 0) + 1 },
      { ...parsed[0], kind: 'copiers', copierInvested: (parsed[0].copierInvested ?? 0) + 1 },
      { ...parsed[0], kind: 'copiers', copyDurationDays: 1 },
      { ...parsed[0], kind: 'copiers', dedupeHash: 'not-the-source-hash' },
      { ...parsed[0], kind: 'copiers', raw: clone(parsed[0].raw) },
    ]
    for (const drift of drifts) {
      expect(verify([drift, ...parsed.slice(1)])).toEqual({ verified: false })
    }
  })

  it('accepts the preserved real first-page capture as exact nonterminal schema evidence', () => {
    expect(fixture()).toMatchObject({
      code: 0,
      success: true,
      message: '',
      data: { currentPage: 1, offset: 0, pageSize: 10, total: 33, totalPage: 4 },
    })
    expect(rows(fixture())).toHaveLength(10)
    expect(validateMexcCopierPage(fixture(), 1)).toMatchObject({ total: 33, totalPage: 4 })
  })
})
