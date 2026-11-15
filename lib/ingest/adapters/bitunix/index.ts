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
import { CopierPageCapReachedError } from '../../core/history-page-cap'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { apiFetcher, replayJson, type JsonFetcher } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import { extractCopierCandidateRecords } from '../../copier-candidate-conservation'
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

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

async function bitunixFetcher(session: FetchSession): Promise<JsonFetcher> {
  return apiFetcher(await session.api())
}

/** Upstream page meta: rows counted before parser validation; board population as reported. */
const bitunixLeaderboardMeta = collectionMeta({
  label: 'bitunix',
  assertSuccess: requireEnvelopeValue('bitunix', ['code'], [0]),
  list: ['data', 'records'],
  total: ['data', 'total'],
  pageCount: ['data', 'totalPage'],
})

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

  /** One crawl per TF — statisticType makes the server emit window-scoped
   *  headline fields (self-describing payloads, pure re-parse safe). */
  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    const fetcher = await bitunixFetcher(session)
    options?.signal?.throwIfAborted()
    const listUrl = endpoint(src, 'list', `${BASE}/trader/list`)
    const pageSize = src.page_size ?? 100
    const orderType = typeof src.meta.list_order_by === 'string' ? src.meta.list_order_by : 'PL'
    return captureReplayLeaderboard(
      { session, fetcher, src, label: 'bitunix', signal: options?.signal },
      {
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
        publicRequest: {
          body: ['statisticType', 'oderType', 'nickname', 'page', 'pageSize', 'version'],
        },
        pageBinding: { location: 'body', path: ['page'] },
        extractMeta: bitunixLeaderboardMeta,
        pageSize,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await bitunixAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
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
   * 跟單者: snapshot-style pagination via reported totalPage.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[bitunix] history surface ${kind} not supported`)
    }
    const fetcher = await bitunixFetcher(session)
    const ctx = dummyCtx(src)
    const limit = 20

    if (kind === 'position_history') {
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
    const url = endpoint(src, 'copiers', `${BASE}/trader/follow/list`)
    const maxPages = Number(src.meta.copier_max_pages) || 30
    let candidatesSeen = 0
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: HEADERS,
        body: { traderUid: Number(exchangeTraderId), page: pageIndex, pageSize: limit },
      })
      const candidateCount = extractCopierCandidateRecords({
        src,
        exchangeTraderId,
        pageIndex,
        payload,
      }).candidates.length
      candidatesSeen += candidateCount
      if (!Number.isSafeInteger(candidatesSeen)) {
        throw new Error('[bitunix] copier candidate count exceeds the safe-integer range')
      }
      const data = (payload as { data?: { total?: unknown; totalPage?: unknown } })?.data ?? {}
      const reportedTotal = nonNegativeSafeInteger(data.total)
      const totalPage = positiveSafeInteger(data.totalPage)
      if (reportedTotal !== null && candidatesSeen > reportedTotal) {
        throw new Error('[bitunix] copier candidates exceed the reported total')
      }

      const totalClaimsMore = reportedTotal !== null && candidatesSeen < reportedTotal
      const totalClaimsEnd = reportedTotal !== null && candidatesSeen === reportedTotal
      const pageClaimsMore = totalPage !== null && pageIndex < totalPage
      const pageClaimsEnd = totalPage !== null && pageIndex >= totalPage
      const metadataClaimsMore = totalClaimsMore || pageClaimsMore
      const metadataClaimsEnd = totalClaimsEnd || pageClaimsEnd
      if (candidateCount === 0) {
        if (metadataClaimsMore) {
          throw new Error('[bitunix] copier empty page still claims continuation')
        }
        return
      }
      if (metadataClaimsMore && metadataClaimsEnd) {
        throw new Error('[bitunix] copier pagination metadata is contradictory')
      }
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (metadataClaimsMore) continue
      if (metadataClaimsEnd) return
      if (candidateCount < limit) return
    }
    // Budget exhausted while the source still had pages: never let a cut
    // capture pass as a complete (unbounded) Tier-B copier snapshot.
    throw new CopierPageCapReachedError(src.slug, maxPages)
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
