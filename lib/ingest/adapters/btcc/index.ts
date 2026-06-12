/**
 * BTCC Futures copy-trading adapter (spec §7 #23 / §11.15).
 * Board URL: https://www.btcc.com/en-US/copy-trading?type=all
 * Profile URL: /en-US/copy-trading/{traderId}
 *
 * FETCH MODEL: the /documentary API is fully public — it accepts plain
 * external requests with no cookies or signed headers (verified by curl
 * 2026-06-11), so no warm page load is needed: every surface is direct
 * APIRequestContext JSON replay (spec §2.2).
 *
 * Endpoints (base www.btcc.com/documentary):
 *   list:      POST trader/page {nickName:'',sortType:1,pageNum,pageSize}
 *              → {total, rows}. NATIVE 30d ONLY (rateProfit == the 30d
 *              profile window ROI; verified live). The 7/90 boards are
 *              SYNTHESIZED from profile stats (derive-boards, spec §1.1-C).
 *   profile:   GET  traderHomePage/info / profitInfo (identity + all-time)
 *              POST traderHomePage/gain / profit / tradeAmount / symbolRate
 *              {reportType: 7|30|90, traderId}  (UI labels 7D/1M/3M)
 *   positions: POST traderHomePage/currentBringRecord {pageNum,pageSize,traderId}
 *   history:   POST traderHomePage/hisotryBringRecord (sic — BTCC's typo)
 *   copiers:   POST traderBring/follow/page (masked-email PII, never rendered)
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
import { apiFetcher, replayJson, replayPaged, type JsonFetcher } from '../../fetch/capture'
import {
  parseBtccHistory,
  parseBtccLeaderboardPage,
  parseBtccPositions,
  parseBtccProfile,
} from './parsers'

const BASE = 'https://www.btcc.com/documentary'

const HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

async function btccFetcher(session: FetchSession): Promise<JsonFetcher> {
  return apiFetcher(await session.api())
}

const btccAdapter: SourceAdapter = {
  slug: 'btcc',
  capabilities: {
    profile: true,
    positions: true, // POST traderHomePage/currentBringRecord
    positionHistory: true, // POST traderHomePage/hisotryBringRecord
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: true, // POST traderBring/follow/page
  },

  /** Native board is 30d only — the scheduler only requests TFs from
   *  timeframes_native={30}; anything else would be a config error. */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    if (timeframe !== 30) {
      throw new Error(
        `[btcc] native board is 30d only (got ${timeframe}d) — 7/90 are derived boards`
      )
    }
    const fetcher = await btccFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/trader/page`)
    const pageSize = src.page_size ?? 50
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: listUrl,
        method: 'POST',
        headers: HEADERS,
        body: { nickName: '', sortType: 1, pageNum: pageIndex, pageSize },
      }),
      extractMeta: (payload) => {
        const parsed = parseBtccLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) return
    }
  },

  /**
   * Profile bundle per TF (6 replayed requests): identity + all-time block
   * + per-TF gain stats + daily cumulative PnL/ROI series + daily volume
   * bars + crypto-preference donut. These per-TF stats are the SUBSTRATE of
   * the derived 7/90 boards (derive-boards processor).
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const fetcher = await btccFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const traderId = Number(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
    const post = (url: string, body: unknown) =>
      replayJson(session, fetcher, { url, method: 'POST', headers: HEADERS, body })

    const homeBase = endpoint(src, 'profileBase', `${BASE}/traderHomePage`)
    const info = await get(`${homeBase}/info?traderId=${traderId}`)
    const profitInfo = await get(`${homeBase}/profitInfo?traderId=${traderId}`)
    const body = { reportType: tf, traderId }
    const gain = await post(`${homeBase}/gain`, body)
    const profit = await post(`${homeBase}/profit`, body)
    const tradeAmount = await post(`${homeBase}/tradeAmount`, body)
    const symbolRate = await post(`${homeBase}/symbolRate`, body)

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { info, profitInfo, gain, profit, tradeAmount, symbolRate, timeframe: tf },
          url: `${homeBase}/gain`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Ongoing lead positions — one big page (site itself uses pageSize 1000). */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    const url = endpoint(src, 'positions', `${BASE}/traderHomePage/currentBringRecord`)
    const payload = await replayJson(session, await btccFetcher(session), {
      url,
      method: 'POST',
      headers: HEADERS,
      body: { pageNum: 1, pageSize: 1000, traderId: Number(exchangeTraderId) },
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * History: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest closeTime ≤ cursor) or at the safety cap.
   * Copiers: snapshot-style pagination until a short page.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[btcc] history surface ${kind} not supported`)
    }
    const fetcher = await btccFetcher(session)
    const ctx = dummyCtx(src)
    const traderId = Number(exchangeTraderId)
    const limit = 50

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory', `${BASE}/traderHomePage/hisotryBringRecord`)
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url,
          method: 'POST',
          headers: HEADERS,
          body: { pageNum: pageIndex, pageSize: limit, traderId },
        })
        const rows = parseBtccHistory(payload, 'position_history', ctx)
        if (rows.length === 0) return
        yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
        if (rows.length < limit) return // last (short) page
        if (cursor !== null) {
          const oldest = rows[rows.length - 1]
          if (oldest.kind === 'position_history' && oldest.closedAt && oldest.closedAt <= cursor) {
            return // overlap reached — older pages are already stored
          }
        }
      }
      return
    }

    // copiers
    const url = endpoint(src, 'copiers', `${BASE}/traderBring/follow/page`)
    const maxPages = Number(src.meta.copier_max_pages) || 30
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: HEADERS,
        body: { pageNum: pageIndex, pageSize: limit, traderId },
      })
      const rows = parseBtccHistory(payload, 'copiers', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (rows.length < limit) return
    }
  },

  parseLeaderboard: parseBtccLeaderboardPage,
  parseProfile: parseBtccProfile,
  parsePositions: parseBtccPositions,
  parseHistory: parseBtccHistory,
}

/** Parse-time ctx for in-adapter parsing (counts/stop rules only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(btccAdapter)

export { btccAdapter }
