/**
 * Bitget UTA board capture → attempt-bound publication evidence.
 *
 * Shapes come from a read-only public probe (2026-11-15) of all three UTA
 * boards; the sanitized fixtures keep the real envelope (string code "200",
 * data.rows, page-local data.totals, board population data.maxShowSizes).
 * The CFD board pages out to exactly maxShowSizes distinct traders. The
 * futures board's flagged tail ends short of its reported population, which
 * must never bind. The spot board (~5,400 traders, 181 pages) moves while it
 * is paged, so it is read to its short final page and proven complete by
 * bounded drift (BITGET_SPOT_LEADERBOARD_EXHAUSTION).
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
import { BITGET_SPOT_LEADERBOARD_EXHAUSTION, bitgetAdapter } from '../index'

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

/**
 * bitget_spot as a live board, at its real size: pages of 30, and the board
 * as it is when each page is read (`ranking(pageNo)`), with its reported total.
 */
const SPOT_PAGE_SIZE = 30
const SPOT_ROWS = Array.from({ length: 5_500 }, (_, index) => boardRow(CFD_TAIL, index + 1))
const spotBoard = (count: number): Row[] => SPOT_ROWS.slice(0, count)

/**
 * A trader not yet read climbs above the cursor after page `afterPage`: every
 * trader between moves down one rank, so the last trader already read is read
 * again and the climber is never read. The board total does not change.
 */
function climbs(initial: Row[], afterPages: number[]): (pageNo: number) => Row[] {
  const states: Row[][] = [initial]
  for (const _ of afterPages) {
    const previous = states[states.length - 1]
    states.push([previous[previous.length - 1], ...previous.slice(0, -1)])
  }
  return (pageNo) => states[afterPages.filter((afterPage) => pageNo > afterPage).length]
}

async function captureSpot(
  ranking: (pageNo: number) => Row[],
  options: {
    reportedTotal?: (pageNo: number, rows: Row[]) => number
    emptiedPage?: number
    slug?: string
    boardKey?: string
    registered?: typeof BITGET_SPOT_LEADERBOARD_EXHAUSTION | null
  } = {}
) {
  const slug = options.slug ?? 'bitget_spot'
  const src = { ...sourceRow(slug, options.boardKey ?? 'spot'), page_size: SPOT_PAGE_SIZE }
  const pageHandle = { goto: async () => undefined, waitForLoadState: async () => undefined }
  const session = {
    sourceSlug: slug,
    page: async () => pageHandle,
    pageFetch: async (request: ReplayRequestTemplate) => {
      const pageNo = (request.body as { pageNo: number }).pageNo
      const rows = ranking(pageNo)
      const slice =
        pageNo === options.emptiedPage
          ? []
          : rows.slice((pageNo - 1) * SPOT_PAGE_SIZE, pageNo * SPOT_PAGE_SIZE)
      const total = options.reportedTotal?.(pageNo, rows) ?? rows.length
      return { status: 200, json: page(CFD_TAIL, slice, slice.length === SPOT_PAGE_SIZE, total) }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  const result = await bitgetAdapter.captureLeaderboard!(session, src, 30)
  if (isPartitionedNumericLeaderboardCapture(result)) throw new Error('expected identity capture')
  const captured = result as LeaderboardCapture
  const ctx = {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: '2026-11-24T12:00:00.000Z',
    meta: src.meta,
  }
  const validated = validateLeaderboardRows(
    captured.parsePages.flatMap(
      (rawPage) => bitgetAdapter.parseLeaderboard(rawPage.payload, ctx).rows
    )
  )
  return {
    captured,
    bound: attemptBoundEvidenceForCapture({
      capture: captured,
      source: src,
      timeframe: 30,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion:
        options.registered === undefined ? BITGET_SPOT_LEADERBOARD_EXHAUSTION : options.registered,
    }),
  }
}

describe('Bitget spot live board completeness', () => {
  it('declares 0.35% of the board, never more than 20 rows', () => {
    expect(BITGET_SPOT_LEADERBOARD_EXHAUSTION).toEqual({
      completeness_mode: 'exhausted',
      list_path: ['data', 'rows'],
      row_key_path: ['traderUid'],
      end_signal: { kind: 'short_page' },
      board_version: {
        kind: 'reported_total_drift',
        path: ['data', 'maxShowSizes'],
        max_drift_bps: 35,
      },
      max_duplicate_rows: 20,
    })
  })

  it('binds a quiet board read to its short final page; the total is drift evidence', async () => {
    const rows = spotBoard(5_414)
    const { captured, bound } = await captureSpot(() => rows)
    expect(captured.terminationReason).toBe('short_page')
    expect(captured.sourcePages).toHaveLength(181)
    expect(captured.sourcePages[0].sourceReports.population).toEqual({ state: 'not_reported' })
    expect(captured.completeness?.row_keys).toEqual({
      observed: 5_414,
      distinct: 5_414,
      duplicate: 0,
    })
    expect(captured.completeness?.board_version).toEqual({
      kind: 'reported_total_drift',
      reported_totals: { min: 5_414, max: 5_414, last: 5_414 },
    })
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
  })

  it('binds the measured shape: 5,414 rows read, 5,410 distinct, 4 duplicates', async () => {
    const { captured, bound } = await captureSpot(climbs(spotBoard(5_414), [20, 61, 97, 150]))
    expect(captured.terminationReason).toBe('short_page')
    expect(captured.completeness?.row_keys).toEqual({
      observed: 5_414,
      distinct: 5_410,
      duplicate: 4,
    })
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
  })

  it('binds a board whose total is a page multiple and ends on an empty page', async () => {
    const rows = spotBoard(5_400)
    const { captured, bound } = await captureSpot(() => rows)
    expect(captured.terminationReason).toBe('empty_page')
    expect(captured.sourcePages).toHaveLength(181)
    expect(bound.trustBound).toBe(true)
  })

  it('binds 18 duplicates (0.35% of 5,414) and refuses 19', async () => {
    const afterPages = Array.from({ length: 19 }, (_, index) => 10 + index * 9)
    const atAllowance = await captureSpot(climbs(spotBoard(5_414), afterPages.slice(0, 18)))
    expect(atAllowance.captured.completeness?.row_keys.duplicate).toBe(18)
    expect(atAllowance.bound.trustBound).toBe(true)

    const above = await captureSpot(climbs(spotBoard(5_414), afterPages))
    expect(above.captured.completeness?.row_keys).toEqual({
      observed: 5_414,
      distinct: 5_395,
      duplicate: 19,
    })
    expect(above.bound).toMatchObject({ completenessMode: 'exhausted', trustBound: false })
  })

  it('refuses a board that ends more than the allowance short of its reported total', async () => {
    // No duplicate at all: the board simply stops before its total. 18 rows
    // short of 5,432 is within 0.35%; 20 rows short of 5,434 (allowance 19) is not.
    const rows = spotBoard(5_414)
    const within = await captureSpot(() => rows, { reportedTotal: () => 5_432 })
    expect(within.bound.trustBound).toBe(true)
    const short = await captureSpot(() => rows, { reportedTotal: () => 5_434 })
    expect(short.captured.completeness?.row_keys.duplicate).toBe(0)
    expect(short.bound.trustBound).toBe(false)
  })

  it('refuses a reported total that moved by more than the allowance', async () => {
    const rows = spotBoard(5_414)
    const { bound } = await captureSpot(() => rows, {
      reportedTotal: (pageNo) => (pageNo <= 90 ? 5_395 : 5_414),
    })
    expect(bound.trustBound).toBe(false)
  })

  it('refuses a silently emptied page before the end of the board', async () => {
    const rows = spotBoard(5_414)
    const { captured, bound } = await captureSpot(() => rows, { emptiedPage: 90 })
    expect(captured.terminationReason).toBe('empty_page')
    expect(bound.trustBound).toBe(false)
  })

  it('refuses the capture when the source has no registered contract', async () => {
    const rows = spotBoard(5_414)
    const { bound } = await captureSpot(() => rows, { registered: null })
    expect(bound.trustBound).toBe(false)
  })

  it('leaves bitget_cfd in the total mode: one duplicate still refuses it', async () => {
    const quiet = await captureSpot(() => spotBoard(208), {
      slug: 'bitget_cfd',
      boardKey: 'cfd',
      registered: null,
    })
    expect(quiet.captured.terminationReason).toBe('reported_population_reached')
    expect(quiet.captured.completeness ?? null).toBeNull()
    expect(quiet.captured.sourcePages[0].sourceReports.population).toEqual({
      state: 'reported',
      value: 208,
    })
    expect(quiet.bound).toMatchObject({ completenessMode: 'reported_total', trustBound: true })

    const moved = await captureSpot(climbs(spotBoard(208), [3]), {
      slug: 'bitget_cfd',
      boardKey: 'cfd',
      registered: BITGET_SPOT_LEADERBOARD_EXHAUSTION,
    })
    expect(moved.captured.completeness ?? null).toBeNull()
    expect(moved.bound.trustBound).toBe(false)
  })
})
