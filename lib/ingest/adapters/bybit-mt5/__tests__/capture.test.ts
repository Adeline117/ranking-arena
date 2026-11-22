import { readFileSync } from 'fs'
import { join } from 'path'
import type { SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'
import { BYBIT_MT5_LEADERBOARD_EXHAUSTION, bybitMt5Adapter } from '../index'

type Row = Record<string, unknown>
type Board = { retCode: number; result: { providerDetailsList: Row[]; totalCount: string } }

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'leaderboard-p1.json'), 'utf8')
) as Board
const template = fixture.result.providerDetailsList[0]
const PAGE_SIZE = 16

const source = {
  id: 3,
  slug: 'bybit_mt5',
  adapter_slug: 'bybit_mt5',
  currency: 'USDx',
  page_size: PAGE_SIZE,
  pagination_kind: 'numeric',
  leaderboard_url: 'https://www.bybit.com/copyMt5/',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  meta: {},
} as unknown as SourceRow

const trader = (n: number): Row => ({ ...template, providerMark: `mark-${n}` })
const board = (count: number) => Array.from({ length: count }, (_, index) => trader(index + 1))

/** Serve `ranking(pageNo)` (the board as it is when that page is read), one page at a time. */
async function capture(ranking: (pageNo: number) => Row[], meta: Record<string, unknown> = {}) {
  const page = { goto: async () => undefined, waitForLoadState: async () => undefined }
  const session = {
    sourceSlug: 'bybit_mt5',
    page: async () => page,
    pageFetch: async (request: ReplayRequestTemplate) => {
      const pageNo = Number(new URL(request.url).searchParams.get('pageNo'))
      const rows = ranking(pageNo)
      const json: Board = {
        ...fixture,
        result: {
          providerDetailsList: rows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE),
          totalCount: String(rows.length),
        },
      }
      return { status: 200, json }
    },
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  const src = { ...source, meta }
  const result = await bybitMt5Adapter.captureLeaderboard!(session, src, 30)
  const parsed = result.parsePages.flatMap(
    (parsePage) =>
      bybitMt5Adapter.parseLeaderboard(parsePage.payload, {
        sourceSlug: src.slug,
        currency: src.currency,
        tfLabelMap: src.tf_label_map,
        scrapedAt: '2026-11-20T12:00:00.000Z',
        meta: src.meta,
      }).rows
  )
  const validated = validateLeaderboardRows(parsed)
  return {
    result,
    bound: attemptBoundEvidenceForCapture({
      capture: result,
      source: src,
      timeframe: 30,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
      registeredExhaustion: BYBIT_MT5_LEADERBOARD_EXHAUSTION,
    }),
  }
}

describe('Bybit MT5 live board completeness', () => {
  it('declares 0.1% of the board, never more than 100 rows', () => {
    expect(BYBIT_MT5_LEADERBOARD_EXHAUSTION).toEqual({
      completeness_mode: 'exhausted',
      list_path: ['result', 'providerDetailsList'],
      row_key_path: ['providerMark'],
      end_signal: { kind: 'short_page' },
      board_version: {
        kind: 'reported_total_drift',
        path: ['result', 'totalCount'],
        max_drift_bps: 10,
      },
      max_duplicate_rows: 100,
    })
  })

  it('binds a board read to its short final page, reading the string total', async () => {
    const rows = board(1010)
    const { result, bound } = await capture(() => rows)
    expect(result.terminationReason).toBe('short_page')
    expect(result.sourcePages).toHaveLength(64)
    expect(result.sourcePages[0].sourceReports.population).toEqual({ state: 'not_reported' })
    expect(result.completeness?.board_version).toEqual({
      kind: 'reported_total_drift',
      reported_totals: { min: 1010, max: 1010, last: 1010 },
    })
    expect(bound).toMatchObject({ completenessMode: 'exhausted', trustBound: true })
  })

  it('binds when one trader joins the board while it is paged', async () => {
    const before = board(1010)
    // A newcomer takes rank 1 after page 1 is read: everyone moves down one
    // rank, so the last trader of page 1 is read again on page 2.
    const after = [trader(9999), ...before]
    const { result, bound } = await capture((pageNo) => (pageNo === 1 ? before : after))
    expect(result.completeness?.row_keys).toEqual({ observed: 1011, distinct: 1010, duplicate: 1 })
    expect(result.completeness?.board_version).toEqual({
      kind: 'reported_total_drift',
      reported_totals: { min: 1010, max: 1011, last: 1011 },
    })
    expect(bound.trustBound).toBe(true)
  })

  it('refuses a board that moved by more than 0.1%', async () => {
    const before = board(1010)
    const after = [trader(9998), trader(9999), ...before]
    const { result, bound } = await capture((pageNo) => (pageNo === 1 ? before : after))
    expect(result.completeness?.row_keys.duplicate).toBe(2)
    expect(bound.trustBound).toBe(false)
  })

  it('refuses a board cut off by the caller page cap', async () => {
    const rows = board(1010)
    const { result, bound } = await capture(() => rows, { max_pages: 2 })
    expect(result.terminationReason).toBe('caller_limit')
    expect(bound.trustBound).toBe(false)
  })
})
