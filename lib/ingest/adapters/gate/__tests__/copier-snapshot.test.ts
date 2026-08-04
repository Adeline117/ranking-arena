import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import {
  GATE_COPIER_PAGE_SIZE,
  gateCopierHistoryUrl,
  validateGateCopierPage,
} from '../copier-snapshot'
import { gateAdapter } from '../index'

const TRADER_ID = '16553'
const PARSED_AT = '2026-08-04T12:00:00.000Z'
const ATTEMPT_STARTED_AT = '2026-08-04T11:59:59.000Z'

type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'follow-user-p1.json'), 'utf8')
  ) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 16,
    slug: 'gate_futures',
    exchange_id: 16,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'gate',
    leaderboard_url: 'https://www.gate.com/zh/copytrading',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 170,
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
    meta: { boardKey: 'futures' },
    ...overrides,
  }
}

function fixtureRows(): Dict[] {
  return fixture().data as Dict[]
}

function syntheticRows(count: number, start: number): Dict[] {
  const templates = fixtureRows()
  return Array.from({ length: count }, (_, index) => {
    const row = clone(templates[index % templates.length])
    return {
      ...row,
      follow_id: 900_000 + start + index,
      leader_id: Number(TRADER_ID),
      create_time: 1_780_000_000 + start + index,
      follow_day: start + index,
    }
  })
}

function envelope(page: number, total: number, rows: Dict[]): Dict {
  return {
    code: 200,
    label: '',
    message: '',
    page,
    pagesize: GATE_COPIER_PAGE_SIZE,
    pagecount: Math.ceil(total / GATE_COPIER_PAGE_SIZE),
    totalcount: total,
    data: rows,
  }
}

function data(payload: Dict): Dict[] {
  return payload.data as Dict[]
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
      sourceSlug: 'gate_futures',
      page: async () => page,
      pageFetch,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as unknown as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = gateAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed Gate copier verifier')
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
    attemptStartedAt: ATTEMPT_STARTED_AT,
    callerPageCap,
    stream: gateAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', null),
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
      gateAdapter.parseHistory(page.payload, 'copiers', {
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
  return [envelope(1, 13, syntheticRows(10, 0)), envelope(2, 13, syntheticRows(3, 10))]
}

describe('Gate futures full copier snapshot authority', () => {
  it('selects only the canonical active-serving futures human USDT full source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.gate.copiers@1',
    })
    expect(gateAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'bot' }))).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(
      gateAdapter.verifyCopierSnapshot?.(
        source({ slug: 'gate_cfd', product_type: 'cfd', currency: 'USDx' })
      )
    ).toBeNull()
    expect(gateAdapter.verifyCopierSnapshot?.(source({ meta: {} }))).toBeNull()
    expect(
      gateAdapter.verifyCopierSnapshot?.(
        source({
          meta: {
            boardKey: 'futures',
            endpoints: { copiers: 'https://proxy.example.test/follow_user' },
          },
        })
      )
    ).toBeNull()
  })

  it('captures exact 10+3 pages and proves terminal/parser/RAW conservation', async () => {
    const payloads = completeSnapshot()
    const { acquisition, pageFetch } = await capture(payloads)

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages.map((page) => page.payload)).toEqual(payloads)
    expect(acquisition.pages.map((page) => page.url)).toEqual([
      gateCopierHistoryUrl(TRADER_ID, 1),
      gateCopierHistoryUrl(TRADER_ID, 2),
    ])
    expect(pageFetch.mock.calls.map(([request]) => request.url)).toEqual([
      gateCopierHistoryUrl(TRADER_ID, 1),
      gateCopierHistoryUrl(TRADER_ID, 2),
    ])
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 2 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    const sourceRows = acquisition.pages.flatMap((page) => data(page.payload as Dict))
    expect(rows).toHaveLength(13)
    rows.forEach((row, index) => expect(row.raw).toBe(sourceRows[index]))
    expect(rows.every((row) => row.ts === PARSED_AT)).toBe(true)
    expect(rows[0].copyDurationDays).toBe(0)
    expect(rows[12].copyDurationDays).toBe(12)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 13 })
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

  it('proves a full ten-row terminal page and binds exact encoded coordinates', async () => {
    const complete = envelope(1, 10, syntheticRows(10, 0))
    const { acquisition, pageFetch } = await capture([complete])

    expect(gateCopierHistoryUrl('leader /+1', 2)).toBe(
      'https://www.gate.com/api/copytrade/copy_trading/trader/follow_user' +
        '?sub_website_id=0&leader_id=leader%20%2F%2B1&page_size=10&page=2&status=running'
    )
    expect(pageFetch.mock.calls[0][0].url).toBe(gateCopierHistoryUrl(TRADER_ID, 1))
    expect(acquisition.artifact.termination.evidence_state).toBe('verified')
  })

  it('marks a caller-limited exact prefix partial', async () => {
    const { acquisition, pageFetch } = await capture(completeSnapshot(), source(), TRADER_ID, 1)

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'caller_limited',
      scan_terminal_state: 'partial',
      blocker_reasons: ['caller_limit'],
    })
  })

  it('retains a config-capped prefix and fails closed before reported total', async () => {
    const src = source({ meta: { boardKey: 'futures', copier_max_pages: 1 } })
    const { acquisition, pageFetch } = await capture([completeSnapshot()[0]], src)

    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[gate] copiers reached page cap 1 before reported total 13',
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
      const src = source({ meta: { boardKey: 'futures', copier_max_pages: copierMaxPages } })
      const { acquisition, pageFetch } = await capture([], src)

      expect(pageFetch).not.toHaveBeenCalled()
      expect(acquisition.error).toEqual(
        expect.objectContaining({
          message: '[gate] copier_max_pages must be a positive safe integer',
        })
      )
      expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
    }
  )

  it('retains both pages but fails closed when totalcount drifts', async () => {
    const drifting = envelope(2, 14, syntheticRows(4, 10))
    const { acquisition } = await capture([completeSnapshot()[0], drifting])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[gate] copiers changed totalcount during pagination' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate follow identities across otherwise exact pages', async () => {
    const payloads = completeSnapshot()
    data(payloads[1])[0].follow_id = data(payloads[0])[0].follow_id
    const { acquisition } = await capture(payloads)

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[gate] copiers returned a duplicate follow identity' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  const malformedCases: Array<readonly [string, (payload: Dict) => void]> = [
    ['top-level extra key', (payload) => (payload.success = true)],
    ['code drift', (payload) => (payload.code = 0)],
    ['label drift', (payload) => (payload.label = null)],
    ['message drift', (payload) => (payload.message = 'ok')],
    ['wrong page', (payload) => (payload.page = 2)],
    ['wrong pagesize', (payload) => (payload.pagesize = 20)],
    ['pagecount drift', (payload) => (payload.pagecount = 2)],
    ['negative totalcount', (payload) => (payload.totalcount = -1)],
    ['truncated nonterminal page', (payload) => (payload.data = data(payload).slice(0, 9))],
    ['row schema drift', (payload) => (data(payload)[0].unexpected = true)],
    ['wrong leader identity', (payload) => (data(payload)[0].leader_id = 16554)],
    ['invalid follow identity', (payload) => (data(payload)[0].follow_id = '900000')],
    ['invalid relationship clock', (payload) => (data(payload)[0].create_time = 0)],
    ['negative follow duration', (payload) => (data(payload)[0].follow_day = -1)],
    ['noncanonical pnl', (payload) => (data(payload)[0].profit = '01.00')],
    ['noncanonical investment', (payload) => (data(payload)[0].follow_money = '1e3')],
  ]

  it.each(malformedCases)('retains then rejects %s', async (_label, mutate) => {
    const malformed = envelope(1, 10, syntheticRows(10, 0))
    mutate(malformed)
    const { acquisition } = await capture([malformed])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[gate] copiers returned a malformed exact page envelope',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects wrong URL, page order, terminal reason, cursor, source, and trader binding', async () => {
    const { acquisition } = await capture([envelope(1, 10, syntheticRows(10, 0))])
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
      source: { id: 16, slug: 'gate_futures' },
      traderId: 91,
      exchangeTraderId: TRADER_ID,
      kind: 'copiers' as const,
    }

    expect(
      selected.verifyTerminal({
        ...baseInput,
        pages: [{ ...acquisition.pages[0], url: `${acquisition.pages[0].url}&limit=10` }],
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
    expect(selected.verifyTerminal({ ...baseInput, cursor: '2026-08-01T00:00:00.000Z' })).toEqual({
      verified: false,
    })
    expect(selected.verifyTerminal({ ...baseInput, source: { id: 16, slug: 'gate_cfd' } })).toEqual(
      { verified: false }
    )
    expect(selected.verifyTerminal({ ...baseInput, exchangeTraderId: '16554' })).toEqual({
      verified: false,
    })
  })

  it('rejects every parser projection, shared-clock, order, hash, and RAW identity drift', async () => {
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
      { ...rows[0], kind: 'copiers', ts: '2026-08-04T13:00:00.000Z' },
      { ...rows[0], kind: 'copiers', copierLabel: 'other' },
      { ...rows[0], kind: 'copiers', copierPnl: (rows[0].copierPnl ?? 0) + 1 },
      { ...rows[0], kind: 'copiers', copierInvested: (rows[0].copierInvested ?? 0) + 1 },
      { ...rows[0], kind: 'copiers', copyDurationDays: (rows[0].copyDurationDays ?? 0) + 1 },
      { ...rows[0], kind: 'copiers', dedupeHash: 'not-the-source-hash' },
      { ...rows[0], kind: 'copiers', raw: clone(rows[0].raw) },
    ]
    for (const drift of drifts) {
      expect(verify([drift, ...rows.slice(1)])).toEqual({ verified: false })
    }
  })

  it('treats the preserved three-row real capture as schema evidence, not a false full page', () => {
    expect(fixture()).toMatchObject({
      code: 200,
      page: 1,
      pagesize: 10,
      pagecount: 53,
      totalcount: 525,
    })
    expect(fixtureRows()).toHaveLength(3)
    expect(validateGateCopierPage(fixture(), 1, TRADER_ID)).toBeNull()
  })
})
