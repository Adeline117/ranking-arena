/**
 * Bitget UTA board capture → attempt-bound publication evidence.
 *
 * Shapes come from a read-only public probe (2026-11-15) of all three UTA
 * boards; the sanitized fixtures keep the real envelope (string code "200",
 * data.rows, page-local data.totals, board population data.maxShowSizes).
 * Spot/CFD boards page out to exactly maxShowSizes distinct traders. The
 * futures board's flagged tail ends short of its reported population, which
 * must never bind.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { RankingTimeframe, SourceRow } from '../../../core/types'
import {
  LeaderboardCaptureUpstreamError,
  isPartitionedNumericLeaderboardCapture,
  type LeaderboardCapture,
} from '../../../fetch/capture'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'
import { bitgetAdapter } from '../index'

type Payload = Record<string, unknown>
type Row = Record<string, unknown>

const PAGE_SIZE = 3

function fixture(name: string): Payload {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Payload
}

const FUTURES = fixture('uta-board-futures-7d-p1.json')
const CFD_TAIL = fixture('uta-board-cfd-30d-tail.json')

function templateRow(payload: Payload): Row {
  return ((payload.data as Payload).rows as Row[])[0]
}

/** Board row n (1-based) with a distinct traderUid, from the real row shape. */
function boardRow(payload: Payload, n: number): Row {
  return {
    ...templateRow(payload),
    traderUid: `b0${n.toString(16).padStart(18, '0')}`,
    portfolioId: String(1_400_000_000_000_000_000n + BigInt(n)),
  }
}

function page(base: Payload, rows: Row[], nextFlag: boolean, maxShowSizes: number): Payload {
  const copy = JSON.parse(JSON.stringify(base)) as Payload
  const data = copy.data as Payload
  data.rows = rows
  data.totals = rows.length
  data.nextFlag = nextFlag
  data.maxShowSizes = maxShowSizes
  return copy
}

/** Board of `ids` (row numbers) split into PAGE_SIZE pages; `population` = maxShowSizes. */
function board(base: Payload, ids: number[], population: number): Payload[] {
  const pages: Payload[] = []
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const slice = ids.slice(i, i + PAGE_SIZE).map((n) => boardRow(base, n))
    pages.push(page(base, slice, i + PAGE_SIZE < ids.length, population))
  }
  return pages
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

function sourceRow(slug: string, boardKey: string): SourceRow {
  return {
    id: 41,
    slug,
    exchange_id: 41,
    product_type: boardKey,
    trader_kind_scope: 'human',
    adapter_slug: 'bitget',
    leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/futures',
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: null,
    deep_profile_topn: 0,
    positions_topn: 0,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'none',
    currency: 'USDT',
    page_size: PAGE_SIZE,
    pagination_kind: 'numeric',
    cadence_tier_a: '4 hours',
    cadence_tier_b: '12 hours',
    cadence_tier_d: '1 hour',
    fetch_region: 'local',
    rate_budget_ms: 0,
    phase: 0,
    serving_mode: 'serving',
    status: 'active',
    meta: { boardKey },
  } as SourceRow
}

/** Fake in-page fetch session answering page N with pages[N-1] (past the end: empty). */
function fakeSession(
  slug: string,
  pages: Payload[],
  emptyAfter: Payload
): { session: FetchSession; requests: ReplayRequestTemplate[] } {
  const requests: ReplayRequestTemplate[] = []
  const pageHandle = { goto: async () => undefined, waitForLoadState: async () => undefined }
  const session = {
    sourceSlug: slug,
    page: async () => pageHandle,
    pageFetch: async (request: ReplayRequestTemplate) => {
      requests.push(request)
      const pageNo = (request.body as { pageNo: number }).pageNo
      return { status: 200, json: pages[pageNo - 1] ?? emptyAfter }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  return { session, requests }
}

async function capture(
  slug: string,
  boardKey: string,
  pages: Payload[],
  timeframe: RankingTimeframe = 30
) {
  const src = sourceRow(slug, boardKey)
  const empty = page(pages[0], [], false, 0)
  const { session, requests } = fakeSession(slug, pages, empty)
  const result = await bitgetAdapter.captureLeaderboard!(session, src, timeframe)
  if (isPartitionedNumericLeaderboardCapture(result)) throw new Error('expected identity capture')
  return { src, capture: result as LeaderboardCapture, requests }
}

function evidence(src: SourceRow, captured: LeaderboardCapture, timeframe: RankingTimeframe = 30) {
  const ctx = {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
  const parsed = captured.parsePages.flatMap(
    (rawPage) => bitgetAdapter.parseLeaderboard(rawPage.payload, ctx).rows
  )
  const validated = validateLeaderboardRows(parsed)
  return attemptBoundEvidenceForCapture({
    capture: captured,
    source: src,
    timeframe,
    acceptedPopulation: validated.valid.length,
    rejectedRowCount: validated.rejects.length,
  })
}

describe('Bitget UTA leaderboard capture evidence', () => {
  it.each([
    ['bitget_cfd', 'cfd'],
    ['bitget_spot', 'spot'],
    ['bitget_futures', 'futures'],
  ])('%s binds a board that pages out to its reported population', async (slug, boardKey) => {
    const {
      src,
      capture: captured,
      requests,
    } = await capture(slug, boardKey, board(CFD_TAIL, range(1, 8), 8))
    expect(captured.terminationReason).toBe('reported_population_reached')
    // The capture stops at the reported population; no past-the-end page.
    expect(requests.map((request) => (request.body as { pageNo: number }).pageNo)).toEqual([
      1, 2, 3,
    ])
    expect(evidence(src, captured)).toMatchObject({
      completenessMode: 'reported_total',
      trustBound: true,
    })
  })

  it('requests the window and page it binds, and persists no request headers', async () => {
    const { capture: captured, requests } = await capture(
      'bitget_cfd',
      'cfd',
      board(CFD_TAIL, range(1, 4), 4),
      7
    )
    expect(requests.map((request) => request.body)).toEqual([
      expect.objectContaining({ pageNo: 1, pageSize: PAGE_SIZE, dataCycle: 7 }),
      expect.objectContaining({ pageNo: 2, pageSize: PAGE_SIZE, dataCycle: 7 }),
    ])
    expect(captured.sourcePages.map((sourcePage) => sourcePage.paginationPosition)).toEqual([
      { kind: 'page_index', request_page_index: 1 },
      { kind: 'page_index', request_page_index: 2 },
    ])
    expect(JSON.stringify(captured.sourcePages.map((p) => p.rawPage))).not.toMatch(
      /terminaltype|website|user-agent|referer|cookie|authorization/i
    )
  })

  it('never binds the futures tail that ends short of its reported population', async () => {
    // Probe: futures reports maxShowSizes 9473 on every window while the
    // flagged tail ends with a short page well below it.
    const { src, capture: captured } = await capture(
      'bitget_futures',
      'futures',
      board(FUTURES, range(1, 7), 9)
    )
    expect(captured.terminationReason).toBe('short_page')
    expect(evidence(src, captured).trustBound).toBe(false)
  })

  it('never binds a board that moved while paging (a duplicated trader)', async () => {
    const pages = board(CFD_TAIL, [1, 2, 3, 3, 4, 5, 6, 7], 8)
    const { src, capture: captured } = await capture('bitget_cfd', 'cfd', pages)
    expect(evidence(src, captured).trustBound).toBe(false)
  })

  it('never binds a silently emptied page before the reported population', async () => {
    const pages = board(CFD_TAIL, range(1, 8), 8)
    pages[1] = page(CFD_TAIL, [], true, 8)
    const { src, capture: captured } = await capture('bitget_cfd', 'cfd', pages)
    expect(captured.terminationReason).toBe('empty_page')
    expect(evidence(src, captured).trustBound).toBe(false)
  })

  it('never binds when pages disagree on the reported population', async () => {
    const pages = board(CFD_TAIL, range(1, 8), 8)
    ;(pages[1].data as Payload).maxShowSizes = 9
    const { src, capture: captured } = await capture('bitget_cfd', 'cfd', pages)
    expect(evidence(src, captured).trustBound).toBe(false)
  })

  it('records a non-success envelope as an upstream error, never an empty board', async () => {
    const failed = { code: '00005', msg: 'request failed', data: null }
    const src = sourceRow('bitget_cfd', 'cfd')
    const { session } = fakeSession('bitget_cfd', [failed], failed)
    await expect(bitgetAdapter.captureLeaderboard!(session, src, 30)).rejects.toBeInstanceOf(
      LeaderboardCaptureUpstreamError
    )
  })
})
