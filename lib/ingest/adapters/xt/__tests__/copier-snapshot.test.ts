import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedCopierRow, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { captureHistoryAcquisition } from '../../../history-acquisition'
import { XT_COPIER_PAGE_SIZE, validateXtCopierPage, xtCopierHistoryUrl } from '../copier-snapshot'
import { xtAdapter } from '../index'

const TRADER_ID = '4612442474598781734'
const PARSED_AT = new Date().toISOString()
type Dict = Record<string, unknown>

function fixture(): Dict {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'records-followers.json'), 'utf8')
  ) as Dict
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 20,
    slug: 'xt_futures',
    exchange_id: 20,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'xt',
    leaderboard_url: 'https://www.xt.com/en/copy-trading/futures',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 1_880,
    deep_profile_topn: 10,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 10,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 500,
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: { boardKey: 'futures', history_max_pages: 10 },
    ...overrides,
  }
}

function result(payload: Dict): Dict {
  return payload.result as Dict
}

function firstPage(): Dict {
  return fixture()
}

function syntheticRows(count: number, start: number): Dict[] {
  const rows = result(firstPage()).items as Dict[]
  return Array.from({ length: count }, (_, index) => {
    const template = clone(rows[index % rows.length])
    return {
      ...template,
      id: String(9_000_000 + start + index),
      pageId: start + index + 1,
      accountId: 8_000_000_000_000 + start + index,
      followerName: `XT-SNAPSHOT-${start + index}`,
    }
  })
}

function envelope(page: number, total: number, items: Dict[]): Dict {
  return {
    returnCode: 0,
    msgInfo: 'success',
    error: null,
    result: { page, ps: XT_COPIER_PAGE_SIZE, total, items },
  }
}

function session(respond: (url: string) => unknown): {
  fetchSession: FetchSession
  get: jest.Mock
} {
  const get = jest.fn(async (url: string) => ({
    status: () => 200,
    json: async () => respond(url),
  }))
  const api = { get } as Awaited<ReturnType<FetchSession['api']>>
  return {
    get,
    fetchSession: {
      sourceSlug: 'xt_futures',
      api: async () => api,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
  }
}

function verifier(src = source()) {
  const selected = xtAdapter.verifyCopierSnapshot?.(src)
  if (!selected) throw new Error('expected the reviewed XT copier verifier')
  return selected
}

async function capture(
  responses: readonly unknown[],
  src = source(),
  exchangeTraderId = TRADER_ID
) {
  let requestIndex = 0
  const { fetchSession, get } = session(() => responses[requestIndex++])
  const selected = verifier(src)
  const acquisition = await captureHistoryAcquisition({
    source: src,
    traderId: 91,
    exchangeTraderId,
    kind: 'copiers',
    cursor: null,
    attemptStartedAt: PARSED_AT,
    stream: xtAdapter.getHistory(fetchSession, src, exchangeTraderId, 'copiers', null),
    terminalVerifier: { contract: selected.contract, verify: selected.verifyTerminal },
  })
  return { acquisition, get }
}

function parseRows(
  pages: Awaited<ReturnType<typeof capture>>['acquisition']['pages'],
  src = source()
): ParsedCopierRow[] {
  return pages
    .flatMap((page) =>
      xtAdapter.parseHistory(page.payload, 'copiers', {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: PARSED_AT,
        meta: src.meta,
      })
    )
    .filter((row): row is ParsedCopierRow => row.kind === 'copiers')
}

describe('XT futures copier snapshot authority', () => {
  it('selects only the canonical XT futures USDT full-depth source', () => {
    expect(verifier()).toMatchObject({
      contract: 'arena.ingest.history-terminal-verifier.xt.copiers@1',
    })
    expect(xtAdapter.verifyCopierSnapshot?.(source({ copier_table_depth: 'top10' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ currency: 'USDC' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ adapter_slug: 'proxy' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ status: 'inactive' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ serving_mode: 'shadow' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ trader_kind_scope: 'bot' }))).toBeNull()
    expect(xtAdapter.verifyCopierSnapshot?.(source({ meta: {} }))).toBeNull()
    expect(xtAdapter.supportsSurface?.(source(), 'copiers')).toBe(true)
    expect(
      xtAdapter.verifyCopierSnapshot?.(
        source({ slug: 'xt_spot', product_type: 'spot', meta: { boardKey: 'spot' } })
      )
    ).toBeNull()
    expect(
      xtAdapter.supportsSurface?.(
        source({ slug: 'xt_spot', product_type: 'spot', meta: { boardKey: 'spot' } }),
        'copiers'
      )
    ).toBe(false)
    expect(
      xtAdapter.verifyCopierSnapshot?.(
        source({
          meta: {
            boardKey: 'futures',
            endpoints: { base: 'https://proxy.example.test/copy-trade' },
          },
        })
      )
    ).toBeNull()
  })

  it('captures exact 20+19 pages, binds canonical URLs, and returns reported_end', async () => {
    const pageOne = firstPage()
    const pageTwo = envelope(2, 39, syntheticRows(19, 20))
    const { acquisition, get } = await capture([pageOne, pageTwo])

    expect(acquisition.error).toBeNull()
    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.pages.map((page) => page.payload)).toEqual([pageOne, pageTwo])
    expect(acquisition.pages.map((page) => page.url)).toEqual([
      xtCopierHistoryUrl(TRADER_ID, 1),
      xtCopierHistoryUrl(TRADER_ID, 2),
    ])
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      xtCopierHistoryUrl(TRADER_ID, 1),
      xtCopierHistoryUrl(TRADER_ID, 2),
    ])
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 2 }],
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })

    const rows = parseRows(acquisition.pages)
    expect(rows).toHaveLength(39)
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows,
      })
    ).toEqual({ verified: true, envelopeRowCount: 39 })
  })

  it('yields and verifies the first successful empty page when total is zero', async () => {
    const empty = envelope(1, 0, [])
    const { acquisition, get } = await capture([empty])

    expect(get).toHaveBeenCalledTimes(1)
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

  it('returns reported_end when the complete terminal page has all 20 rows', async () => {
    const complete = firstPage()
    result(complete).total = 20
    const { acquisition, get } = await capture([complete])

    expect(get).toHaveBeenCalledTimes(1)
    expect(acquisition.error).toBeNull()
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'verified',
      claim_observations: [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
      scan_terminal_state: 'exhausted',
    })
    expect(
      verifier().verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: parseRows(acquisition.pages),
      })
    ).toEqual({ verified: true, envelopeRowCount: 20 })
  })

  it('encodes the trader and fixes page/size coordinates in the canonical URL', () => {
    expect(xtCopierHistoryUrl('leader /+1', 2)).toBe(
      'https://www.xt.com/fapi/user/v1/public/copy-trade/leader-follower-page' +
        '?leaderAccountId=leader%20%2F%2B1&page=2&size=20'
    )
  })

  it('retains both pages but fails closed when total drifts mid-pagination', async () => {
    const { acquisition } = await capture([firstPage(), envelope(2, 40, syntheticRows(20, 20))])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[xt] copiers changed total during pagination' })
    )
    expect(acquisition.artifact.termination).toMatchObject({
      evidence_state: 'upstream_error',
      scan_terminal_state: 'partial',
    })
  })

  it('rejects a truncated page instead of treating it as terminal', async () => {
    const truncated = firstPage()
    result(truncated).items = (result(truncated).items as Dict[]).slice(0, 19)
    const { acquisition } = await capture([truncated])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[xt] copiers returned a malformed exact page envelope' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('throws after retaining the capped prefix when the cap cannot reach total', async () => {
    const src = source({ meta: { boardKey: 'futures', history_max_pages: 1 } })
    const { acquisition, get } = await capture([firstPage()], src)

    expect(get).toHaveBeenCalledTimes(1)
    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toEqual(
      expect.objectContaining({
        message: '[xt] copiers reached page cap 1 before reported total 39',
      })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it('rejects duplicate source identities across otherwise exact pages', async () => {
    const duplicatePage = envelope(2, 39, syntheticRows(19, 20))
    const firstIdentity = ((result(firstPage()).items as Dict[])[0] as Dict).id
    ;((result(duplicatePage).items as Dict[])[0] as Dict).id = firstIdentity
    const { acquisition } = await capture([firstPage(), duplicatePage])

    expect(acquisition.pages).toHaveLength(2)
    expect(acquisition.error).toEqual(
      expect.objectContaining({ message: '[xt] copiers returned a missing or duplicate identity' })
    )
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it.each([
    [
      'top-level extra key',
      (payload: Dict) => {
        payload.success = true
      },
    ],
    [
      'result hasNext drift',
      (payload: Dict) => {
        result(payload).hasNext = false
      },
    ],
    [
      'string returnCode',
      (payload: Dict) => {
        payload.returnCode = '0'
      },
    ],
    [
      'non-null error',
      (payload: Dict) => {
        payload.error = {}
      },
    ],
    [
      'wrong result page',
      (payload: Dict) => {
        result(payload).page = 2
      },
    ],
    [
      'wrong result page size',
      (payload: Dict) => {
        result(payload).ps = 19
      },
    ],
  ] as const)('rejects exact-envelope drift: %s', async (_label, mutate) => {
    const payload = firstPage()
    mutate(payload)
    const { acquisition } = await capture([payload])

    expect(acquisition.pages).toHaveLength(1)
    expect(acquisition.error).toBeInstanceOf(Error)
    expect(acquisition.artifact.termination.evidence_state).toBe('upstream_error')
  })

  it.each([
    ['negative invested amount', 'followMarginU', '-1'],
    ['negative-zero profit', 'followProfitU', '-0'],
    ['leading-zero profit', 'followProfitU', '01.5'],
    ['exponent invested amount', 'followMarginU', '1e2'],
    ['whitespace invested amount', 'followMarginU', ' 10'],
    ['fractional duration', 'days', 1.5],
    ['negative duration', 'days', -1],
    ['negative-zero duration', 'days', -0],
  ] as const)('fails closed on a non-canonical copier field: %s', (_label, field, value) => {
    const payload = firstPage()
    const first = (result(payload).items as Dict[])[0]
    first[field] = value

    expect(validateXtCopierPage(payload, 1)).toBeNull()
  })

  it('rejects parser omission, reordering, projection/raw/hash drift and duplicates', async () => {
    const { acquisition } = await capture([firstPage(), envelope(2, 39, syntheticRows(19, 20))])
    const rows = parseRows(acquisition.pages)
    const selected = verifier()
    const verify = (candidate: readonly ParsedCopierRow[]) =>
      selected.verifyConservation({
        exchangeTraderId: TRADER_ID,
        pages: acquisition.pages,
        rows: candidate,
      })

    expect(verify(rows)).toEqual({ verified: true, envelopeRowCount: 39 })
    expect(verify(rows.slice(1))).toEqual({ verified: false })
    expect(verify([...rows].reverse())).toEqual({ verified: false })
    expect(
      verify(
        rows.map((row, index) =>
          index === 0 ? { ...row, ts: new Date(Date.parse(PARSED_AT) - 1).toISOString() } : row
        )
      )
    ).toEqual({ verified: false })
    expect(verify(rows.map((row) => ({ ...row, ts: '2026-08-04T00:00:00Z' })))).toEqual({
      verified: false,
    })
    expect(
      verify(
        rows.map((row) => ({
          ...row,
          ts: new Date(Date.parse(acquisition.pages.at(-1)!.fetchedAt) + 1).toISOString(),
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
