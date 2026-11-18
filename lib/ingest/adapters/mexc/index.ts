/**
 * MEXC Futures copy-trading adapter ("MEXC AI 大模型跟单交易竞技",
 * spec §7 #10 / §11.6). REAL URL confirmed 2026-06-11 (spec §9.1):
 *   https://www.mexc.com/{locale}/futures/copyTrade/home
 * (the survey note's futures.mexc.com/.../copy-trading is an Akamai-blocked
 * dead end, NOT the product page — www.mexc.com is open to headless.)
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source
 * via src.meta.endpoints), base /api/platform/futures/copyFutures/api/v1:
 *   list:      GET traders/v2?condition=[]&limit≤100&orderBy=COMPREHENSIVE&page=N
 *   aiRoster:  GET traders/ai                       (AI 交易员 tab roster)
 *   aiDetail:  GET traders/aiDetail?interval=...&uids=a,b,c
 *              (neither is crawled any more: the AI tab reports no
 *              population, so it cannot join the attempt-bound board)
 *   profile:   GET trader?intervalType=...&uid=     (带单表现 stats block)
 *              GET trader/statAccumulate?dataType=ACCUMULATE_PNL_ROI|DAY_PNL
 *              GET trader/abilityRating / trader/holdStats / trader/contract/stat
 *   positions: GET trader/orders/v2?orderListType=ORDER (当前带单)
 *   history:   GET trader/ordersHis/v2 (历史带单, 90d public retention)
 *   copiers:   GET trader/followers/v2 (跟随者; PII stored, never rendered)
 *
 * Native board is 7d ONLY — the 30/90 boards are SYNTHESIZED from the
 * profile stats this adapter crawls (derive-boards processor, spec §1.1-C).
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
import { COPIER_PAGE_CEILING, CopierPageCapReachedError } from '../../core/history-page-cap'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import { extractCopierCandidateRecords } from '../../copier-candidate-conservation'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import {
  parseMexcHistory,
  parseMexcLeaderboardPage,
  parseMexcPositions,
  parseMexcProfile,
} from './parsers'
import { fetchPositionPages } from '../../core/position-snapshot'

const BASE = 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1'

const TF_INTERVAL: Record<RankingTimeframe, string> = {
  7: 'SEVEN_DAYS',
  30: 'THIRTY_DAYS',
  90: 'NINETY_DAYS',
}

const HEADERS = { accept: 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/**
 * One page load establishes cookies/fingerprint; everything after is pure
 * same-origin JSON replay (spec §2.2). www.mexc.com accepts the bundled
 * Chromium headless (verified 2026-06-11) — no browser_channel knob needed.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.mexc.com/zh-CN/futures/copyTrade/home'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** Upstream page meta: rows counted before parser validation; board population as reported. */
const mexcEnvelopeCode = requireEnvelopeValue('mexc', ['code'], [0])
const mexcEnvelopeSuccess = requireEnvelopeValue('mexc', ['success'], [true])
const mexcLeaderboardMeta = collectionMeta({
  label: 'mexc',
  assertSuccess: (payload) => {
    mexcEnvelopeCode(payload)
    mexcEnvelopeSuccess(payload)
  },
  list: ['data', 'content'],
  total: ['data', 'total'],
})

/** traders/v2 rejects any limit above 100 with code 600 ("invalid limit"). */
const MAX_PAGE_SIZE = 100

/**
 * Exhausted-completeness contract for mexc_futures (registered in
 * arena.leaderboard_exhaustion_contracts). The board is live (~7,100 traders,
 * 71 pages at the 100-row upstream limit) and re-sorts while it is paged:
 * four live crawls on 2026-11-18 (16 s to 3 min) each served 1-6 traders on
 * two pages, so the reported total was never reached by distinct rows, and
 * parallel page requests are refused (code 510). The capture therefore reads
 * to the empty page past the end and the proof bounds how far the board
 * moved: page totals, |last total - distinct rows| and duplicate rows each
 * within min(⌊last × 50 / 10000⌋, 40) rows (35 rows at 7,100).
 *
 * The allowance is the most rows a complete capture may be missing, and the
 * registered row is immutable, so it is sized from the observed movement
 * (at most 6 repeated traders per crawl) with headroom, not set to the 1%
 * ceiling: 0.5% of the last total, and never more than 40 rows.
 */
export const MEXC_FUTURES_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['data', 'content'],
  row_key_path: ['uid'],
  end_signal: { kind: 'short_page' as const },
  board_version: {
    kind: 'reported_total_drift' as const,
    path: ['data', 'total'],
    max_drift_bps: 50,
  },
  max_duplicate_rows: 40,
})

const mexcAdapter: SourceAdapter = {
  slug: 'mexc',
  capabilities: {
    profile: true,
    positions: true, // GET trader/orders/v2 (当前带单)
    positionHistory: true, // GET trader/ordersHis/v2 (90d public retention)
    orders: false, // no public sub-order surface
    transfers: false, // no public balance-history surface
    copiers: true, // GET trader/followers/v2
  },

  /**
   * 全部交易员 board (native 7d only; the request carries no window). One
   * attempt-bound crawl of GET traders/v2 to the short or empty final page,
   * proven complete by MEXC_FUTURES_LEADERBOARD_EXHAUSTION (data.total is
   * drift evidence, not a population claim); every exact response is RAW.
   *
   * The AI 交易员 tab (traders/aiDetail) is a separate competition roster
   * from another endpoint that data.total does not count, so it is not part
   * of the Tier-A population snapshot. Rows flagged traderType='AI' on the main
   * board are still marked bot/ai by the parser.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    if (timeframe !== 7) {
      throw new Error(`[mexc] ${timeframe}d board is derived, not natively listed`)
    }
    const pageSize = src.page_size ?? MAX_PAGE_SIZE
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new TypeError(
        `[mexc] source page_size must be 1..${MAX_PAGE_SIZE} (the upstream limit)`
      )
    }
    options?.signal?.throwIfAborted()
    await warmSession(session, src)
    options?.signal?.throwIfAborted()
    const listUrl = endpoint(src, 'list', `${BASE}/traders/v2`)
    const orderBy =
      typeof src.meta.list_order_by === 'string' ? src.meta.list_order_by : 'COMPREHENSIVE'
    return captureReplayLeaderboard(
      { session, fetcher: pageFetcher(session), src, label: 'mexc', signal: options?.signal },
      {
        buildRequest: (pageIndex) => ({
          url:
            `${listUrl}?condition=%5B%5D&limit=${pageSize}` +
            `&orderBy=${encodeURIComponent(orderBy)}&page=${pageIndex}`,
          method: 'GET',
          headers: HEADERS,
        }),
        publicRequest: { query: ['condition', 'limit', 'orderBy', 'page'] },
        pageBinding: { location: 'query', key: 'page' },
        extractMeta: mexcLeaderboardMeta,
        exhaustion: MEXC_FUTURES_LEADERBOARD_EXHAUSTION,
        pageSize,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await mexcAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  /**
   * Profile bundle per TF (6 replayed requests): stats block + 累计收益
   * dual chart + daily bars + 能力分析 radar + 持仓时长 + 合约偏好. These
   * profile stats are the SUBSTRATE of the derived 30/90 boards.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const interval = TF_INTERVAL[tf]
    const uid = encodeURIComponent(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })

    const traderUrl = endpoint(src, 'profile', `${BASE}/trader`)
    const accumUrl = endpoint(src, 'statAccumulate', `${BASE}/trader/statAccumulate`)
    const abilityUrl = endpoint(src, 'abilityRating', `${BASE}/trader/abilityRating`)
    const holdUrl = endpoint(src, 'holdStats', `${BASE}/trader/holdStats`)
    const contractUrl = endpoint(src, 'contractStat', `${BASE}/trader/contract/stat`)

    const trader = await get(`${traderUrl}?intervalType=${interval}&uid=${uid}`)
    const accumulate = await get(
      `${accumUrl}?dataType=ACCUMULATE_PNL_ROI&statsIntervalType=${interval}&uid=${uid}`
    )
    const dayPnl = await get(
      `${accumUrl}?dataType=DAY_PNL&statsIntervalType=${interval}&uid=${uid}`
    )
    const ability = await get(`${abilityUrl}?intervalType=${interval}&uid=${uid}`)
    // 持仓时长: 按订单 (ORDER) AND 按仓位 (POSITION) — the user asked for both
    // toggles (逐图核对). Same endpoint, dataType param varies.
    const hold = await get(`${holdUrl}?dataType=ORDER&interval=${interval}&uid=${uid}`)
    const holdByPosition = await get(
      `${holdUrl}?dataType=POSITION&interval=${interval}&uid=${uid}`
    ).catch(() => null)
    const contractStat = await get(`${contractUrl}?statsIntervalType=${interval}&uid=${uid}`)

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            trader,
            accumulate,
            dayPnl,
            ability,
            hold,
            holdByPosition,
            contractStat,
            timeframe: tf,
          },
          url: traderUrl,
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
    const url = endpoint(src, 'positions', `${BASE}/trader/orders/v2`)
    const fetcher = pageFetcher(session)
    const fetchedAt = new Date().toISOString()
    // 20 = the site's own page size. data.totalPage is not reliable here
    // (orders-p1.json: totalPage 0 with one row), so page until a short page.
    const pages = await fetchPositionPages({
      source: 'mexc',
      pageSize: 20,
      maxPages: Number(src.meta.positions_max_pages ?? 20) || 20,
      fetchPage: async (pageNo) => ({
        url,
        payload: await replayJson(session, fetcher, {
          url: `${url}?limit=20&orderListType=ORDER&page=${pageNo}&uid=${encodeURIComponent(exchangeTraderId)}`,
          method: 'GET',
          headers: HEADERS,
        }),
      }),
      rowsOf: (payload) => {
        const content = (
          (payload as Record<string, unknown> | null)?.data as
            | Record<string, unknown>
            | null
            | undefined
        )?.content
        return Array.isArray(content) ? content.length : 0
      },
    })
    return { pages, fetchedAt }
  },

  /**
   * 历史带单: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest closeTime ≤ cursor — the processor's dedupe
   * upserts make the overlap page idempotent), or at the safety cap.
   * 跟随者: snapshot-style full pagination via reported totalPage.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[mexc] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const ctx = dummyCtx(src)

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory', `${BASE}/trader/ordersHis/v2`)
      const limit = 20
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url: `${url}?limit=${limit}&page=${pageIndex}&uid=${encodeURIComponent(exchangeTraderId)}`,
          method: 'GET',
          headers: HEADERS,
        })
        const rows = parseMexcHistory(payload, 'position_history', ctx)
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
    const url = endpoint(src, 'copiers', `${BASE}/trader/followers/v2`)
    const limit = 10 // verified server page size; larger limits unverified
    const maxPages = Number(src.meta.copier_max_pages) || 30
    // The source reports totalPage: extend the budget to cover it (bounded).
    let pageBudget = maxPages
    for (let pageIndex = 1; pageIndex <= pageBudget; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?limit=${limit}&page=${pageIndex}&uid=${encodeURIComponent(exchangeTraderId)}`,
        method: 'GET',
        headers: HEADERS,
      })
      const candidateCount = extractCopierCandidateRecords({
        src,
        exchangeTraderId,
        pageIndex,
        payload,
      }).candidates.length
      const totalPage = Number((payload as { data?: { totalPage?: unknown } })?.data?.totalPage)
      if (candidateCount === 0) {
        if (Number.isSafeInteger(totalPage) && totalPage > pageIndex) {
          throw new Error('[mexc] empty copier page still claims continuation')
        }
        return
      }
      if (Number.isSafeInteger(totalPage) && totalPage > pageBudget) {
        pageBudget = Math.min(totalPage, Math.max(maxPages, COPIER_PAGE_CEILING))
      }
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (Number.isSafeInteger(totalPage) && totalPage > 0) {
        if (pageIndex >= totalPage) return
        continue
      }
      if (candidateCount < limit) return
    }
    // Budget exhausted while the source still had pages: never let a cut
    // capture pass as a complete (unbounded) Tier-B copier snapshot.
    throw new CopierPageCapReachedError(src.slug, pageBudget)
  },

  parseLeaderboard: parseMexcLeaderboardPage,
  parseProfile: parseMexcProfile,
  parsePositions: parseMexcPositions,
  parseHistory: parseMexcHistory,
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

registerAdapter(mexcAdapter)

export { mexcAdapter }
