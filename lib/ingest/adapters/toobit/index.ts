/**
 * Toobit Futures copy-trading adapter (spec §7 #25, §9 open item 2).
 *
 * PURE HTTP — no Playwright. The bapi answers plain fetch() (verified
 * live 2026-06-12 FROM THE SG VPS; fetch_region='vps_sg', the VPS worker
 * runs INGEST_LOCAL_REGION=vps_sg so fetches exit from SG). Endpoints
 * were extracted from the SPA bundle (app.*.js api map) because the
 * /copytrading page renders a landing carousel only:
 *
 *   GET bapi.toobit.com/bapi/v1/copy-trading/
 *     leaders-new?page&pageSize&dataType={7|30|90}&hideFull=0
 *         THE board — native per-TF (dataType echoes on rows), sorted by
 *         window ROI. pageSize is IGNORED (server pins 6 rows/page →
 *         sources.page_size=6); {list, pages:"265", total:"1587"} at
 *         survey. Rows carry ROI/PnL/win-rate/Sharpe/AUM + an embedded
 *         daily cumulative-ROI sparkline (leaderTradeProfit) — kept
 *         verbatim in entries.raw.
 *         NOTE survey said "~65 traders"; the real total is ~1,587.
 *     leader-detail?leaderUserId&dataType        identity + counts + fees
 *     get-leader-radar-chart?leaderUserId&type   ROI/MDD/win-rate (+site
 *         percentiles) per TF — radar.leaderProfitRatio == board ROI
 *         (cross-checked live)
 *     get-leader-trade-accumulate-profit?leaderUserId&type
 *         daily CUMULATIVE PnL ($) series (≈ board pnl at window end)
 *     current-lead-orders?leaderUserId           open positions — leaders
 *         can MASK fields ("****" symbol/qty/price) → masked rows skipped
 *     history-lead-orders?leaderUserId&page      closed positions (page
 *         pagination verified); id/orderId are often "0" → tuple dedupe
 *     top-followers?leaderUserId                 top copiers (~6 rows)
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import {
  parseToobitHistory,
  parseToobitLeaderboardPage,
  parseToobitLeaderboardSeries,
  parseToobitPositions,
  parseToobitProfile,
} from './parsers'

const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const MAX_BOARD_PAGES = 400 // ~265 at survey; hard safety cap
const DEFAULT_HISTORY_MAX_PAGES = 5

type Dict = Record<string, unknown>

function base(src: SourceRow): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints.base ?? API_BASE
}

/** Paced plain-HTTP GET; toobit envelopes everything as {code,data,msg}. */
async function fetchData<T = unknown>(session: FetchSession, url: string): Promise<T> {
  return session.paced(async () => {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        origin: 'https://www.toobit.com',
        referer: 'https://www.toobit.com/en-US/copytrading',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[toobit] HTTP ${res.status} from ${url}`)
    const payload = (await res.json()) as { code?: unknown; data?: unknown; msg?: unknown }
    if (payload.code !== 200) {
      throw new Error(
        `[toobit] API code ${String(payload.code)} (${String(payload.msg)}) from ${url}`
      )
    }
    return payload.data as T
  })
}

// ── leader-detail, memoized per (session, trader) — TF-independent ──

const detailCache = new WeakMap<FetchSession, Map<string, Promise<Dict>>>()

function getDetail(session: FetchSession, src: SourceRow, leaderId: string): Promise<Dict> {
  let perSession = detailCache.get(session)
  if (!perSession) {
    perSession = new Map()
    detailCache.set(session, perSession)
  }
  let cached = perSession.get(leaderId)
  if (!cached) {
    cached = fetchData<Dict>(session, `${base(src)}/leader-detail?leaderUserId=${leaderId}`)
    perSession.set(leaderId, cached)
    cached.catch(() => perSession!.delete(leaderId))
  }
  return cached
}

const toobitAdapter: SourceAdapter = {
  slug: 'toobit',
  capabilities: {
    profile: true, // leader-detail + radar + accumulate-profit
    positions: true, // current-lead-orders (mask-aware)
    positionHistory: true, // history-lead-orders
    orders: false, // not exposed publicly
    transfers: false, // leader-transfer-history needs auth
    copiers: true, // top-followers
  },

  /**
   * Native per-TF board: pages 1..reported `pages` (server pins 6
   * rows/page — pageIndex maps straight onto Tier-A rank re-anchoring
   * with sources.page_size=6). The live board shifts under pagination;
   * the staging validator dedupes by leaderUserId keeping the best rank.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const maxPagesKnob = Number(src.meta.max_pages) || null
    let pageCount: number | null = null

    for (let page = 1; page <= Math.min(maxPagesKnob ?? pageCount ?? 1, MAX_BOARD_PAGES); page++) {
      const url =
        `${base(src)}/leaders-new?page=${page}&pageSize=20` + `&dataType=${timeframe}&hideFull=0`
      const data = await fetchData<{ list?: unknown; pages?: unknown; total?: unknown }>(
        session,
        url
      )
      if (pageCount === null) {
        const reported = Number(data.pages)
        pageCount = Number.isFinite(reported) && reported > 0 ? reported : 1
        if (maxPagesKnob !== null) pageCount = Math.min(pageCount, maxPagesKnob)
      }
      const list = Array.isArray(data.list) ? data.list : []
      if (list.length === 0) break

      yield {
        pageIndex: page,
        payload: { timeframe, board: { list, pages: data.pages, total: data.total } },
        url,
        fetchedAt: new Date().toISOString(),
      }
    }
  },

  /**
   * Profile bundle per TF: leader-detail (memoized — TF-independent) +
   * radar chart (ROI/MDD/win rate) + cumulative-PnL series, both
   * type-mapped. The composite payload embeds the timeframe so
   * parseProfile stays pure (spec §5.5).
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const tf = timeframe === 0 ? 90 : timeframe
    const detail = await getDetail(session, src, exchangeTraderId)
    const radarUrl = `${base(src)}/get-leader-radar-chart?leaderUserId=${exchangeTraderId}&type=${tf}`
    const radar = await fetchData<Dict>(session, radarUrl)
    const accumulate = await fetchData<Dict[]>(
      session,
      `${base(src)}/get-leader-trade-accumulate-profit?leaderUserId=${exchangeTraderId}&type=${tf}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            timeframe: tf,
            detail: { data: detail },
            radar: { data: radar },
            accumulate: { data: accumulate },
          },
          url: radarUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Tier D: open lead positions, fresh each call (mask-aware parse). */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    const url = `${base(src)}/current-lead-orders?leaderUserId=${exchangeTraderId}`
    const data = await fetchData<Dict[]>(session, url)
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload: { data }, url, fetchedAt }], fetchedAt }
  },

  /**
   * position_history: page pagination, newest→oldest; stops on cursor
   * overlap (oldest openTime ≤ stored ISO cursor), exhaustion, or the
   * meta.history_max_pages cap. copiers: one top-followers response.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind === 'copiers') {
      const url = `${base(src)}/top-followers?leaderUserId=${exchangeTraderId}`
      const data = await fetchData<Dict[]>(session, url)
      yield { pageIndex: 1, payload: { data }, url, fetchedAt: new Date().toISOString() }
      return
    }
    if (kind !== 'position_history') {
      throw new Error(`[toobit] history surface ${kind} not supported`)
    }

    const maxPages =
      Number(src.meta.history_max_pages ?? DEFAULT_HISTORY_MAX_PAGES) || DEFAULT_HISTORY_MAX_PAGES
    const cursorMs = cursor ? Date.parse(cursor) : NaN
    for (let page = 1; page <= maxPages; page++) {
      const url =
        `${base(src)}/history-lead-orders?leaderUserId=${exchangeTraderId}` +
        `&page=${page}&pageSize=20`
      const data = await fetchData<{ list?: unknown }>(session, url)
      const list = Array.isArray(data.list) ? (data.list as Dict[]) : []
      if (list.length === 0) break

      yield { pageIndex: page, payload: { data }, url, fetchedAt: new Date().toISOString() }

      if (Number.isFinite(cursorMs)) {
        const oldest = Number(list[list.length - 1].openTime)
        // Overlap reached: this page already dips into stored history.
        if (Number.isFinite(oldest) && oldest <= cursorMs) break
      }
    }
  },

  parseLeaderboard: parseToobitLeaderboardPage,
  parseLeaderboardSeries: parseToobitLeaderboardSeries,
  parseProfile: parseToobitProfile,
  parsePositions: parseToobitPositions,
  parseHistory: parseToobitHistory,
}

registerAdapter(toobitAdapter)

export { toobitAdapter }
