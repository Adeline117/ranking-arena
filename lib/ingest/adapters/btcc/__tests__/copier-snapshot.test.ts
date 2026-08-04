import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  BTCC_COPIER_HISTORY_URL,
  BTCC_COPIER_PAGE_ENVELOPE_CONTRACT,
  BTCC_COPIER_PAGE_SIZE,
} from '../copier-contract'
import { btccCopierRequest, validateBtccCopierPage } from '../copier-snapshot'
import { btccAdapter } from '../index'

const TRADER_ID = '1941565'
const PARSED_AT = new Date(Date.now() - 1_000).toISOString()
const DAY_MS = 86_400_000

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'followers-p1.json'), 'utf8')) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 23,
    slug: 'btcc_futures',
    exchange_id: 23,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'btcc',
    leaderboard_url: 'https://www.btcc.com/en-US/copy-trading?type=all',
    timeframes_native: [30],
    timeframes_derived: [7, 90],
    tf_label_map: { '7D': 7, '1M': 30, '3M': 90 },
    expected_count: 1_300,
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
    meta: { derived_board_sort: 'roi' },
    ...overrides,
  }
}

function fixtureRows(): Dict[] {
  return fixture().rows as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const templates = fixtureRows()
  const parsedAt = Date.parse(PARSED_AT)
  return Array.from({ length: count }, (_, index) => {
    const row = clone(templates[index % templates.length])
    return {
      ...row,
      userId: 9_000_000 + start + index,
      nickName: `btcc-copier-${start + index}`,
      followTime: parsedAt - (start + index + 1) * DAY_MS,
      cumulativeNetProfit: start + index + 0.25,
    }
  })
}

function response(page: number, total: number, rows: Dict[]): Dict {
  return {
    total,
    rows,
    code: 200,
    msg: '请求成功',
    pageNum: page,
    pageSize: BTCC_COPIER_PAGE_SIZE,
    extended: null,
  }
}

function wrapper(page: number, payload: Dict, exchangeTraderId = TRADER_ID): Dict {
  return {
    contract: BTCC_COPIER_PAGE_ENVELOPE_CONTRACT,
    exchangeTraderId,
    request: btccCopierRequest(exchangeTraderId, page),
    response: payload,
  }
}

function responseRows(payload: Dict): Dict[] {
  return payload.rows as Dict[]
}

function wrappedResponse(payload: Dict): Dict {
  return payload.response as Dict
}

function session(responses: readonly unknown[]): {
  fetchSession: FetchSession
  post: jest.Mock
} {
  let responseIndex = 0
  const post = jest.fn(async () => ({
    status: () => 200,
    json: async () => responses[responseIndex++],
  }))
  const api = { post } as Awaited<ReturnType<FetchSession['api']>>
  return {
    post,
    fetchSession: {
      sourceSlug: 'btcc_futures',
      api: async () => api,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = btccAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed BTCC copier verifier')
  return selected
}

async function capture(
  responses: readonly unknown[],
  src = source(),
  exchangeTraderId = TRADER_ID,
  callerPageCap: number | null = null,
  cursor: string | null = null
) {
  const { fetchSession, post } = session(responses)
  const selected = verifier(src)
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: 91,
    exchangeTraderId,
    kind: 'copiers',
    cursor,
    attemptStartedAt: PARSED_AT,
    callerPageCap,
    stream: btccAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', cursor),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
  return { acquisition, post }
}

function parseRows(
  pages: Awaited<ReturnType<typeof capture>>['acquisition']['pages'],
  src = source()
): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      btccAdapter.parseHistory(page.payload, 'copiers', {
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
  return [response(1, 53, syntheticRows(50, 0)), response(2, 53, syntheticRows(3, 50))]
}

describe('BTCC full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures human USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.btcc.copiers@1',
    })
    expect(btccAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(btccAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(btccAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'bot' }))).toBeNull()
    expect(btccAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(btccAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(btccAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      btccAdapter.verifyCopierSnapshot?.(source({ slug: 'btcc_spot', product_type: 'spot' }))
    ).toBeNull()
    expect(
      btccAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { copiers: 'https://proxy.example.test/followers' } } })
      )
    ).toBeNull()
  })

  it('captures exact POST bodies and proves a complete 50+3 snapshot', async () => {
    const responses = completeSnapshot()
    const { acquisition, post } = await capture(responses)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages.map((page) => page.url)).toEqual([
      BTCC_COPIER_HISTORY_URL,
      BTCC_COPIER_HISTORY_URL,
    ])
    expect(post.mock.calls).toHaveLength(2)
    expect(post.mock.calls.map(([url, options]) => ({ url, data: options.data }))).toEqual([
      { url: BTCC_COPIER_HISTORY_URL, data: btccCopierRequest(TRADER_ID, 1) },
      { url: BTCC_COPIER_HISTORY_URL, data: btccCopierRequest(TRADER_ID, 2) },
    ])
    expect(acquisition.pages.map((page) => page.payload)).toEqual([
      wrapper(1, responses[0]),
      wrapper(2, responses[1]),
    ])
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 2 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    const sourceRows = acquisition.pages.flatMap((page) =>
      responseRows(wrappedResponse(page.payload as Dict))
    )
    expect(rows).toHaveLength(53)
    rows.forEach((row, index) => expect(row.raw).toBe(sourceRows[index]))
    expect(rows.every((row) => row.ts === PARSED_AT)).toBe(true)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 53 })
  })

  it('retains and proves an explicit successful zero page', async () => {
    const empty = response(1, 0, [])
    const { acquisition, post } = await capture([empty])

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.pages[0].payload).toEqual(wrapper(1, empty))
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

  it('accepts a full 50-row terminal page without probing an empty page', async () => {
    const full = response(1, 50, syntheticRows(50, 0))
    const { acquisition, post } = await capture([full])

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: true, envelopeRowCount: 50 })
  })

  it('covers the captured 2,861-person population in 58 pages under the default safety budget', async () => {
    const total = 2_861
    const responses = Array.from(
      { length: Math.ceil(total / BTCC_COPIER_PAGE_SIZE) },
      (_, index) => {
        const start = index * BTCC_COPIER_PAGE_SIZE
        const count = Math.min(BTCC_COPIER_PAGE_SIZE, total - start)
        return response(index + 1, total, syntheticRows(count, start))
      }
    )
    const { acquisition, post } = await capture(responses)

    expect(post).toHaveBeenCalledTimes(58)
    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(58)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 58 }],
      scan_terminal_state: 'exhausted',
    })
    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(total)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: total })
  })

  it('binds a canonical numeric trader id and rejects lossy request coordinates', () => {
    expect(btccCopierRequest(TRADER_ID, 2)).toEqual({
      pageNum: 2,
      pageSize: 50,
      traderId: 1941565,
    })
    expect(() => btccCopierRequest('01941565', 1)).toThrow('request coordinates are invalid')
    expect(() => btccCopierRequest('1941565 ', 1)).toThrow('request coordinates are invalid')
    expect(() => btccCopierRequest(TRADER_ID, -0)).toThrow('request coordinates are invalid')
  })

  it('marks a caller-limited exact first page partial', async () => {
    const { acquisition, post } = await capture(completeSnapshot(), source(), TRADER_ID, 1)

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'caller_limited',
      scan_terminal_state: 'partial',
      blocker_reasons: ['caller_limit'],
    })
  })

  it('retains a config-capped prefix and throws before reported total', async () => {
    const src = source({ meta: { copier_max_pages: 1 } })
    const { acquisition, post } = await capture([completeSnapshot()[0]], src)

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[btcc] copiers reached page cap 1 before reported total 53',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it.each([-0, '100'] as const)('rejects invalid configured cap %p', async (cap) => {
    const src = source({ meta: { copier_max_pages: cap } })
    const { acquisition, post } = await capture([], src)

    expect(post).not.toHaveBeenCalled()
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[btcc] copier_max_pages must be a positive safe integer',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('retains both pages but rejects total drift', async () => {
    const drifting = response(2, 54, syntheticRows(4, 50))
    const { acquisition } = await capture([completeSnapshot()[0], drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[btcc] copiers changed total during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('retains then rejects an early empty page that still has remaining total', async () => {
    const earlyEmpty = response(2, 53, [])
    const { acquisition } = await capture([completeSnapshot()[0], earlyEmpty])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[btcc] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate user identities across otherwise exact pages', async () => {
    const responses = completeSnapshot()
    responseRows(responses[1])[0].userId = responseRows(responses[0])[0].userId
    const { acquisition } = await capture(responses)

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[btcc] copiers returned a duplicate user identity' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    ['response extra key', (payload) => (payload.success = true)],
    ['code drift', (payload) => (payload.code = 0)],
    ['message drift', (payload) => (payload.msg = 'success')],
    ['extended drift', (payload) => (payload.extended = {})],
    ['pageNum drift', (payload) => (payload.pageNum = 2)],
    ['pageSize drift', (payload) => (payload.pageSize = 3)],
    ['negative total', (payload) => (payload.total = -1)],
    ['truncated page', (payload) => (payload.rows = responseRows(payload).slice(0, 49))],
    ['candidate schema drift', (payload) => (responseRows(payload)[0].unexpected = true)],
    ['string user identity', (payload) => (responseRows(payload)[0].userId = '9000000')],
    ['invalid follow time', (payload) => (responseRows(payload)[0].followTime = 0)],
    ['blank nickname', (payload) => (responseRows(payload)[0].nickName = '')],
  ]

  it.each(malformedCases)('retains then rejects %s', async (_label, mutate) => {
    const malformed = response(1, 50, syntheticRows(50, 0))
    mutate(malformed)
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[btcc] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects non-canonical negative-zero RAW before it can enter the page ledger', async () => {
    const malformed = response(1, 50, syntheticRows(50, 0))
    responseRows(malformed)[0].cumulativeNetProfit = -0
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(0)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/negative zero/i) })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects wrapper/body/URL/page/terminal/cursor/source/trader drift', async () => {
    const { acquisition } = await capture([response(1, 50, syntheticRows(50, 0))])
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
      source: { id: 23, slug: 'btcc_futures' },
      traderId: 91,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers' as const,
    }
    const payload = acquisition.pages[0].payload as Dict

    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], url: `${BTCC_COPIER_HISTORY_URL}?page=1` }],
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
        pages: [
          {
            ...acquisition.pages[0],
            payload: { ...payload, request: { ...btccCopierRequest(TRADER_ID, 1), pageSize: 3 } },
          },
        ],
      })
    ).toEqual({ verified: false })
    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [
          {
            ...acquisition.pages[0],
            payload: { ...payload, exchangeTraderId: '1941566' },
          },
        ],
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
    expect(selected.verifyTerminal({ ...baseInput, cursor: '2026-08-01T00:00:00.000Z' })).toEqual({
      verified: false,
    })
    expect(
      selected.verifyTerminal({ ...baseInput, source: { id: 23, slug: 'btcc_spot' } })
    ).toEqual({ verified: false })
    expect(selected.verifyTerminal({ ...baseInput, exchangeTraderId: '1941566' })).toEqual({
      verified: false,
    })
  })

  it('rejects every parser projection, shared clock, order, hash, and RAW identity drift', async () => {
    const { acquisition } = await capture(completeSnapshot())
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows.slice(0, -1))).toEqual({ verified: false })
    expect(verify([rows[1], rows[0], ...rows.slice(2)])).toEqual({ verified: false })

    const drifts: ParsedCopierRow[] = [
      { ...rows[0], kind: 'copiers', ts: '2026-08-04T12:00:00Z' },
      { ...rows[0], kind: 'copiers', ts: new Date(Date.now() + DAY_MS).toISOString() },
      { ...rows[0], kind: 'copiers', copierLabel: 'other' },
      { ...rows[0], kind: 'copiers', copierPnl: (rows[0].copierPnl ?? 0) + 1 },
      { ...rows[0], kind: 'copiers', copierInvested: 1 },
      { ...rows[0], kind: 'copiers', copyDurationDays: (rows[0].copyDurationDays ?? 0) + 1 },
      { ...rows[0], kind: 'copiers', dedupeHash: 'not-the-source-hash' },
      { ...rows[0], kind: 'copiers', raw: clone(rows[0].raw) },
    ]
    for (const drift of drifts) {
      expect(verify([drift, ...rows.slice(1)])).toEqual({ verified: false })
    }
  })

  it('keeps the real three-row capture as schema evidence, not a production terminal page', () => {
    const captured = fixture()
    expect(captured).toMatchObject({
      total: 2861,
      code: 200,
      msg: '请求成功',
      pageNum: 1,
      pageSize: 3,
      extended: null,
    })
    expect(fixtureRows()).toHaveLength(3)
    expect(validateBtccCopierPage(wrapper(1, captured), 1, TRADER_ID)).toBeNull()
  })
})
