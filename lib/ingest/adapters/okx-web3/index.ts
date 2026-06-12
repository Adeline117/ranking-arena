/**
 * OKX Wallet web3 (Solana) on-chain adapter (spec §7 #29, §11.18).
 *
 * PURE HTTP — no Playwright. web3.okx.com priapi answers plain fetch()
 * with browser-ish headers (verified live 2026-06-12 from the Mac Mini;
 * unlike okx.com CEX, the web3 domain is not geo-blocked here):
 *   board:   GET /priapi/v1/dx/market/v2/smartmoney/ranking/content
 *              ?rankStart&rankEnd&periodType&rankBy=1&label=all&desc=true
 *              &chainId=501  (rankEnd−rankStart caps at 20)
 *   profile: GET /priapi/v1/dx/market/v2/pnl/wallet-profile/summary
 *              ?periodType&chainId=501&walletAddress=...
 *
 * Native TF labels 1D/3D/7D/1M/3M = periodType 1..5 (totals grow with the
 * window — verified) → we crawl 3/4/5 for canonical 7/30/90 and ignore
 * 1D/3D per the seeded tf_label_map. "Updated Xs ago" on site = the
 * near-realtime endpoint (meta.near_realtime).
 *
 * Wallet category chips (Sniper/DEV/Fresh/Pump Smart Money/Influencers)
 * arrive as row.labels → traderMeta.okx_web3_labels (label=all keeps every
 * category on the board). Identity = base58 walletAddress, CASE-SENSITIVE.
 *
 * Portfolio/History tabs (spec §11.18) ride different priapi families —
 * out of v1; profile summary covers stats + the PnL calendar series.
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
  parseOkxWeb3History,
  parseOkxWeb3LeaderboardPage,
  parseOkxWeb3Positions,
  parseOkxWeb3Profile,
} from './parsers'

const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2'
const PAGE_SIZE = 20 // rankEnd−rankStart server cap (verified: 100 → 20)
/** Canonical TF → periodType (1D/3D ignored by design, spec §11.18). */
const PERIOD_TYPE: Record<RankingTimeframe, string> = { 7: '3', 30: '4', 90: '5' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function chainId(src: SourceRow): string {
  return String(src.meta.chain_id ?? '501')
}

/** Paced plain-HTTP GET; 401/403/429 feed the gate's backoff. */
async function fetchJson(session: FetchSession, url: string): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        referer: 'https://web3.okx.com/copy-trade/leaderboard/solana',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[okx_web3] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

interface RankingData {
  rankingInfos?: unknown[]
  totalCount?: number
}

/** priapi envelope: { code: 0, data } — non-zero codes are upstream errors
 *  (anti-bot answers code≠0 with 200, must not publish as empty). */
function unwrap(payload: unknown, url: string): RankingData {
  const root = (payload ?? {}) as { code?: unknown; data?: unknown }
  if (root.code !== 0) {
    throw new Error(`[okx_web3] API code ${String(root.code)} from ${url}`)
  }
  return (root.data ?? {}) as RankingData
}

const okxWeb3Adapter: SourceAdapter = {
  slug: 'okx_web3',
  capabilities: {
    profile: true, // wallet-profile/summary per periodType
    positions: false, // Portfolio tab family — out of v1
    positionHistory: false,
    orders: false, // History tab family — out of v1
    transfers: false,
    copiers: false, // wallet leaderboard — no copy stats exposed
  },

  /** rankStart/rankEnd windows of 20 until totalCount is covered (~3.8k/
   *  5.5k/6.8k per TF at survey time → expected_count NULL, rolling
   *  baseline governs). meta.max_pages caps smoke runs. */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const base = endpoint(src, 'list', `${BASE}/smartmoney/ranking/content`)
    const periodType = PERIOD_TYPE[timeframe]
    const pageSize = src.page_size ?? PAGE_SIZE
    const maxPages = Number(src.meta.max_pages) || null

    let totalCount: number | null = null
    for (let pageIndex = 1; maxPages === null || pageIndex <= maxPages; pageIndex++) {
      const rankStart = (pageIndex - 1) * pageSize
      if (totalCount !== null && rankStart >= totalCount) break
      const url =
        `${base}?rankStart=${rankStart}&rankEnd=${rankStart + pageSize}` +
        `&periodType=${periodType}&rankBy=1&label=all&desc=true&chainId=${chainId(src)}`
      const data = unwrap(await fetchJson(session, url), url)
      if (typeof data.totalCount === 'number' && totalCount === null) {
        totalCount = data.totalCount
      }
      const rows = Array.isArray(data.rankingInfos) ? data.rankingInfos : []
      if (rows.length === 0) break

      yield {
        pageIndex,
        payload: { data, timeframe },
        url,
        fetchedAt: new Date().toISOString(),
      }

      if (rows.length < pageSize) break // natural end
    }
  },

  /** One summary GET per (trader, TF) — the §2.4 "small number of replayed
   *  requests" contract; near-realtime upstream so no session cache. */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const url =
      `${endpoint(src, 'profile', `${BASE}/pnl/wallet-profile/summary`)}` +
      `?periodType=${PERIOD_TYPE[tf]}&chainId=${chainId(src)}` +
      `&walletAddress=${encodeURIComponent(exchangeTraderId)}`
    const summary = await fetchJson(session, url)
    // surface upstream error codes before storing RAW
    unwrap(summary, url)

    const fetchedAt = new Date().toISOString()
    return {
      pages: [{ pageIndex: 1, payload: { summary, timeframe: tf }, url, fetchedAt }],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[okx_web3] positions surface not supported')
  },

  async *getHistory(
    _session: FetchSession,
    _src: SourceRow,
    _exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    throw new Error(`[okx_web3] history surface ${kind} not supported`)
  },

  parseLeaderboard: parseOkxWeb3LeaderboardPage,
  parseProfile: parseOkxWeb3Profile,
  parsePositions: parseOkxWeb3Positions,
  parseHistory: parseOkxWeb3History,
}

registerAdapter(okxWeb3Adapter)

export { okxWeb3Adapter }
