/**
 * Multi-page attempt-bound evidence for total-mode boards whose live paging
 * was probed (2026-11-15): kucoin_futures, toobit_futures, xt_futures.
 *
 * Each case drives the adapter's own `captureLeaderboard` over a fake
 * upstream, parses and validates the captured pages as Tier-A does, and asks
 * the attempt-bound evidence helper whether publication would bind the
 * board. A complete board binds; a board that moved while paging (duplicate
 * rows), stopped short of its total, or changed its reported total between
 * pages must not.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { SourceAdapter } from '../core/adapter'
import type { RankingTimeframe, SourceRow } from '../core/types'
import type { LeaderboardCapture } from '../fetch/capture'
import type { FetchSession, ReplayRequestTemplate } from '../fetch/types'
import { validateLeaderboardRows } from '../staging/validate'
import { attemptBoundEvidenceForCapture } from '../testing/attempt-bound-evidence'
import { kucoinAdapter } from '../adapters/kucoin'
import { toobitAdapter } from '../adapters/toobit'
import { xtAdapter } from '../adapters/xt'

type Json = Record<string, unknown>

function fixture(dir: string, name: string): Json {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'adapters', dir, '__tests__', 'fixtures', name), 'utf8')
  ) as Json
}

interface BoardCase {
  slug: string
  adapter: SourceAdapter
  adapterSlug: string
  timeframe: RankingTimeframe
  meta?: Json
  /** One upstream page with these trader ids and this reported total. */
  page: (ids: string[], total: number, pageCount: number) => Json
  /** 1-based page index of an actual upstream request. */
  pageOf: (request: ReplayRequestTemplate) => number
}

const PAGE_SIZE = 2

function queryPage(request: ReplayRequestTemplate): number {
  return Number(new URL(request.url).searchParams.get('page'))
}

const kucoinRow = (fixture('kucoin', 'leaderboard-p1.json').data as { items: Json[] }).items[0]
const toobitRow = (fixture('toobit', 'leaders-new-p1.json').data as { list: Json[] }).list[0]
const xtRow = (fixture('xt', 'leaderboard-fut-30.json').result as { items: Json[] }).items[0]

const CASES: BoardCase[] = [
  {
    slug: 'kucoin_futures',
    adapter: kucoinAdapter,
    adapterSlug: 'kucoin',
    timeframe: 30,
    page: (ids, total, pageCount) => ({
      success: true,
      code: '200',
      data: {
        totalNum: total,
        totalPage: pageCount,
        items: ids.map((id) => ({ ...kucoinRow, leadConfigId: Number(id) })),
      },
    }),
    pageOf: (request) => (request.body as { currentPage: number }).currentPage,
  },
  {
    slug: 'toobit_futures',
    adapter: toobitAdapter,
    adapterSlug: 'toobit',
    timeframe: 30,
    page: (ids, total, pageCount) => ({
      code: 200,
      data: {
        list: ids.map((id) => ({ ...toobitRow, leaderUserId: id })),
        pages: String(pageCount),
        total: String(total),
      },
    }),
    pageOf: queryPage,
  },
  {
    slug: 'xt_futures',
    adapter: xtAdapter,
    adapterSlug: 'xt',
    timeframe: 30,
    meta: { boardKey: 'futures' },
    page: (ids, total) => ({
      returnCode: 0,
      msgInfo: 'success',
      error: null,
      result: { total, items: ids.map((id) => ({ ...xtRow, accountId: id })) },
    }),
    pageOf: queryPage,
  },
]

function sourceRow(item: BoardCase): SourceRow {
  return {
    id: 41,
    slug: item.slug,
    exchange_id: 41,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: item.adapterSlug,
    leaderboard_url: 'https://example.invalid/board',
    timeframes_native: [item.timeframe],
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
    phase: 2,
    serving_mode: 'serving',
    status: 'active',
    meta: item.meta ?? {},
  }
}

/** Fake upstream answering every transport the adapters use (page, api, global fetch). */
function fakeSession(slug: string, respond: (request: ReplayRequestTemplate) => Json) {
  const answer = (request: ReplayRequestTemplate) => {
    const json = respond(request)
    return { status: () => 200, json: async () => json }
  }
  return {
    sourceSlug: slug,
    page: async () => ({
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
    }),
    api: async () => ({
      get: async (url: string) => answer({ url, method: 'GET', headers: {} }),
      post: async (url: string, options?: { data?: unknown }) =>
        answer({ url, method: 'POST', headers: {}, body: options?.data }),
    }),
    pageFetch: async (request: ReplayRequestTemplate) => ({ status: 200, json: respond(request) }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
}

/** pages[i] = [ids, reportedTotal]; requests past the last page get an empty page. */
async function evidenceFor(item: BoardCase, pages: Array<[string[], number]>) {
  const src = sourceRow(item)
  const respond = (request: ReplayRequestTemplate) => {
    const index = item.pageOf(request)
    const [ids, total] = pages[index - 1] ?? [[], pages.at(-1)![1]]
    return item.page(ids, total, Math.ceil(total / PAGE_SIZE))
  }
  const originalFetch = global.fetch
  global.fetch = (async (url: string) => ({
    status: 200,
    json: async () => respond({ url, method: 'GET', headers: {} }),
  })) as unknown as typeof fetch
  try {
    const capture = (await item.adapter.captureLeaderboard!(
      fakeSession(item.slug, respond),
      src,
      item.timeframe
    )) as LeaderboardCapture
    const ctx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt: new Date().toISOString(),
      meta: src.meta,
    }
    const validated = validateLeaderboardRows(
      capture.parsePages.flatMap((page) => item.adapter.parseLeaderboard(page.payload, ctx).rows)
    )
    return {
      capture,
      result: attemptBoundEvidenceForCapture({
        capture,
        source: src,
        timeframe: item.timeframe,
        acceptedPopulation: validated.valid.length,
        rejectedRowCount: validated.rejects.length,
      }),
    }
  } finally {
    global.fetch = originalFetch
  }
}

describe.each(CASES.map((item) => [item.slug, item] as const))(
  '%s paged total-mode capture',
  (_slug, item) => {
    it('binds a board whose distinct rows reach the reported total', async () => {
      const { capture, result } = await evidenceFor(item, [
        [['101', '102'], 4],
        [['103', '104'], 4],
      ])
      expect(capture.sourcePages).toHaveLength(2)
      expect(capture.terminationReason).toBe('reported_population_reached')
      expect(result).toMatchObject({ completenessMode: 'reported_total', trustBound: true })
      expect(result.projection).toMatchObject({
        terminalState: 'complete',
        reportedPopulation: 4,
        acceptedPopulation: 4,
      })
    })

    it('does not bind a board that moved while paging (duplicate row)', async () => {
      const { result } = await evidenceFor(item, [
        [['101', '102'], 4],
        [['102', '103'], 4],
      ])
      expect(result.projection.terminalState).not.toBe('complete')
      expect(result.trustBound).toBe(false)
    })

    it('does not bind a board that ends short of its reported total', async () => {
      const { result } = await evidenceFor(item, [
        [['101', '102'], 5],
        [['103', '104'], 5],
      ])
      expect(result.trustBound).toBe(false)
    })

    it('does not bind a board whose reported total changes between pages', async () => {
      const { result } = await evidenceFor(item, [
        [['101', '102'], 4],
        [['103', '104'], 5],
        [['105'], 5],
      ])
      expect(result.trustBound).toBe(false)
    })
  }
)

describe('xt_spot', () => {
  it('has no attempt-bound capture (placeholder rows make completeness unprovable)', async () => {
    const src = { ...sourceRow(CASES[2]), slug: 'xt_spot', meta: { boardKey: 'spot' } }
    await expect(
      xtAdapter.captureLeaderboard!(
        fakeSession('xt_spot', () => ({})),
        src,
        30
      )
    ).rejects.toThrow(/spot board has no attempt-bound capture/)
  })
})
