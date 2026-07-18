/**
 * OKX CEX copy-trading adapter (spec §7 #9, §9 open item 2) — okx_futures
 * (instType=SWAP) + okx_spot (instType=SPOT), one adapter parameterized by
 * sources.meta.inst_type.
 *
 * PURE HTTP — no Playwright. The OFFICIAL documented public API answers
 * plain fetch() (verified live 2026-06-12 FROM THE SG VPS — the web UI
 * geo-hides copy trading in both US and SG, but the data API serves
 * globally; sources rows pin fetch_region='vps_sg' and the VPS worker
 * runs with INGEST_LOCAL_REGION=vps_sg so these fetches exit from SG):
 *
 *   GET www.okx.com/api/v5/copytrading/
 *     public-lead-traders?instType&sortType&page&limit=20&dataVer
 *         board, ~13 pages × 20; rank metrics are LAST-90-DAY figures
 *         (docs) → timeframes_native=[90], 7/30 are DERIVED boards from
 *         Tier-B profile stats (MEXC/BTCC pattern). dataVer from page 1
 *         is pinned across pages = consistent snapshot under pagination.
 *     public-stats?uniqueCode&lastDays            1/2/3 = 7/30/90 days
 *         (verified: profitDays+lossDays sum to exactly 7/30/90)
 *     public-pnl?uniqueCode&lastDays              daily cumulative pnl +
 *         pnlRatio series, newest-first, window start = 0
 *     public-preference-currency?uniqueCode       traded-coin ratios
 *     public-current-subpositions?uniqueCode      SWAP-only open positions
 *     public-subpositions-history?uniqueCode&after=subPosId
 *                                                 SWAP-only closed positions
 *     public-copy-traders?uniqueCode              SWAP-only aggregate + top-10
 *
 * IMPORTANT: those three record endpoints document only instType=SWAP.
 * Sending SPOT returns HTTP 400 / code 51000. Omitting instType is worse:
 * OKX defaults to SWAP, and many SPOT/SWAP boards share the same uniqueCode,
 * so the response can silently belong to the trader's futures surface.
 *
 * The web's internal priapi (/priapi/v5/ecotrade/public/follow-rank,
 * ~84 pages) has wider membership but is undocumented — noted in
 * sources.meta as a future expansion, NOT used.
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
import { assertSourceSurfaceSupported } from '../../core/surface-capabilities'
import {
  parseOkxHistory,
  parseOkxLeaderboardPage,
  parseOkxLeaderboardSeries,
  parseOkxPositions,
  parseOkxProfile,
} from './parsers'

const API_BASE = 'https://www.okx.com/api/v5/copytrading'
const PAGE_LIMIT = 20 // public-lead-traders hard max
const MAX_BOARD_PAGES = 60 // board is ~13 pages; hard safety cap
const DEFAULT_HISTORY_MAX_PAGES = 5

/** lastDays param: 1/2/3 = last 7/30/90 days (4=180d is not an Arena TF). */
const LAST_DAYS: Record<number, string> = { 7: '1', 30: '2', 90: '3', 0: '3' }

type Dict = Record<string, unknown>

function base(src: SourceRow): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints.base ?? API_BASE
}

type OkxInstType = 'SPOT' | 'SWAP'

/** SPOT | SWAP — explicit in meta, defaulted from product_type, fail-closed. */
function instType(src: SourceRow): OkxInstType {
  const configured = String(
    src.meta.inst_type ?? (src.product_type === 'spot' ? 'SPOT' : 'SWAP')
  ).toUpperCase()
  if (configured !== 'SPOT' && configured !== 'SWAP') {
    throw new Error(`[okx] invalid inst_type "${configured}" for source ${src.slug}`)
  }
  return configured
}

/** Public record surfaces are documented and live-verified as SWAP-only. */
function supportsSwapRecords(src: SourceRow): boolean {
  // Require both canonical dimensions. This prevents a bad SPOT source meta
  // override from routing a shared uniqueCode into the default SWAP surface.
  return src.product_type === 'futures' && instType(src) === 'SWAP'
}

/** Paced plain-HTTP GET; OKX envelopes everything as {code,data,msg}. */
async function fetchData(session: FetchSession, url: string): Promise<Dict[]> {
  return session.paced(async () => {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[okx] HTTP ${res.status} from ${url}`)
    const payload = (await res.json()) as { code?: unknown; data?: unknown; msg?: unknown }
    if (payload.code !== '0') {
      throw new Error(`[okx] API code ${String(payload.code)} (${String(payload.msg)}) from ${url}`)
    }
    return Array.isArray(payload.data) ? (payload.data as Dict[]) : []
  })
}

// ── Preference-currency, memoized per (session, trader) — TF-independent ──

const prefCache = new WeakMap<FetchSession, Map<string, Promise<Dict[]>>>()

function getPreference(session: FetchSession, src: SourceRow, code: string): Promise<Dict[]> {
  let perSession = prefCache.get(session)
  if (!perSession) {
    perSession = new Map()
    prefCache.set(session, perSession)
  }
  let cached = perSession.get(code)
  if (!cached) {
    cached = fetchData(
      session,
      `${base(src)}/public-preference-currency?instType=${instType(src)}&uniqueCode=${code}`
    )
    perSession.set(code, cached)
    cached.catch(() => perSession!.delete(code))
  }
  return cached
}

const okxAdapter: SourceAdapter = {
  slug: 'okx',
  capabilities: {
    profile: true, // public-stats + public-pnl + preference-currency
    positions: true, // public-current-subpositions (SWAP sources only)
    positionHistory: true, // public-subpositions-history (SWAP sources only)
    orders: false, // not exposed publicly
    transfers: false,
    copiers: true, // public-copy-traders (SWAP sources only)
  },

  supportsSurface(src, surface) {
    if (surface === 'positions' || surface === 'positionHistory' || surface === 'copiers') {
      return supportsSwapRecords(src)
    }
    return true
  },

  /**
   * 90d native board only (7/30 are derived downstream). Pages 1..totalPage
   * with page 1's dataVer pinned; rows dedupe by uniqueCode then re-chunk
   * into exact page_size chunks so Tier-A rank re-anchoring stays gap-free
   * (binance-web3 pattern).
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    if (timeframe !== 90) {
      throw new Error(`[okx] ${timeframe}d board is derived, not natively listed`)
    }
    const sortType = String(src.meta.sort_type ?? 'overview')
    const pageSize = src.page_size ?? PAGE_LIMIT
    const maxPagesKnob = Number(src.meta.max_pages) || null

    const seen = new Set<string>()
    const rows: Dict[] = []
    let dataVer: string | null = null
    let totalPage: number | null = null
    let lastUrl = ''
    for (let page = 1; page <= Math.min(maxPagesKnob ?? totalPage ?? 1, MAX_BOARD_PAGES); page++) {
      const url =
        `${base(src)}/public-lead-traders?instType=${instType(src)}` +
        `&sortType=${sortType}&limit=${PAGE_LIMIT}&page=${page}` +
        (dataVer ? `&dataVer=${dataVer}` : '')
      lastUrl = url
      const data = await fetchData(session, url)
      const block = (data[0] ?? {}) as { dataVer?: unknown; totalPage?: unknown; ranks?: unknown }
      if (dataVer === null && typeof block.dataVer === 'string') dataVer = block.dataVer
      if (totalPage === null) {
        const reported = Number(block.totalPage)
        totalPage = Number.isFinite(reported) && reported > 0 ? reported : 1
      }
      const ranks = Array.isArray(block.ranks) ? (block.ranks as Dict[]) : []
      if (ranks.length === 0) break
      for (const row of ranks) {
        const code = String(row.uniqueCode ?? '')
        if (!code || seen.has(code)) continue
        seen.add(code)
        rows.push(row)
      }
    }

    const fetchedAt = new Date().toISOString()
    for (let i = 0; i < rows.length; i += pageSize) {
      yield {
        pageIndex: Math.floor(i / pageSize) + 1,
        payload: {
          timeframe,
          dataVer,
          board: { ranks: rows.slice(i, i + pageSize) },
        },
        url: lastUrl,
        fetchedAt,
      }
    }
  },

  /**
   * Profile bundle per TF: stats + daily pnl/roi series (lastDays-mapped)
   * + preference-currency (memoized — TF-independent, 3 TFs cost one).
   * The composite payload embeds the timeframe so parseProfile stays pure.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const lastDays = LAST_DAYS[timeframe] ?? '3'
    const it = instType(src)
    const statsUrl = `${base(src)}/public-stats?instType=${it}&uniqueCode=${exchangeTraderId}&lastDays=${lastDays}`
    const stats = await fetchData(session, statsUrl)
    const pnl = await fetchData(
      session,
      `${base(src)}/public-pnl?instType=${it}&uniqueCode=${exchangeTraderId}&lastDays=${lastDays}`
    )
    const preference = await getPreference(session, src, exchangeTraderId).catch(() => [])

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            timeframe: timeframe === 0 ? 90 : timeframe,
            stats: { data: stats },
            pnl: { data: pnl },
            preference: { data: preference },
          },
          url: statsUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Tier D: open lead positions, fresh each call. */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    assertSourceSurfaceSupported(okxAdapter, src, 'positions')
    // NOTE: public-current-subpositions rejects a `limit` param with HTTP 400
    // (verified 2026-07-03 — the &limit=500 here silently 0'd every okx open
    // position). It returns the full current set unpaginated; no limit needed.
    const url =
      `${base(src)}/public-current-subpositions?instType=${instType(src)}` +
      `&uniqueCode=${exchangeTraderId}`
    const data = await fetchData(session, url)
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload: { data }, url, fetchedAt }], fetchedAt }
  },

  /**
   * position_history: newest→oldest via after=subPosId; stops on cursor
   * overlap (oldest openTime ≤ stored ISO cursor), exhaustion, or the
   * meta.history_max_pages cap. copiers: one aggregate+top-10 response.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    const it = instType(src)
    if (kind === 'copiers') {
      assertSourceSurfaceSupported(okxAdapter, src, 'copiers')
      const url = `${base(src)}/public-copy-traders?instType=${it}&uniqueCode=${exchangeTraderId}`
      const data = await fetchData(session, url)
      yield { pageIndex: 1, payload: { data }, url, fetchedAt: new Date().toISOString() }
      return
    }
    if (kind !== 'position_history') {
      throw new Error(`[okx] history surface ${kind} not supported`)
    }
    assertSourceSurfaceSupported(okxAdapter, src, 'positionHistory')

    const maxPages =
      Number(src.meta.history_max_pages ?? DEFAULT_HISTORY_MAX_PAGES) || DEFAULT_HISTORY_MAX_PAGES
    const cursorMs = cursor ? Date.parse(cursor) : NaN
    let after: string | null = null
    for (let page = 1; page <= maxPages; page++) {
      const url =
        `${base(src)}/public-subpositions-history?instType=${it}` +
        `&uniqueCode=${exchangeTraderId}&limit=100` +
        (after ? `&after=${after}` : '')
      const data = await fetchData(session, url)
      if (data.length === 0) break

      yield { pageIndex: page, payload: { data }, url, fetchedAt: new Date().toISOString() }

      const last = data[data.length - 1]
      const lastId = String(last.subPosId ?? '')
      if (!lastId) break
      if (Number.isFinite(cursorMs)) {
        const oldest = Number(last.openTime)
        // Overlap reached: this page already dips into stored history.
        if (Number.isFinite(oldest) && oldest <= cursorMs) break
      }
      after = lastId
    }
  },

  parseLeaderboard: parseOkxLeaderboardPage,
  parseLeaderboardSeries: parseOkxLeaderboardSeries,
  parseProfile: parseOkxProfile,
  parsePositions: parseOkxPositions,
  parseHistory: parseOkxHistory,
}

registerAdapter(okxAdapter)

export { okxAdapter }
