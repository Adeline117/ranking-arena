/**
 * Bitunix Futures copy-trading adapter (spec §7 #24 / §11.16).
 * Board URL: https://www.bitunix.com/zh-tw/copy-trading/square/2/PL/1
 *            (square/{statisticType}/{oderType}/{page})
 * Profile URL: /zh-tw/copy-trading/profile/{uid}
 *
 * FETCH MODEL: api.bitunix.com is fully public — it accepts plain external
 * requests with no cookies or signed headers (verified by curl 2026-06-11),
 * so no warm page load is needed: every surface is direct APIRequestContext
 * JSON replay (spec §2.2).
 *
 * Endpoints (base api.bitunix.com/copy/trading/v1):
 *   list:      POST trader/list {statisticType,oderType:'PL',nickname:'',
 *              page,pageSize,version:1} — statisticType 1/2/3 = 7/30/90d
 *              ("oderType" is Bitunix's own typo); 180d (4) ignored (§1.1)
 *   profile:   POST trader/statistic {statisticType,uid} +
 *              POST trader/detail {uid}
 *   positions: GET  trader/position/pending?traderUid=
 *   history:   GET  trader/position/history?traderUid&page&pageSize
 *   copiers:   POST trader/follow/list {traderUid,page,pageSize}
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
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
} from '../../history-acquisition'
import {
  BITUNIX_COPIER_HISTORY_URL,
  BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT,
} from './copier-contract'
import {
  bitunixCopierIdentityKeys,
  bitunixCopierRequest,
  bitunixCopierSnapshotVerifier,
  validateBitunixCopierPage,
} from './copier-snapshot'
import {
  parseBitunixHistory,
  parseBitunixLeaderboardPage,
  parseBitunixLeaderboardSeries,
  parseBitunixPositions,
  parseBitunixProfile,
} from './parsers'

const BASE = 'https://api.bitunix.com/copy/trading/v1'

/** statisticType window selector (4 = 180d deliberately unused, spec §1.1). */
const TF_STAT: Record<RankingTimeframe, number> = { 7: 1, 30: 2, 90: 3 }

const HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function isCanonicalBitunixCopierSource(src: SourceRow): boolean {
  return (
    src.slug === 'bitunix_futures' &&
    src.status === 'active' &&
    src.serving_mode === 'serving' &&
    src.adapter_slug === 'bitunix' &&
    src.product_type === 'futures' &&
    src.trader_kind_scope === 'human' &&
    src.currency === 'USDT' &&
    src.copier_table_depth === 'full' &&
    endpoint(src, 'copiers', BITUNIX_COPIER_HISTORY_URL) === BITUNIX_COPIER_HISTORY_URL
  )
}

function copierMaxPages(src: SourceRow): number {
  const value = src.meta.copier_max_pages ?? 100
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    Object.is(value, -0)
  ) {
    throw new TypeError('[bitunix] copier_max_pages must be a positive safe integer')
  }
  return value
}

async function bitunixFetcher(session: FetchSession): Promise<JsonFetcher> {
  return apiFetcher(await session.api())
}

const bitunixAdapter: SourceAdapter = {
  slug: 'bitunix',
  capabilities: {
    profile: true,
    positions: true, // GET trader/position/pending
    positionHistory: true, // GET trader/position/history
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: true, // POST trader/follow/list
  },

  verifyCopierSnapshot(src) {
    return isCanonicalBitunixCopierSource(src) ? bitunixCopierSnapshotVerifier : null
  },

  /** One crawl per TF — statisticType makes the server emit window-scoped
   *  headline fields (self-describing payloads, pure re-parse safe). */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const fetcher = await bitunixFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/trader/list`)
    const pageSize = src.page_size ?? 100
    const orderType = typeof src.meta.list_order_by === 'string' ? src.meta.list_order_by : 'PL'
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
        body: {
          statisticType: TF_STAT[timeframe],
          oderType: orderType, // sic — Bitunix's own param name
          nickname: '',
          page: pageIndex,
          pageSize,
          version: 1,
        },
      }),
      extractMeta: (payload) => {
        const parsed = parseBitunixLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) return
    }
  },

  /** Profile bundle per TF (2 replayed requests): 帶單表現 + 帶單員總覽. */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const fetcher = await bitunixFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const uid = Number(exchangeTraderId)
    const post = (url: string, body: unknown) =>
      replayJson(session, fetcher, { url, method: 'POST', headers: HEADERS, body })

    const statistic = await post(endpoint(src, 'statistic', `${BASE}/trader/statistic`), {
      statisticType: TF_STAT[tf],
      uid,
    })
    const detail = await post(endpoint(src, 'detail', `${BASE}/trader/detail`), { uid })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { statistic, detail, timeframe: tf },
          url: `${BASE}/trader/statistic`,
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
    const url =
      endpoint(src, 'positions', `${BASE}/trader/position/pending`) +
      `?traderUid=${encodeURIComponent(exchangeTraderId)}`
    const payload = await replayJson(session, await bitunixFetcher(session), {
      url,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * 歷史帶單: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest mtime ≤ cursor) or at the safety cap.
   * 跟單者: reported-total crawl-interval pagination. The upstream endpoint
   * exposes no point-in-time snapshot token; observedAt is crawl completion.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncGenerator<RawPage, HistoryTerminalClaim | undefined, void> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[bitunix] history surface ${kind} not supported`)
    }
    const fetcher = await bitunixFetcher(session)
    const ctx = dummyCtx(src)

    if (kind === 'position_history') {
      const limit = 20
      const url = endpoint(src, 'positionHistory', `${BASE}/trader/position/history`)
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url: `${url}?traderUid=${encodeURIComponent(exchangeTraderId)}&page=${pageIndex}&pageSize=${limit}`,
          method: 'GET',
          headers: HEADERS,
        })
        const rows = parseBitunixHistory(payload, 'position_history', ctx)
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
    const url = endpoint(src, 'copiers', BITUNIX_COPIER_HISTORY_URL)
    const maxPages = copierMaxPages(src)
    let stableTotal: number | null = null
    let rowsSeen = 0
    const identities = new Set<string>()

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const request = bitunixCopierRequest(exchangeTraderId, pageIndex)
      const response = await replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: HEADERS,
        body: request,
      })
      const payload = {
        contract: BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT,
        exchangeTraderId,
        request,
        response,
      }
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }

      const page = validateBitunixCopierPage(payload, pageIndex, exchangeTraderId)
      if (page === null) {
        throw new Error('[bitunix] copiers returned a malformed exact page envelope')
      }
      if (stableTotal === null) stableTotal = page.total
      else if (page.total !== stableTotal) {
        throw new Error('[bitunix] copiers changed total during pagination')
      }
      for (const row of page.rows) {
        const identityKeys = bitunixCopierIdentityKeys(row)
        if (identityKeys === null || identityKeys.some((identity) => identities.has(identity))) {
          throw new Error('[bitunix] copiers returned a duplicate follower identity')
        }
        identityKeys.forEach((identity) => identities.add(identity))
      }
      rowsSeen += page.rows.length

      if (rowsSeen === stableTotal) {
        return {
          contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
          observations: [
            { segment_id: 'default', reason: 'reported_end', page_ordinal: pageIndex },
          ],
        }
      }
    }
    throw new Error(
      `[bitunix] copiers reached page cap ${maxPages} before reported total ${String(stableTotal)}`
    )
  },

  parseLeaderboard: parseBitunixLeaderboardPage,
  parseLeaderboardSeries: parseBitunixLeaderboardSeries,
  parseProfile: parseBitunixProfile,
  parsePositions: parseBitunixPositions,
  parseHistory: parseBitunixHistory,
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

registerAdapter(bitunixAdapter)

export { bitunixAdapter }
