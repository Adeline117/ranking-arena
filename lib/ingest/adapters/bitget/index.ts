/**
 * Bitget adapter (Phase 0 reference source — spec §15 Phase 0, §11.4).
 * One adapter serves bitget_futures / bitget_spot / bitget_cfd; the board
 * is selected by src.meta.boardKey. Known JSON endpoints (from the legacy
 * connector, overridable per-source via src.meta.endpoints):
 *   list (UTA): POST /v1/trigger/public/uta/traderView (futures; spot/cfd below)
 *   profile:    POST /v1/trigger/trace/public/traderDetailPageV2 {traderUid}
 *   charts:     POST /v1/trigger/trace/public/cycleData {triggerUserId, cycleTime}
 * (legacy trader/detail + profitList endpoints are dead — verified 2026-06-11)
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
  parseBitgetHistory,
  parseBitgetLeaderboardPage,
  parseBitgetPositions,
  parseBitgetProfile,
} from './parsers'
import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
  type HistoryTerminalClaimReason,
} from '../../history-acquisition'
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from './history-terminal'
import { BITGET_COPIER_HISTORY_URL } from './copier-snapshot'

const BASE = 'https://www.bitget.com/v1/trigger/trace/public'
/** UTA portfolio-trader profile family (board rows with type=2; keyed by
 *  portfolioId from traders.meta — traderUid is rejected). Profile page:
 *  /zh-CN/copy-trading/futures-trader/{portfolioId} (verified 2026-06-11). */
const UTA_BASE = 'https://www.bitget.com/v1/trigger/public/uta'

/** UTA board-list endpoints per boardKey (verified by live capture 2026-06). */
const UTA_LIST_ENDPOINTS: Record<string, string> = {
  futures: 'https://www.bitget.com/v1/trigger/public/uta/traderView',
  spot: 'https://www.bitget.com/v1/trace/spot/public/uta/traderView',
  cfd: 'https://www.bitget.com/v1/trace/mt5/public/traderView',
}

const UTA_HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  language: 'zh_CN',
  locale: 'zh_CN',
  website: 'copy',
  terminaltype: '1',
}

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function historyTerminalClaim(
  reason: HistoryTerminalClaimReason,
  pageOrdinal: number
): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'default', reason, page_ordinal: pageOrdinal }],
  }
}

/**
 * Bitget's WAF 403s cold API hits; one page load establishes the session
 * cookies and the rest is pure JSON replay (spec §2.2). Warm once per
 * FetchSession — the persistent context keeps cookies across runs, so
 * subsequent sessions usually replay without a fresh page load.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.bitget.com/zh-CN/copy-trading/futures'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  try {
    await page.waitForLoadState('networkidle', { timeout: 20_000 })
  } catch {
    // networkidle is best-effort — a busy page still yields valid cookies
  }
  warmedSessions.add(session)
}

/** Session-scoped detailV2 cache (LRU-ish: cleared per trader change is
 *  unnecessary — Tier-B visits each trader once, 3 TFs back to back). */
const detailV2Cache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cachedDetailV2(
  session: FetchSession,
  traderId: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = detailV2Cache.get(session)
  if (!cache) {
    cache = new Map()
    detailV2Cache.set(session, cache)
  }
  if (cache.has(traderId)) return cache.get(traderId)
  const value = await fetch()
  // Bound memory on long sessions: keep only the most recent traders.
  if (cache.size > 50) cache.clear()
  cache.set(traderId, value)
  return value
}

const bitgetAdapter: SourceAdapter = {
  slug: 'bitget',
  capabilities: {
    profile: true,
    positions: true, // POST public/traderPosition (1h-delayed for non-copiers)
    positionHistory: true, // POST trace/order/historyList (历史带单)
    orders: false,
    // 余额历史 no longer exists in the UTA profile UI (2026-06-11): all
    // balance/transfer endpoint candidates demand an auth token (00005).
    transfers: false,
    // Evidence-only: followerList is a top-50 view and cannot authorize the
    // source-level `full` publication contract. The endpoint remains available
    // to explicit non-publication captures, but this adapter deliberately
    // exposes no reviewed snapshot verifier.
    copiers: true,
  },

  historyTerminalVerifier(src, kind) {
    return src.slug === 'bitget_futures' &&
      src.product_type === 'futures' &&
      kind === 'position_history' &&
      endpoint(src, 'positionHistory', BITGET_POSITION_HISTORY_URL) === BITGET_POSITION_HISTORY_URL
      ? bitgetPositionHistoryTerminalVerifier
      : null
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    // The UTA API 403s external requests (signed tm/dy-token headers) but
    // accepts same-origin in-page fetches without them — so replay runs
    // through pageFetcher. Rapid unsigned requests get silently served
    // EMPTY rows, which the paced gate's 2.5s budget avoids.
    const fetcher = pageFetcher(session)
    const boardKey = (src.meta.boardKey as string) ?? 'futures'
    const listUrl = endpoint(src, 'list', UTA_LIST_ENDPOINTS[boardKey])
    const pageSize = src.page_size ?? 30

    yield* replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: listUrl,
        method: 'POST',
        headers: UTA_HEADERS,
        body: {
          pageNo: pageIndex,
          pageSize,
          sortRule: 2,
          sortFlag: 0,
          dataCycle: timeframe,
          fullStatus: 1,
          languageType: 1,
        },
      }),
      extractMeta: (payload) => {
        const page = parseBitgetLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: page.rows.length, reportedTotal: page.reportedTotal }
      },
      pageSize,
    })
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe,
    traderMeta?: Record<string, unknown> | null
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe

    // UTA portfolio traders (type=2): different endpoint family keyed by
    // portfolioId — the trace family rejects their traderUid with 30081.
    const portfolioId =
      Number(traderMeta?.bitget_trader_type) === 2 && traderMeta?.portfolio_id
        ? String(traderMeta.portfolio_id)
        : null
    if (portfolioId !== null) {
      const utaDetails = await cachedDetailV2(session, `uta:${portfolioId}`, () =>
        replayJson(session, fetcher, {
          url: endpoint(src, 'utaDetails', `${UTA_BASE}/details`),
          method: 'POST',
          headers: UTA_HEADERS,
          body: { portfolioId },
        })
      )
      const utaPerformance = await replayJson(session, fetcher, {
        url: endpoint(src, 'utaPerformance', `${UTA_BASE}/performance`),
        method: 'POST',
        headers: UTA_HEADERS,
        body: { portfolioId, cycleTime: tf },
      })
      const utaChart = await replayJson(session, fetcher, {
        url: endpoint(src, 'utaChart', `${UTA_BASE}/cycleChartData`),
        method: 'POST',
        headers: UTA_HEADERS,
        body: { portfolioId, cycleTime: tf },
      })
      const fetchedAt = new Date().toISOString()
      return {
        pages: [
          {
            pageIndex: 1,
            payload: { utaDetails, utaPerformance, utaChart, timeframe: tf },
            url: `${UTA_BASE}/performance`,
            fetchedAt,
          },
        ],
        fetchedAt,
      }
    }

    const detailUrl = endpoint(src, 'profile', `${BASE}/traderDetailPageV2`)
    const cycleUrl = endpoint(src, 'cycleData', `${BASE}/cycleData`)

    // detailV2 is timeframe-independent — fetch once per (session, trader)
    // and reuse across the 3 TF calls Tier-B makes back to back.
    const detailV2 = await cachedDetailV2(session, exchangeTraderId, () =>
      replayJson(session, fetcher, {
        url: detailUrl,
        method: 'POST',
        headers: UTA_HEADERS,
        body: { traderUid: exchangeTraderId },
      })
    )
    const cycleData = await replayJson(session, fetcher, {
      url: cycleUrl,
      method: 'POST',
      headers: UTA_HEADERS,
      body: { triggerUserId: exchangeTraderId, cycleTime: tf },
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detailV2, cycleData, timeframe: tf },
          url: cycleUrl,
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
    const url = endpoint(src, 'positions', `${BASE}/traderPosition`)
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'POST',
      headers: UTA_HEADERS,
      body: { traderUid: exchangeTraderId },
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Incremental history pages, newest→oldest (spec §2.3).
   *   position_history: POST trace/order/historyList (sorted by closeTime
   *     desc) — stops on cursor overlap (oldest closeTime ≤ stored cursor).
   *   copiers: POST trace/trader/followerList — capped top-50 evidence only;
   *     never a source-level full-publication proof.
   * NOT replayPaged: its completeness assertion treats an early cursor stop
   * as a truncated crawl; incremental stops are the point here.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[bitget] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url =
      kind === 'position_history'
        ? endpoint(src, 'positionHistory', BITGET_POSITION_HISTORY_URL)
        : endpoint(src, 'copiers', BITGET_COPIER_HISTORY_URL)
    const pageSize = kind === 'copiers' ? 10 : 20
    // First-sight backfill depth cap (configurable per source); incremental
    // runs stop on cursor overlap long before hitting it.
    const maxPages = Number(src.meta.history_max_pages ?? 25) || 25
    const cursorMs = cursor ? Date.parse(cursor) : NaN

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const request = { pageNo, pageSize, traderUid: exchangeTraderId }
      const payload = await replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: UTA_HEADERS,
        body: request,
      })
      yield {
        pageIndex: pageNo,
        payload: {
          contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
          historyTraderIdentity: exchangeTraderId,
          request,
          response: payload,
        },
        url,
        fetchedAt: new Date().toISOString(),
      }

      if (!isRecord(payload) || payload.code !== '00000') {
        throw new Error(`[bitget] ${kind} returned a non-success API envelope`)
      }
      if (!isRecord(payload.data)) {
        throw new Error(`[bitget] ${kind} returned a malformed rows envelope`)
      }
      const data = payload.data
      const rawRows = data.rows
      if (!Array.isArray(rawRows)) {
        throw new Error(`[bitget] ${kind} returned a malformed rows envelope`)
      }
      if (!rawRows.every(isRecord) || rawRows.length > pageSize) {
        throw new Error(`[bitget] ${kind} returned an invalid history page`)
      }
      const rows = rawRows.filter(isRecord)
      if (
        data.nextFlag !== undefined &&
        data.nextFlag !== null &&
        typeof data.nextFlag !== 'boolean'
      ) {
        throw new Error(`[bitget] ${kind} returned an invalid nextFlag`)
      }
      if (data.nextFlag === false) return historyTerminalClaim('reported_end', pageNo)
      if (rows.length < pageSize && data.nextFlag === true) {
        throw new Error(`[bitget] ${kind} short page still claims continuation`)
      }
      if (rows.length === 0) return historyTerminalClaim('empty_page', pageNo)
      if (rows.length < pageSize) return historyTerminalClaim('short_page', pageNo)
      if (kind === 'position_history' && Number.isFinite(cursorMs)) {
        const closeTimes = rows
          .map((row) => Number(row.closeTime))
          .filter((closeTime) => Number.isFinite(closeTime) && closeTime > 0)
        // Overlap reached: this page already dips into stored history.
        if (closeTimes.length > 0 && Math.min(...closeTimes) <= cursorMs) {
          return historyTerminalClaim('cursor_overlap', pageNo)
        }
      }
    }
    throw new Error(`[bitget] ${kind} reached page cap ${maxPages} without terminal proof`)
  },

  parseLeaderboard: parseBitgetLeaderboardPage,
  parseProfile: parseBitgetProfile,

  parsePositions: parseBitgetPositions,

  parseHistory: parseBitgetHistory,
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

registerAdapter(bitgetAdapter)

export { bitgetAdapter }
