/**
 * Bybit copyTrade classic adapter ("beehive", spec §7 #4 / §11.3).
 * ~8.8k traders × pageSize 16 ≈ 550 pages per TF. No spot/futures split in
 * the UI → sources.product_type='futures' + meta.product_subtype='mixed_ui'
 * (spec §1.2 — do NOT invent types). Currency USDT.
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source
 * via src.meta.endpoints):
 *   list:      GET /x-api/fapi/beehive/public/v1/common/dynamic-leader-list
 *                  ?pageNo&pageSize&userTag=&dataDuration=DATA_DURATION_{...}_DAY
 *                  &leaderTag=&code=&leaderLevel=   (empty leaderTag = 全部交易达人;
 *                  named tags are the preset boards — ignored per spec §11.3)
 *   info:      GET .../private/v1/pub-leader/info?leaderMark=
 *                  ("private" path, anonymous-accessible)
 *   income:    GET .../public/v1/common/leader-income?leaderMark=  (all 3 TFs)
 *   chart:     GET .../public/v2/leader/dynamic-yield-trend
 *                  ?dayCycleType=...&period=PERIOD_DAY&leaderMark=
 *                  → metricListAll/metricList/metricListBot (全部/交易/机器人)
 *   positions: GET .../public/v1/common/position/list?leaderMark=
 *   history:   GET .../public/v1/common/leader-history?leaderMark=
 *                  &pageAction=first_page&pageSize=50
 *   copiers:   GET .../public/v1/common/other-follower?hasOneself=true
 *                  &leaderMark=&pageAction=first_page&pageSize=50
 *
 * Access notes (2026-06-11, same Akamai posture as bybit_mt5):
 *   - ONLY same-origin in-page fetch (pageFetcher) passes; external replay
 *     is fingerprint-blocked.
 *   - Bundled Chromium is TLS-blocked on page load; the real Chrome channel
 *     passes headless → sources.meta.browser_channel='chrome'.
 *   - leader-history / other-follower have a PUBLIC DEPTH LIMIT: newest ≤50
 *     rows (pageSize caps at 50); pageAction=next_page returns the same page
 *     with an empty cursor for anonymous sessions. One page per crawl;
 *     coverage accumulates via dedupe-hash upserts.
 *   - Landing platform aggregates (成功交易/跟单总人数/已结盈亏) are
 *     server-rendered DOM, not XHR → stored in sources.meta.platform_stats
 *     (spec §11.3 #1, Exchange Rankings page).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParseCtx,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseBybitCopytradeHistory,
  parseBybitCopytradeLeaderboardPage,
  parseBybitCopytradePositions,
  parseBybitCopytradeProfile,
} from './parsers'

const BASE = 'https://www.bybit.com/x-api/fapi/beehive/public/v1/common'
const CHART_BASE = 'https://www.bybit.com/x-api/fapi/beehive/public/v2/leader'
const INFO_BASE = 'https://www.bybit.com/x-api/fapi/beehive/private/v1/pub-leader'

const TF_DURATION: Record<RankingTimeframe, string> = {
  7: 'DATA_DURATION_SEVEN_DAY',
  30: 'DATA_DURATION_THIRTY_DAY',
  90: 'DATA_DURATION_NINETY_DAY',
}

const TF_CYCLE: Record<RankingTimeframe, string> = {
  7: 'DAY_CYCLE_TYPE_SEVEN_DAY',
  30: 'DAY_CYCLE_TYPE_THIRTY_DAY',
  90: 'DAY_CYCLE_TYPE_NINETY_DAY',
}

const HEADERS = { accept: 'application/json' }

/** Public depth limit on history/copier endpoints (verified 2026-06-11). */
const HISTORY_PAGE_SIZE = 50

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/**
 * One page load establishes the Akamai session; everything after is pure
 * same-origin JSON replay (spec §2.2). The persistent context keeps cookies
 * across runs, so later sessions usually replay without a fresh page load.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.bybit.com/copyTrade/'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** Session-scoped cache for the TF-independent profile requests (info +
 *  leader-income cover all 3 TFs) — Tier-B fetches 3 TFs back to back and
 *  only the chart varies per TF. */
const profileCache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cached(
  session: FetchSession,
  key: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = profileCache.get(session)
  if (!cache) {
    cache = new Map()
    profileCache.set(session, cache)
  }
  if (cache.has(key)) return cache.get(key)
  const value = await fetch()
  // Bound memory on long sessions: keep only the most recent traders.
  if (cache.size > 100) cache.clear()
  cache.set(key, value)
  return value
}

const bybitCopytradeAdapter: SourceAdapter = {
  slug: 'bybit_copytrade',
  capabilities: {
    profile: true,
    positions: true, // GET common/position/list (protected traders → [])
    positionHistory: true, // GET common/leader-history (newest 50 only)
    orders: false,
    transfers: false,
    copiers: true, // GET common/other-follower (top 50 only)
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/dynamic-leader-list`)
    const pageSize = src.page_size ?? 16
    // Validation knob: src.meta.max_pages caps the crawl (e.g. 20 pages for
    // a smoke run). Early generator return — replayPaged never sees a
    // truncation, so its completeness assertion stays scoped to real crawls.
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?pageNo=${pageIndex}&pageSize=${pageSize}&userTag=` +
          `&dataDuration=${TF_DURATION[timeframe]}&leaderTag=&code=&leaderLevel=`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseBybitCopytradeLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      if (maxPages !== null && ++pagesYielded >= maxPages) return
    }
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const mark = encodeURIComponent(exchangeTraderId)

    // info + leader-income are TF-independent (income carries all 3 TF
    // blocks) — fetched once per (session, trader).
    const infoUrl = endpoint(src, 'info', `${INFO_BASE}/info`)
    const info = await cached(session, `info:${exchangeTraderId}`, () =>
      replayJson(session, fetcher, {
        url: `${infoUrl}?leaderMark=${mark}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const incomeUrl = endpoint(src, 'income', `${BASE}/leader-income`)
    const income = await cached(session, `income:${exchangeTraderId}`, () =>
      replayJson(session, fetcher, {
        url: `${incomeUrl}?leaderMark=${mark}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const chartUrl = endpoint(src, 'chart', `${CHART_BASE}/dynamic-yield-trend`)
    const yieldTrend = await replayJson(session, fetcher, {
      url: `${chartUrl}?dayCycleType=${TF_CYCLE[tf]}&period=PERIOD_DAY&leaderMark=${mark}`,
      method: 'GET',
      headers: HEADERS,
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { info, income, yieldTrend, timeframe: tf },
          url: chartUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url = endpoint(src, 'positions', `${BASE}/position/list`)
    const payload = await replayJson(session, fetcher, {
      url: `${url}?leaderMark=${encodeURIComponent(exchangeTraderId)}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * 平仓历史 + 跟单用户 — PUBLIC DEPTH LIMIT (see module docs): anonymous
   * sessions get exactly one first_page of ≤50 rows; the response cursor
   * loops in place. Each crawl yields one page; coverage accumulates across
   * crawls via the dedupe-hash upserts (spec §2.3 incremental semantics).
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    _cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      // orders/transfers: not public. 机器人带单数据 endpoint undiscovered —
      // no bot-running trader in the top-48 sample on 2026-06-11.
      throw new Error(`[bybit-copytrade] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const mark = encodeURIComponent(exchangeTraderId)
    const url =
      kind === 'position_history'
        ? `${endpoint(src, 'positionHistory', `${BASE}/leader-history`)}` +
          `?leaderMark=${mark}&pageAction=first_page&pageSize=${HISTORY_PAGE_SIZE}`
        : `${endpoint(src, 'copiers', `${BASE}/other-follower`)}` +
          `?hasOneself=true&leaderMark=${mark}&pageAction=first_page&pageSize=${HISTORY_PAGE_SIZE}`
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'GET',
      headers: HEADERS,
    })
    yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
  },

  parseLeaderboard: parseBybitCopytradeLeaderboardPage,
  parseProfile: parseBybitCopytradeProfile,
  parsePositions: parseBybitCopytradePositions,
  parseHistory: parseBybitCopytradeHistory,
}

/** Parse-time ctx for extractMeta inside the replay loop (counts only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(bybitCopytradeAdapter)

export { bybitCopytradeAdapter }
