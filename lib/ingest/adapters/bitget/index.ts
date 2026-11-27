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
  ParsedLeaderboardRow,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson } from '../../fetch/capture'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
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

const BASE = 'https://www.bitget.com/v1/trigger/trace/public'
const TRACE_BASE = 'https://www.bitget.com/v1/trigger/trace'
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

/**
 * UTA board page meta (public probe 2026-11-15, all three boards × 7/30/90):
 * success envelope is the string code "200"; `data.rows` is the board page;
 * `data.totals` is only this page's row count; `data.maxShowSizes` is the
 * board population. Spot and CFD boards page out to exactly maxShowSizes
 * distinct traders (cfd 30D 208 = 6×30+28, cfd 7D 204, spot 30D/7D 5416 =
 * 180×30+16) and then serve an empty page. The futures board reports 9473 for
 * every window while its flagged tail ends between pages 314 and 316 with
 * replica-dependent rows, so its captures stop short of the reported total
 * and stay non-complete (fail closed) rather than being certified by nextFlag.
 */
const bitgetLeaderboardMeta = collectionMeta({
  label: 'bitget',
  assertSuccess: requireEnvelopeValue('bitget', ['code'], ['200']),
  list: ['data', 'rows'],
  total: ['data', 'maxShowSizes'],
})

/**
 * Exhausted-completeness contract for bitget_spot (registered in
 * arena.leaderboard_exhaustion_contracts). The board is ~5,400 traders in 181
 * pages of 30, about eight minutes per window at the paced budget, and its
 * ranks move while it is paged: a trader crossing the cursor is read twice and
 * another slides past unread, so the total mode (accepted rows = maxShowSizes,
 * no duplicate) refused every capture (production 2026-11: 5,414 reported,
 * 5,410-5,412 distinct, 2-4 duplicates). Public probe 2026-11-24, eight full
 * reads over 7/30/90 days at the paced interval: every read ends on a real
 * short page (181, 15 rows) followed by an empty page; the reported total
 * moved by 0-1; 1-6 rows were read twice and as many were missing.
 *
 * The capture therefore reads to the short (or empty) final page, and the
 * proof bounds how far the board moved: the totals the pages report, the
 * distinct rows against the last total and the duplicate rows each stay
 * within 0.35% of the last reported total (18 rows at 5,415, three times the
 * largest measured drift), and never above 20 rows.
 *
 * The allowance is also the most rows a capture judged complete may be
 * missing, so it is a few times the measured drift, not the 1% ceiling.
 *
 * bitget_cfd has its own contract (BITGET_CFD_LEADERBOARD_EXHAUSTION).
 * bitget_futures has no completeness proof (see bitgetLeaderboardMeta).
 */
export const BITGET_SPOT_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['data', 'rows'],
  row_key_path: ['traderUid'],
  end_signal: { kind: 'short_page' as const },
  board_version: {
    kind: 'reported_total_drift' as const,
    path: ['data', 'maxShowSizes'],
    max_drift_bps: 35,
  },
  max_duplicate_rows: 20,
})

/**
 * Exhausted-completeness contract for bitget_cfd (registered in
 * arena.leaderboard_exhaustion_contracts): one ranked row per trader.
 *
 * Each board row is one portfolio. A trader may lead several (a type 1
 * copy-trading portfolio and a type 2 UTA portfolio), so the same traderUid
 * appears on more than one row. Public probe 2026-11-27, four full reads of
 * 7/30/90 days at the paced interval: 191 / 220 / 224 rows, as many distinct
 * portfolioIds as the board reports, and 188 / 218 / 222 distinct traders
 * (3 / 2 / 2 traders with two portfolios), identical on every read; every
 * read ended on a short page followed by an empty one. The total mode
 * (accepted traders = maxShowSizes) therefore refused every capture.
 *
 * The proof counts portfolios: each read exactly once (no duplicate is
 * tolerated) and exactly as many as the last reported total. The reported
 * total may move by 0.6% between pages (max_drift_bps 60: one row at 167-333
 * portfolios, so 7D 191, 30D 220 and 90D 224 each tolerate a move by 1 and
 * none tolerates 2; 50 bps would floor 7D's 191 to 0): in 12 window reads of
 * the probe it moved once, between 224 and 225 during a 90D read. The ranking then keeps, per
 * traderUid, the portfolio with the best rank (the staging dedupe keeps the
 * lower rank) and records the merge on that row (bitgetIdentityMergeExtras).
 * The kept row is one real portfolio's figures, not the trader's combined
 * performance.
 */
export const BITGET_CFD_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['data', 'rows'],
  row_key_path: ['portfolioId'],
  end_signal: { kind: 'short_page' as const },
  board_version: {
    kind: 'reported_total_drift' as const,
    path: ['data', 'maxShowSizes'],
    max_drift_bps: 60,
  },
  max_duplicate_rows: 0,
  identity_merge: { kind: 'best_rank' as const, identity_path: ['traderUid'] },
})

function exhaustionFor(src: SourceRow): LeaderboardExhaustionDeclaration | undefined {
  if (src.slug === 'bitget_spot') return BITGET_SPOT_LEADERBOARD_EXHAUSTION
  if (src.slug === 'bitget_cfd') return BITGET_CFD_LEADERBOARD_EXHAUSTION
  return undefined
}

/**
 * bitget_cfd ranks one row per trader: the kept (best-ranked) portfolio
 * records which portfolio it is and how many other portfolios of the same
 * trader were merged into it. Written on every kept row (0 for a trader with
 * one portfolio) so a later board never leaves a stale count behind.
 */
export function bitgetIdentityMergeExtras(
  kept: ParsedLeaderboardRow,
  merged: readonly ParsedLeaderboardRow[]
): ParsedLeaderboardRow {
  const meta = kept.traderMeta ?? {}
  return {
    ...kept,
    headlineExtras: {
      ...(kept.headlineExtras ?? {}),
      ranked_portfolio_id: typeof meta.portfolio_id === 'string' ? meta.portfolio_id : null,
      ranked_portfolio_type:
        typeof meta.bitget_trader_type === 'number' ? meta.bitget_trader_type : null,
      merged_portfolio_count: merged.length,
    },
  }
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
    copiers: true, // POST trace/trader/followerList (top-50 only, PII rules apply)
  },

  historyTerminalVerifier(src, kind) {
    return src.slug === 'bitget_futures' &&
      src.product_type === 'futures' &&
      kind === 'position_history' &&
      endpoint(src, 'positionHistory', BITGET_POSITION_HISTORY_URL) === BITGET_POSITION_HISTORY_URL
      ? bitgetPositionHistoryTerminalVerifier
      : null
  },

  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    await warmSession(session, src)
    options?.signal?.throwIfAborted()
    // The UTA API 403s external requests (signed tm/dy-token headers) but
    // accepts same-origin in-page fetches without them — so replay runs
    // through pageFetcher. Rapid unsigned requests get silently served
    // EMPTY rows, which the paced gate's 2.5s budget avoids; an empty page
    // before the reported population ends the capture non-complete.
    const fetcher = pageFetcher(session)
    const boardKey = (src.meta.boardKey as string) ?? 'futures'
    const listUrl = endpoint(src, 'list', UTA_LIST_ENDPOINTS[boardKey])
    const pageSize = src.page_size ?? 30
    return captureReplayLeaderboard(
      { session, fetcher, src, label: 'bitget', signal: options?.signal },
      {
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
        publicRequest: {
          body: [
            'pageNo',
            'pageSize',
            'sortRule',
            'sortFlag',
            'dataCycle',
            'fullStatus',
            'languageType',
          ],
        },
        pageBinding: { location: 'body', path: ['pageNo'] },
        extractMeta: bitgetLeaderboardMeta,
        pageSize,
        // Only the registered sources: bitget_futures keeps the total mode.
        exhaustion: exhaustionFor(src),
      }
    )
  },

  leaderboardIdentityMerge(src) {
    return src.slug === 'bitget_cfd' ? bitgetIdentityMergeExtras : null
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await bitgetAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
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

    // Futures family only. Public probe 2026-11-17: spot and CFD board traders
    // (type 1, with a portfolioId) get detailV2 code 30081 ("not a futures
    // expert") and a cycleData success envelope whose statisticsDTO is null,
    // and uta/performance answers zeros without maxDrawDown for their
    // portfolioId. Neither board row carries a drawdown, so bitget_spot and
    // bitget_cfd have no profile capture contract until their own public
    // profile endpoints are identified.
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
   *   copiers: POST trace/trader/followerList — small (top-50), always full.
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
        : endpoint(src, 'copiers', `${TRACE_BASE}/trader/followerList`)
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

registerAdapter(bitgetAdapter)

export { bitgetAdapter }
