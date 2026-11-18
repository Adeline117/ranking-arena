/**
 * MEXC board capture against the served traders/v2 endpoint.
 *
 * Live probe 2026-11-18 (headless page, same-origin fetch; a bare curl gets
 * an Akamai 403): limit=100 page 1 reports data.total=7100; page 71 holds
 * orders 7001-7100; page 72 is an empty content array that still reports
 * total 7100; limit=500 answers {"success":false,"code":600}. The board is
 * therefore captured in reported-total mode at the 100-row upstream limit.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { mexcAdapter } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { isPartitionedNumericLeaderboardCapture } from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'

const SERVED = 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >
}

type Content = { total: number; content: Array<Record<string, unknown>> }

/** Live page 1 (10 rows) split into pages of `pageSize`, reporting `total`. */
function board(pageSize: number, total: number): (page: number) => Record<string, unknown> {
  const live = fixture('traders-v2-p1.json') as { data: Content }
  return (page) => {
    const copy = JSON.parse(JSON.stringify(live)) as { data: Content }
    copy.data.content = live.data.content.slice((page - 1) * pageSize, page * pageSize)
    copy.data.total = total
    return copy
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

async function evidence(pageSize: number, total: number) {
  const src = source(pageSize)
  const requests: ReplayRequestTemplate[] = []
  const pages = board(pageSize, total)
  const capture = await mexcAdapter.captureLeaderboard!(
    session(requests, (request) => pages(pageOf(request))),
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
    evidence: attemptBoundEvidenceForCapture({
      capture,
      source: src,
      timeframe: 7,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
    }),
  }
}

describe('mexc captureLeaderboard', () => {
  it('binds a complete single-page board in reported-total mode', async () => {
    const { requests, capture, rows, evidence: bound } = await evidence(100, 10)

    expect(requests).toHaveLength(1)
    const url = new URL(requests[0].url)
    expect(url.origin + url.pathname).toBe(SERVED)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      condition: '[]',
      limit: '100',
      orderBy: 'COMPREHENSIVE',
      page: '1',
    })
    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(capture.parsePages[0].payload).toEqual(board(100, 10)(1))
    expect(rows).toHaveLength(10)
    expect(rows[0].headlineMetricSources).toEqual({
      roi: { fieldPath: 'data.content[].roi' },
      pnl: { fieldPath: 'data.content[].pnl' },
    })
    expect(bound).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
  })

  it('pages until the reported total is reached', async () => {
    const { requests, capture, evidence: bound } = await evidence(4, 10)

    expect(requests.map(pageOf)).toEqual([1, 2, 3])
    expect(capture.sourcePages.map((page) => page.sourceRowCount)).toEqual([4, 4, 2])
    expect(capture.terminationReason).toBe('reported_population_reached')
    expect(bound).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
  })

  it('a board ending short of its reported total is never trust-bound', async () => {
    const { capture, evidence: bound } = await evidence(100, 11)

    expect(capture.terminationReason).not.toBe('reported_population_reached')
    expect(bound.trustBound).toBe(false)
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
    const { capture } = await evidence(100, 10)
    expect(JSON.stringify(capture.sourcePages[0].rawPage)).not.toMatch(
      /accept|user-agent|referer|cookie|authorization/i
    )
  })
})
