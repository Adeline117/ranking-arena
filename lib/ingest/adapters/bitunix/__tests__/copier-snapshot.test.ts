import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  BITUNIX_COPIER_HISTORY_URL,
  BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT,
  BITUNIX_COPIER_PAGE_SIZE,
} from '../copier-contract'
import { bitunixCopierRequest, validateBitunixCopierPage } from '../copier-snapshot'
import { bitunixAdapter } from '../index'

const TRADER_ID = '348686197'
const PARSED_AT = new Date(Date.now() - 1_000).toISOString()
const DAY_MS = 86_400_000

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'follow-list-p1.json'), 'utf8')
  ) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 24,
    slug: 'bitunix_futures',
    exchange_id: 24,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'bitunix',
    leaderboard_url: 'https://www.bitunix.com/zh-tw/copy-trading/square/2/PL/1',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 4_005,
    deep_profile_topn: 100,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 9,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 500,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: { charts_utc0_labeled: true, site_refresh_minutes: 10 },
    ...overrides,
  }
}

function fixtureRows(): Dict[] {
  return ((fixture().data as Dict).records ?? []) as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const templates = fixtureRows()
  return Array.from({ length: count }, (_, index) => {
    const ordinal = start + index
    const row = clone(templates[index % templates.length])
    const followedAt = new Date(Date.parse(PARSED_AT) - (ordinal + 1) * DAY_MS).toISOString()
    return {
      ...row,
      uid: ordinal % 2 === 0 ? null : 800_000_000 + ordinal,
      puid: ordinal % 2 === 0 ? null : 200_000_000 + ordinal,
      nickname: `copier-${ordinal}****@example.com`,
      followAmount: `${ordinal + 10}.25`,
      day: ordinal + 1,
      followDate: followedAt,
      endFollowDate: null,
      roi: ordinal % 2 === 0 ? '0.125' : '-0.25',
      pl: ordinal % 2 === 0 ? `${ordinal + 1}.5` : `-${ordinal + 1}.5`,
      status: 1,
    }
  })
}

function response(page: number, total: number, records: Dict[]): Dict {
  return {
    code: 0,
    msg: 'result.success',
    data: {
      records,
      total,
      totalPage: Math.ceil(total / BITUNIX_COPIER_PAGE_SIZE),
      page,
    },
    success: true,
  }
}

function wrapper(page: number, payload: Dict, exchangeTraderId = TRADER_ID): Dict {
  return {
    contract: BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT,
    exchangeTraderId,
    request: bitunixCopierRequest(exchangeTraderId, page),
    response: payload,
  }
}

function data(payload: Dict): Dict {
  return payload.data as Dict
}

function responseRows(payload: Dict): Dict[] {
  return data(payload).records as Dict[]
}

function wrappedResponse(payload: Dict): Dict {
  return payload.response as Dict
}

function completeSnapshot(): Dict[] {
  return [response(1, 23, syntheticRows(20, 0)), response(2, 23, syntheticRows(3, 20))]
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
      sourceSlug: 'bitunix_futures',
      api: async () => api,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = bitunixAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed Bitunix copier verifier')
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
    stream: bitunixAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', cursor),
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
      bitunixAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: PARSED_AT,
        meta: src.meta,
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('Bitunix futures full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures human USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.bitunix.copiers@1',
    })
    expect(bitunixAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(bitunixAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(bitunixAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'mixed' }))).toBeNull()
    expect(
      bitunixAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))
    ).toBeNull()
    expect(bitunixAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(bitunixAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      bitunixAdapter.verifyCopierSnapshot?.(source({ slug: 'bitunix_spot', product_type: 'spot' }))
    ).toBeNull()
    expect(
      bitunixAdapter.verifyCopierSnapshot?.(
        source({ meta: { endpoints: { copiers: 'https://proxy.example.test/followers' } } })
      )
    ).toBeNull()
  })

  it('binds exact POST requests into RAW and proves a complete 20+3 snapshot', async () => {
    const responses = completeSnapshot()
    const { acquisition, post } = await capture(responses)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages.map((page) => page.url)).toEqual([
      BITUNIX_COPIER_HISTORY_URL,
      BITUNIX_COPIER_HISTORY_URL,
    ])
    expect(post.mock.calls.map(([url, options]) => ({ url, data: options.data }))).toEqual([
      { url: BITUNIX_COPIER_HISTORY_URL, data: bitunixCopierRequest(TRADER_ID, 1) },
      { url: BITUNIX_COPIER_HISTORY_URL, data: bitunixCopierRequest(TRADER_ID, 2) },
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

    const parsed = parseRows(acquisition.pages)
    const sourceRows = acquisition.pages.flatMap((page) =>
      responseRows(wrappedResponse(page.payload as Dict))
    )
    expect(parsed).toHaveLength(23)
    parsed.forEach((row, index) => expect(row.raw).toBe(sourceRows[index]))
    expect(parsed.every((row) => row.ts === PARSED_AT)).toBe(true)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parsed,
      })
    ).toEqual({ verified: true, envelopeRowCount: 23 })
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
      blocker_reasons: [],
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: [],
      })
    ).toEqual({ verified: true, envelopeRowCount: 0 })
  })

  it('accepts an exact full 20-row terminal page without probing empty page two', async () => {
    const full = response(1, 20, syntheticRows(20, 0))
    const { acquisition, post } = await capture([full])

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: true, envelopeRowCount: 20 })
  })

  it('binds a canonical numeric trader id and rejects lossy request coordinates', () => {
    expect(bitunixCopierRequest(TRADER_ID, 2)).toEqual({
      traderUid: 348686197,
      page: 2,
      pageSize: 20,
    })
    expect(() => bitunixCopierRequest(`0${TRADER_ID}`, 1)).toThrow(
      'request coordinates are invalid'
    )
    expect(() => bitunixCopierRequest(`${TRADER_ID} `, 1)).toThrow(
      'request coordinates are invalid'
    )
    expect(() => bitunixCopierRequest(TRADER_ID, -0)).toThrow('request coordinates are invalid')
  })

  it('marks an exact caller-limited prefix partial', async () => {
    const { acquisition, post } = await capture(completeSnapshot(), source(), TRADER_ID, 1)

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'caller_limited',
      scan_terminal_state: 'partial',
      blocker_reasons: ['caller_limit'],
    })
  })

  it('retains a config-capped prefix and throws before the reported total', async () => {
    const src = source({ meta: { copier_max_pages: 1 } })
    const { acquisition, post } = await capture([completeSnapshot()[0]], src)

    expect(post).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[bitunix] copiers reached page cap 1 before reported total 23',
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
        message: '[bitunix] copier_max_pages must be a positive safe integer',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('retains both pages but rejects total drift', async () => {
    const drifting = response(2, 24, syntheticRows(4, 20))
    const { acquisition } = await capture([completeSnapshot()[0], drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[bitunix] copiers changed total during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('retains then rejects an early empty page while total remains', async () => {
    const earlyEmpty = response(2, 23, [])
    const { acquisition } = await capture([completeSnapshot()[0], earlyEmpty])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[bitunix] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate follower identities across otherwise exact pages', async () => {
    const responses = completeSnapshot()
    const duplicate = responseRows(responses[0])[0]
    const terminal = responseRows(responses[1])[0]
    terminal.uid = duplicate.uid
    terminal.nickname = duplicate.nickname
    terminal.followDate = duplicate.followDate
    const { acquisition } = await capture(responses)

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[bitunix] copiers returned a duplicate follower identity',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects one follower repeated across uid-visible and uid-redacted rows', async () => {
    const withUid = syntheticRows(1, 1)[0]
    const withoutUid = {
      ...syntheticRows(1, 2)[0],
      uid: null,
      puid: null,
      nickname: withUid.nickname,
      followDate: withUid.followDate,
    }
    const { acquisition } = await capture([response(1, 2, [withUid, withoutUid])])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[bitunix] copiers returned a malformed exact page envelope',
      })
    )
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: false })
  })

  it('accepts current public 17-decimal values without unsafe integer or underflow coercion', async () => {
    const rows = syntheticRows(20, 0)
    rows[0].followAmount = '741.63038515687515083'
    rows[0].pl = '20.95057450687515083'
    rows[0].roi = '0.0291'
    const { acquisition } = await capture([response(1, 20, rows)])
    const parsed = parseRows(acquisition.pages)

    expect(acquisition.error).toBeNull()
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    expect(parsed[0]).toMatchObject({
      copierInvested: Number(rows[0].followAmount),
      copierPnl: Number(rows[0].pl),
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parsed,
      })
    ).toEqual({ verified: true, envelopeRowCount: 20 })
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    ['response extra key', (payload) => (payload.unexpected = true)],
    ['code drift', (payload) => (payload.code = 200)],
    ['message drift', (payload) => (payload.msg = 'success')],
    ['success drift', (payload) => (payload.success = false)],
    ['data extra key', (payload) => (data(payload).unexpected = true)],
    ['page drift', (payload) => (data(payload).page = 2)],
    ['total-page drift', (payload) => (data(payload).totalPage = 2)],
    ['negative total', (payload) => (data(payload).total = -1)],
    ['truncated page', (payload) => (data(payload).records = responseRows(payload).slice(1))],
    ['candidate schema drift', (payload) => (responseRows(payload)[0].unexpected = true)],
    ['string user id', (payload) => (responseRows(payload)[0].uid = '800000000')],
    ['invalid parent id', (payload) => (responseRows(payload)[0].puid = 0)],
    ['blank nickname', (payload) => (responseRows(payload)[0].nickname = '')],
    ['non-HTTPS avatar', (payload) => (responseRows(payload)[0].header = 'http://example.com/a')],
    ['negative investment', (payload) => (responseRows(payload)[0].followAmount = '-1')],
    ['noncanonical investment', (payload) => (responseRows(payload)[0].followAmount = '01.0')],
    [
      'lossy investment integer',
      (payload) => (responseRows(payload)[0].followAmount = '9007199254740993'),
    ],
    [
      'fraction beyond safe-integer magnitude',
      (payload) => (responseRows(payload)[0].followAmount = '9007199254740991.1'),
    ],
    [
      'underflowing investment',
      (payload) => (responseRows(payload)[0].followAmount = `0.${'0'.repeat(323)}1`),
    ],
    ['negative-zero PnL', (payload) => (responseRows(payload)[0].pl = '-0')],
    ['lossy PnL integer', (payload) => (responseRows(payload)[0].pl = '9007199254740993')],
    ['non-numeric ROI', (payload) => (responseRows(payload)[0].roi = 'NaN')],
    ['lossy ROI integer', (payload) => (responseRows(payload)[0].roi = '9007199254740993')],
    ['negative duration', (payload) => (responseRows(payload)[0].day = -1)],
    ['invalid follow date', (payload) => (responseRows(payload)[0].followDate = 'yesterday')],
    [
      'noncanonical follow date precision',
      (payload) => (responseRows(payload)[0].followDate = '2026-06-18T20:00:53.1Z'),
    ],
    ['ended follower', (payload) => (responseRows(payload)[0].endFollowDate = PARSED_AT)],
    ['inactive follower', (payload) => (responseRows(payload)[0].status = 0)],
  ]

  it.each(malformedCases)('retains then rejects %s', async (_label, mutate) => {
    const malformed = response(1, 20, syntheticRows(20, 0))
    mutate(malformed)
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[bitunix] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects non-canonical numeric negative zero before the RAW ledger', async () => {
    const malformed = response(1, 20, syntheticRows(20, 0))
    responseRows(malformed)[0].day = -0
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(0)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/negative zero/i) })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects wrapper/body/URL/page/terminal/cursor/source/trader drift', async () => {
    const { acquisition } = await capture([response(1, 20, syntheticRows(20, 0))])
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
      source: { id: 24, slug: 'bitunix_futures' },
      traderId: 91,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers' as const,
    }
    const payload = acquisition.pages[0].payload as Dict

    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], url: `${BITUNIX_COPIER_HISTORY_URL}?page=1` }],
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
            payload: {
              ...payload,
              request: { ...bitunixCopierRequest(TRADER_ID, 1), pageSize: 3 },
            },
          },
        ],
      })
    ).toEqual({ verified: false })
    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], payload: { ...payload, exchangeTraderId: '1' } }],
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
      selected.verifyTerminal({ ...baseInput, source: { id: 24, slug: 'bitunix_spot' } })
    ).toEqual({ verified: false })
    expect(selected.verifyTerminal({ ...baseInput, exchangeTraderId: '348686198' })).toEqual({
      verified: false,
    })
  })

  it('rejects every parser projection, shared clock, order, hash, and RAW identity drift', async () => {
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
      { ...parsed[0], kind: 'copiers', ts: new Date(Date.now() + DAY_MS).toISOString() },
      { ...parsed[0], kind: 'copiers', copierLabel: 'other' },
      { ...parsed[0], kind: 'copiers', copierPnl: (parsed[0].copierPnl ?? 0) + 1 },
      { ...parsed[0], kind: 'copiers', copierInvested: (parsed[0].copierInvested ?? 0) + 1 },
      { ...parsed[0], kind: 'copiers', copyDurationDays: (parsed[0].copyDurationDays ?? 0) + 1 },
      { ...parsed[0], kind: 'copiers', dedupeHash: 'not-the-source-hash' },
      { ...parsed[0], kind: 'copiers', raw: clone(parsed[0].raw) },
    ]
    for (const drift of drifts) {
      expect(verify([drift, ...parsed.slice(1)])).toEqual({ verified: false })
    }
  })

  it('rejects a source row whose follow clock is after the shared parser clock', async () => {
    const full = response(1, 20, syntheticRows(20, 0))
    responseRows(full)[0].followDate = new Date(Date.parse(PARSED_AT) + DAY_MS).toISOString()
    const { acquisition } = await capture([full])
    const parsed = parseRows(acquisition.pages)

    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parsed,
      })
    ).toEqual({ verified: false })
  })

  it('keeps the real three-row capture as schema evidence, not a terminal 20-row page', () => {
    const captured = fixture()
    expect(captured).toMatchObject({
      code: 0,
      msg: 'result.success',
      success: true,
      data: { page: 1, total: 5, totalPage: 2 },
    })
    expect(fixtureRows()).toHaveLength(3)
    expect(validateBitunixCopierPage(wrapper(1, captured), 1, TRADER_ID)).toBeNull()
  })
})
