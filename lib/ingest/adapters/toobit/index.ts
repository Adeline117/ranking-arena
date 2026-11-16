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
 *     leaders-new?page&size&dataType={7|30|90}&hideFull=0
 *         THE board — native per-TF (dataType echoes on rows), sorted by
 *         window ROI. The page-size parameter is `size`: `pageSize` is
 *         ignored (6 rows/page), `size` is honoured up to at least 1000
 *         (probed 2026-11-15: total "2582" = 3 pages of size=1000, 2582
 *         distinct leaderUserIds, page one re-read identical). Rows carry
 *         ROI/PnL/win-rate/Sharpe/AUM + an embedded daily cumulative-ROI
 *         sparkline (leaderTradeProfit) — kept verbatim in entries.raw.
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
import type { JsonFetcher } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import {
  parseToobitHistory,
  parseToobitLeaderboardPage,
  parseToobitLeaderboardSeries,
  parseToobitPositions,
  parseToobitProfile,
} from './parsers'

const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const DEFAULT_HISTORY_MAX_PAGES = 5

type Dict = Record<string, unknown>

function base(src: SourceRow): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints.base ?? API_BASE
}

const HEADERS = {
  accept: 'application/json',
  origin: 'https://www.toobit.com',
  referer: 'https://www.toobit.com/en-US/copytrading',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

/** Plain-HTTP JsonFetcher (the capture paces and classifies the status). */
const toobitFetcher: JsonFetcher = async (template) => {
  const res = await fetch(template.url, { headers: template.headers })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // non-JSON body (block page) — the capture records it as an upstream error
  }
  return { status: res.status, json }
}

/** Upstream page meta: rows before parser validation; board population as reported. */
const toobitLeaderboardMeta = collectionMeta({
  label: 'toobit',
  assertSuccess: requireEnvelopeValue('toobit', ['code'], [200]),
  list: ['data', 'list'],
  total: ['data', 'total'],
  pageCount: ['data', 'pages'],
})

/** Paced plain-HTTP GET; toobit envelopes everything as {code,data,msg}. */
async function fetchData<T = unknown>(session: FetchSession, url: string): Promise<T> {
  return session.paced(async () => {
    const res = await fetch(url, { headers: HEADERS })
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
   * Native per-TF board in total mode: pages of `size` = sources.page_size
   * until the accepted rows reach the reported `total`. Parser pages are the
   * exact upstream envelopes; Tier-A re-anchors ranks by captured row counts.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    const listUrl = `${base(src)}/leaders-new`
    const pageSize = src.page_size ?? 1000
    return captureReplayLeaderboard(
      { session, fetcher: toobitFetcher, src, label: 'toobit', signal: options?.signal },
      {
        buildRequest: (pageIndex) => ({
          url: `${listUrl}?page=${pageIndex}&size=${pageSize}&dataType=${timeframe}&hideFull=0`,
          method: 'GET',
          headers: HEADERS,
        }),
        publicRequest: { query: ['page', 'size', 'dataType', 'hideFull'] },
        pageBinding: { location: 'query', key: 'page' },
        extractMeta: toobitLeaderboardMeta,
        pageSize,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await toobitAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
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
