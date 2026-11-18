/**
 * MEXC board capture against the served traders/v2 endpoint.
 *
 * Live probe 2026-11-18 (headless page, same-origin fetch; a bare curl gets
 * an Akamai 403): limit=100 page 1 reports data.total=7100; page 71 holds
 * orders 7001-7100; page 72 is an empty content array that still reports
 * total 7100; limit=500 answers {"success":false,"code":600}.
 *
 * The board re-sorts live: four sequential full crawls (16 s to 3 min, sorted
 * COMPREHENSIVE and FOLLOWERS) each served 1-6 traders on two pages, so as
 * many others were never served (the 16 s crawl: 7100 rows, 7098 distinct,
 * 2 duplicates); parallel page requests answer code 510 ("Request frequently
 * too fast!"). The capture is therefore exhausted to the empty page and
 * bound by reported-total drift (MEXC_FUTURES_LEADERBOARD_EXHAUSTION):
 * allowance = min(⌊last × 50 / 10000⌋, 40), i.e. 35 rows at 7,100.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { MEXC_FUTURES_LEADERBOARD_EXHAUSTION, mexcAdapter } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import {
  LeaderboardCaptureUpstreamError,
  isPartitionedNumericLeaderboardCapture,
} from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'

const SERVED = 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2'

type Row = Record<string, unknown>
type Content = { total: number; content: Row[] }

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >
}

const LIVE = fixture('traders-v2-p1.json') as { data: Content }
const TEMPLATE = LIVE.data.content[0]

/** A board of `count` distinct traders built from the live row shape. */
function traders(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    ...TEMPLATE,
    uid: String(10_000_000 + index),
    order: index + 1,
  }))
}

/** One page of `ranking` (the board as it is when that page is read). */
function servedPage(ranking: Row[], page: number, pageSize: number, total: number): Row {
  return {
    ...LIVE,
    data: { total, content: ranking.slice((page - 1) * pageSize, page * pageSize) },
  }
}

function session(
  requests: ReplayRequestTemplate[],
  answer: (request: ReplayRequestTemplate) => unknown
): FetchSession {
  return {
    sourceSlug: 'mexc_futures',
    page: async () => ({
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
    }),
    pageFetch: async (request: ReplayRequestTemplate) => {
      requests.push(request)
      return { status: 200, json: answer(request) }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

function pageOf(request: ReplayRequestTemplate): number {
  return Number(new URL(request.url).searchParams.get('page'))
}

function source(pageSize: number, meta: Record<string, unknown> = {}): SourceRow {
  return {
    id: 10,
    slug: 'mexc_futures',
    adapter_slug: 'mexc',
    leaderboard_url: 'https://www.mexc.com/zh-CN/futures/copyTrade/home',
    currency: 'USDT',
    tf_label_map: {},
    timeframes_native: [7],
    page_size: pageSize,
    pagination_kind: 'numeric',
    meta,
  } as unknown as SourceRow
}

/** Capture with `answer(page)` per request; parse, validate and bind as Tier-A does. */
async function evidence(pageSize: number, answer: (page: number) => unknown) {
  const src = source(pageSize)
  const requests: ReplayRequestTemplate[] = []
  const capture = await mexcAdapter.captureLeaderboard!(
    session(requests, (request) => answer(pageOf(request))),
    src,
    7
  )
  if (isPartitionedNumericLeaderboardCapture(capture)) throw new Error('identity capture')
  const rows = capture.parsePages.flatMap(
    (page) =>
      mexcAdapter.parseLeaderboard(page.payload, {
        sourceSlug: src.slug,
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: '2026-11-18T00:00:00.000Z',
        meta: {},
      }).rows
  )
  const validated = validateLeaderboardRows(rows)
  return {
    requests,
    capture,
    rows,
    validated,
    bound: attemptBoundEvidenceForCapture({
      capture,
      source: src,
      timeframe: 7,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion: MEXC_FUTURES_LEADERBOARD_EXHAUSTION,
    }),
  }
}

/** The live 7100-row board: 71 full pages, then the empty page 72. */
const LIVE_TOTAL = 7100
const LIVE_PAGE = 100

/** Serve a board in which each listed trader is seen again at the top of the next page. */
function boardWithRepeats(repeatAfterPages: readonly number[], total = LIVE_TOTAL) {
  const board = traders(total)
  const pages: Row[][] = []
  let cursor = 0
  for (let page = 1; page <= total / LIVE_PAGE; page += 1) {
    const repeat = repeatAfterPages.includes(page - 1) ? [pages[page - 2].at(-1)!] : []
    const fresh = board.slice(cursor, cursor + LIVE_PAGE - repeat.length)
    cursor += fresh.length
    pages.push([...repeat, ...fresh])
  }
  return (page: number) => ({
    ...LIVE,
    data: { total, content: pages[page - 1] ?? [] },
  })
}

/** Repeat one trader on each of the first `count` page boundaries. */
const repeatsOn = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

describe('mexc captureLeaderboard', () => {
  it('declares a live board: short_page end, 0.5% total drift, at most 40 rows', () => {
    expect(MEXC_FUTURES_LEADERBOARD_EXHAUSTION).toEqual({
      completeness_mode: 'exhausted',
      list_path: ['data', 'content'],
      row_key_path: ['uid'],
      end_signal: { kind: 'short_page' },
      board_version: { kind: 'reported_total_drift', path: ['data', 'total'], max_drift_bps: 50 },
      max_duplicate_rows: 40,
    })
  })

  it('binds a single short page; total is drift evidence, not a population', async () => {
    const board = traders(10)
    const { requests, capture, rows, bound } = await evidence(100, (page) =>
      servedPage(board, page, 100, 10)
    )

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0].url)
    expect(url.origin + url.pathname).toBe(SERVED)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      condition: '[]',
      limit: '100',
      orderBy: 'COMPREHENSIVE',
      page: '1',
    })
    expect(capture.terminationReason).toBe('short_page')
    expect(capture.sourcePages[0].sourceReports.population).toEqual({ state: 'not_reported' })
    expect(rows).toHaveLength(10)
    expect(rows[0].headlineMetricSources).toEqual({
      roi: { fieldPath: 'data.content[].roi' },
      pnl: { fieldPath: 'data.content[].pnl' },
    })
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
    expect(bound.projection).toMatchObject({ populationState: 'unknown', exhaustionVerified: true })
  })

  it('reads a board ending on a full page through to the empty page', async () => {
    const board = traders(8)
    const { requests, capture, bound } = await evidence(4, (page) => servedPage(board, page, 4, 8))

    expect(requests.map(pageOf)).toEqual([1, 2, 3])
    expect(capture.terminationReason).toBe('empty_page')
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
  })

  it('binds the live shape: 7100 rows served, 7098 distinct, 2 repeated', async () => {
    // Live 2026-11-18 (16 s crawl): traders at orders 3000 and 5400 were served
    // again at the top of pages 31 and 55.
    const { requests, capture, validated, bound } = await evidence(
      LIVE_PAGE,
      boardWithRepeats([30, 54])
    )

    expect(requests).toHaveLength(72)
    expect(capture.terminationReason).toBe('empty_page')
    expect(capture.completeness?.row_keys).toEqual({ observed: 7100, distinct: 7098, duplicate: 2 })
    expect(capture.completeness?.board_version).toEqual({
      kind: 'reported_total_drift',
      reported_totals: { min: 7100, max: 7100, last: 7100 },
    })
    expect(validated.valid).toHaveLength(7098)
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
  })

  it('at 7,100 rows the allowance is 35: 35 repeats bind, 36 do not', async () => {
    const within = await evidence(LIVE_PAGE, boardWithRepeats(repeatsOn(35)))
    expect(within.capture.completeness?.row_keys).toEqual({
      observed: 7100,
      distinct: 7065,
      duplicate: 35,
    })
    expect(within.bound.trustBound).toBe(true)

    const beyond = await evidence(LIVE_PAGE, boardWithRepeats(repeatsOn(36)))
    expect(beyond.capture.completeness?.row_keys.duplicate).toBe(36)
    expect(beyond.bound.trustBound).toBe(false)
  })

  it('the absolute cap is 40 rows: on an 8,200-row board 40 repeats bind, 41 do not', async () => {
    // 0.5% of 8,200 is 41, so the 40-row cap is what binds here.
    const within = await evidence(LIVE_PAGE, boardWithRepeats(repeatsOn(40), 8200))
    expect(within.capture.completeness?.row_keys).toEqual({
      observed: 8200,
      distinct: 8160,
      duplicate: 40,
    })
    expect(within.bound.trustBound).toBe(true)

    const beyond = await evidence(LIVE_PAGE, boardWithRepeats(repeatsOn(41), 8200))
    expect(beyond.capture.completeness?.row_keys.duplicate).toBe(41)
    expect(beyond.bound.trustBound).toBe(false)
  })

  it('distinct rows may miss the last total by 35 rows at 7,100, not 36', async () => {
    // A short final page while every page reports 7100.
    const missing = async (served: number) => {
      const board = traders(served)
      return evidence(LIVE_PAGE, (page) => servedPage(board, page, LIVE_PAGE, LIVE_TOTAL))
    }
    const within = await missing(7065)
    expect(within.capture.terminationReason).toBe('short_page')
    expect(within.capture.completeness?.row_keys.distinct).toBe(7065)
    expect(within.bound.trustBound).toBe(true)

    const beyond = await missing(7064)
    expect(beyond.capture.completeness?.row_keys.distinct).toBe(7064)
    expect(beyond.bound.trustBound).toBe(false)
  })

  it('a rate-limited page fails the capture as an upstream error', async () => {
    const board = traders(10)
    const requests: ReplayRequestTemplate[] = []
    const failure = mexcAdapter.captureLeaderboard!(
      session(requests, (request) =>
        pageOf(request) === 1
          ? servedPage(board, 1, 5, 10)
          : fixture('traders-v2-rate-limited.json')
      ),
      source(5),
      7
    )
    await expect(failure).rejects.toBeInstanceOf(LeaderboardCaptureUpstreamError)
    await expect(failure).rejects.toThrow(/code=510/)
    expect(requests.map(pageOf)).toEqual([1, 2])
  })

  it('treats the upstream limit rejection as an upstream error, never an empty board', async () => {
    const requests: ReplayRequestTemplate[] = []
    await expect(
      mexcAdapter.captureLeaderboard!(
        session(requests, () => fixture('traders-v2-invalid-limit.json')),
        source(100),
        7
      )
    ).rejects.toThrow(/not a success answer/)
  })

  it('refuses derived windows and page sizes the upstream rejects', async () => {
    const requests: ReplayRequestTemplate[] = []
    const fake = session(requests, () => fixture('traders-v2-past-end.json'))
    await expect(mexcAdapter.captureLeaderboard!(fake, source(100), 30)).rejects.toThrow(
      /derived, not natively listed/
    )
    await expect(mexcAdapter.captureLeaderboard!(fake, source(500), 7)).rejects.toThrow(
      /page_size must be 1\.\.100/
    )
    expect(requests).toHaveLength(0)
  })

  it('persists no request headers in the RAW request evidence', async () => {
    const board = traders(10)
    const { capture } = await evidence(100, (page) => servedPage(board, page, 100, 10))
    expect(JSON.stringify(capture.sourcePages[0].rawPage)).not.toMatch(
      /accept|user-agent|referer|cookie|authorization/i
    )
  })
})
