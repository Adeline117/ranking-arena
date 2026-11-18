/**
 * Phemex board capture (manifest v3, reported-total mode).
 *
 * The board API answers from this host only with a page-warmed browser
 * session (CloudFront 403 to bare requests, 2026-11-18), so no fresh live
 * probe was possible: the fixture is recommend-p1.json, the live 2026-06-11
 * response ({ code: 0, data: { total: 229, rows } }, trimmed to 3 rows). The
 * pages below re-serve its rows with data.total set to the rows served, so
 * the reported total binds exactly as it would on the full board.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { PHEMEX_PAGE_SIZE_CAP, phemexAdapter } from '..'
import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { LeaderboardCaptureUpstreamError, type LeaderboardCapture } from '../../../fetch/capture'
import { validateLeaderboardRows } from '../../../staging/validate'
import { attemptBoundEvidenceForCapture } from '../../../testing/attempt-bound-evidence'
import { hasRegisteredLeaderboardMetricTrust } from '../../../serving/metric-trust-publish'

type Json = Record<string, unknown>
const LIST = 'https://api10.phemex.com/phemex-lb/public/data/v3/user/recommend'

function recommend(): Json & { data: { total: number; rows: Json[] } } {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'recommend-p1.json'), 'utf8'))
}

/** Board of `total` rows (unique userIds) cut into pages of `pageSize`. */
function boardPages(total: number, pageSize: number): Json[] {
  const template = recommend().data.rows
  const rows = Array.from({ length: total }, (_, index) => ({
    ...template[index % template.length],
    userId: 1_000_000 + index,
  }))
  const pages: Json[] = []
  for (let start = 0; start < total; start += pageSize) {
    pages.push({ code: 0, msg: 'OK', data: { total, rows: rows.slice(start, start + pageSize) } })
  }
  return pages
}

function session(pages: Json[], requests: URL[]): FetchSession {
  const answer = (url: string) => {
    const parsed = new URL(url)
    requests.push(parsed)
    const page = pages[Number(parsed.searchParams.get('pageNum')) - 1]
    return { status: () => 200, json: async () => page ?? { code: 0, data: { rows: [] } } }
  }
  return {
    sourceSlug: 'phemex_futures',
    page: async () => ({ goto: async () => undefined }),
    api: async () => ({ get: async (url: string) => answer(url) }),
    capture: async () => ({
      first: async () => ({ template: { url: '', method: 'GET', headers: { bid: 'device' } } }),
      dispose: () => undefined,
    }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

const src = {
  id: 30,
  slug: 'phemex_futures',
  adapter_slug: 'phemex',
  leaderboard_url: 'https://phemex.com/copy-trading/list?t=r',
  currency: 'USDT',
  tf_label_map: {},
  timeframes_native: [30, 90],
  page_size: PHEMEX_PAGE_SIZE_CAP,
  pagination_kind: 'numeric',
  meta: {},
} as unknown as SourceRow

async function capture(pages: Json[], timeframe: 30 | 90 = 30, source: SourceRow = src) {
  const requests: URL[] = []
  const result = (await phemexAdapter.captureLeaderboard!(
    session(pages, requests),
    source,
    timeframe
  )) as LeaderboardCapture
  return { result, requests }
}

function evidence(result: LeaderboardCapture, timeframe: 30 | 90) {
  const rows = result.parsePages.flatMap(
    (page) =>
      phemexAdapter.parseLeaderboard(page.payload, {
        sourceSlug: src.slug,
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: '2026-11-18T00:00:00.000Z',
        meta: {},
        timeframe,
      }).rows
  )
  const validated = validateLeaderboardRows(rows)
  return {
    validated,
    bound: attemptBoundEvidenceForCapture({
      capture: result,
      source: src,
      timeframe,
      acceptedPopulation: validated.valid.length,
      rejectedRowCount: validated.rejects.length,
    }),
  }
}

describe('phemex captureLeaderboard', () => {
  it.each([30, 90] as const)('binds a complete %dd board by its reported total', async (tf) => {
    const pages = boardPages(120, PHEMEX_PAGE_SIZE_CAP)
    const { result, requests } = await capture(pages, tf)

    expect(requests.map((url) => url.searchParams.get('pageNum'))).toEqual(['1', '2', '3'])
    for (const url of requests) {
      expect(url.origin + url.pathname).toBe(LIST)
      expect(url.searchParams.get('pageSize')).toBe(String(PHEMEX_PAGE_SIZE_CAP))
    }
    expect(result.terminationReason).toBe('reported_population_reached')
    // RAW is the verbatim response; the captured bid header never enters it.
    expect(result.sourcePages.map((page) => page.rawPage.payload)).toEqual(pages)
    expect(JSON.stringify(result.sourcePages)).not.toContain('device')

    const { validated, bound } = evidence(result, tf)
    expect(validated.valid).toHaveLength(120)
    expect(validated.valid[0].headlineMetricSources?.roi?.fieldPath).toBe(
      `data.rows[].pnlRate${tf}d`
    )
    expect(bound).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
    expect(hasRegisteredLeaderboardMetricTrust(src, tf)).toBe(true)
  })

  it('refuses a board whose reported total does not bind', async () => {
    const pages = boardPages(120, PHEMEX_PAGE_SIZE_CAP)
    ;(pages[2].data as Json).total = 121
    const { result } = await capture(pages)
    expect(evidence(result, 30).bound.trustBound).toBe(false)
  })

  it('refuses a board truncated by the smoke-run cap', async () => {
    const { result } = await capture(boardPages(120, PHEMEX_PAGE_SIZE_CAP), 30, {
      ...src,
      meta: { max_pages: 1 },
    } as SourceRow)
    expect(result.terminationReason).toBe('caller_limit')
    expect(evidence(result, 30).bound.trustBound).toBe(false)
  })

  it('records an anti-bot answer as an upstream error, never an empty board', async () => {
    const pages = boardPages(120, PHEMEX_PAGE_SIZE_CAP)
    pages[1] = { code: 10500, msg: 'blocked', data: null }
    await expect(capture(pages)).rejects.toBeInstanceOf(LeaderboardCaptureUpstreamError)
  })

  it('refuses a 7d window and a page size above the server cap before any request', async () => {
    const requests: URL[] = []
    await expect(phemexAdapter.captureLeaderboard!(session([], requests), src, 7)).rejects.toThrow(
      'no native 7d board'
    )
    await expect(
      phemexAdapter.captureLeaderboard!(
        session([], requests),
        { ...src, page_size: 51 } as SourceRow,
        30
      )
    ).rejects.toThrow('page_size must be 1-50')
    expect(requests).toHaveLength(0)
  })
})
