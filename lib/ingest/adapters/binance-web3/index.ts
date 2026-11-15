/**
 * Binance Wallet web3 on-chain adapter (spec §7 #11, §11.7).
 *
 * PURE HTTP — no Playwright. The leaderboard API is public and answers
 * plain fetch() with origin/referer/UA headers (verified live 2026-06-12
 * from the Mac Mini; the legacy connector knew this endpoint too):
 *   GET web3.binance.com/bapi/defi/v1/public/wallet-direct/market/
 *       leaderboard/query?chainId=56&period={7d|30d|90d}&tag={ALL|KOL}
 *       &pageNo&pageSize=25
 *
 * The site's Hot/All/KOL toggle maps to the tag param (Hot = MPC, the
 * Keyless-Wallet-only default that truncates — spec's "click All" is
 * tag=ALL, no clicking needed). KOL membership is the row's own `tags`
 * ("KOL") → traderMeta.binance_web3_kol.
 *
 * TIER-A-ONLY SOURCE: profile tabs (§11.7 active positions / realized PnL
 * / tx history) sit behind Binance's bot-shield — the wallet-direct
 * address page answers HTTP 202 challenge and the board UI exposes no
 * public profile XHR (3 capture approaches exhausted 2026-06-12). Board
 * rows already carry per-TF stats + 7-point daily-PnL series + PnL-bucket
 * distribution, so first screens render from entries; arena.sources keeps
 * deep_profile_topn=0 / positions_topn=0.
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type { HistoryKind, RankingTimeframe, RawBundle, RawPage, SourceRow } from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import type { JsonFetcher, NumericLeaderboardPageMeta } from '../../fetch/capture'
import { captureReplayLeaderboard } from '../../fetch/replay-capture'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import {
  parseBinanceWeb3History,
  parseBinanceWeb3LeaderboardPage,
  parseBinanceWeb3LeaderboardSeries,
  parseBinanceWeb3Positions,
  parseBinanceWeb3Profile,
} from './parsers'

const LIST_URL =
  'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query'
const PAGE_SIZE = 25 // API max
const PERIOD: Record<RankingTimeframe, string> = { 7: '7d', 30: '30d', 90: '90d' }
const MAX_BOARD_PAGES = 60 // 90d board is ~20 pages; hard safety cap
const HEADERS = {
  accept: 'application/json',
  origin: 'https://web3.binance.com',
  referer: 'https://web3.binance.com/en/leaderboard',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

/**
 * Exhausted-completeness contract for binance_web3_bsc (registered in
 * arena.leaderboard_exhaustion_contracts). The board reports a page count,
 * never a row total, and filters rows after pagination (short pages mid-board),
 * so it ends at the reported page count, not at a short page. It carries no
 * snapshot token: page one is re-read after the last page.
 */
export const BINANCE_WEB3_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['data', 'data'],
  row_key_path: ['address'],
  end_signal: { kind: 'page_count' as const, path: ['data', 'pages'] },
  board_version: { kind: 'first_page_reread' as const },
  max_duplicate_rows: 0,
})

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function chainId(src: SourceRow): string {
  return String(src.meta.chain_id ?? '56')
}

/** Capture fetcher: no pacing or status throw (the capture records both). */
const fetchBoardJson: JsonFetcher = async (template) => {
  const response = await fetch(template.url, { headers: template.headers })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // A non-JSON answer stays null; page validation records it as an upstream error.
  }
  return { status: response.status, json }
}

/**
 * Upstream page meta. A geo-blocked request answers 200 with an empty body,
 * which fails here as an upstream error instead of reading as an empty board.
 */
function binanceWeb3LeaderboardMeta(
  payload: unknown,
  requestPageIndex: number,
  pageSize: number
): NumericLeaderboardPageMeta {
  const root = (payload ?? {}) as { code?: unknown; data?: unknown }
  if (root.code !== '000000') {
    throw new TypeError(`[binance_web3] leaderboard response code ${JSON.stringify(root.code)}`)
  }
  const data = (root.data ?? {}) as {
    data?: unknown
    pages?: unknown
    size?: unknown
    current?: unknown
  }
  if (!Array.isArray(data.data)) {
    throw new TypeError('[binance_web3] leaderboard response must contain data.data')
  }
  if (data.current !== requestPageIndex || data.size !== pageSize) {
    throw new TypeError('[binance_web3] leaderboard response must echo the requested page and size')
  }
  if (data.data.length > pageSize) {
    throw new TypeError('[binance_web3] leaderboard page holds more rows than the page size')
  }
  if (
    typeof data.pages !== 'number' ||
    !Number.isSafeInteger(data.pages) ||
    data.pages < 1 ||
    data.pages > MAX_BOARD_PAGES
  ) {
    throw new TypeError(`[binance_web3] leaderboard data.pages must be 1..${MAX_BOARD_PAGES}`)
  }
  return {
    rowCount: data.data.length,
    reportedPopulation: null,
    reportedPageCount: null, // the declared end signal (data.pages) is the page count
    reportedCurrentPage: data.current,
    reportedPageSize: data.size,
  }
}

const binanceWeb3Adapter: SourceAdapter = {
  slug: 'binance_web3',
  capabilities: {
    profile: false, // bot-shield gated — Tier-A-only source (see header)
    positions: false,
    positionHistory: false,
    orders: false,
    transfers: false,
    copiers: false, // on-chain — no copy trading
  },

  /**
   * tag=ALL pages 1..data.pages (page counts differ per TF). The endpoint
   * filters rows after pagination (probed 2026-11-15, 90d: 20 pages, pages
   * 3/5/7/10 held 23/22/24/24 of 25 rows), so a short page is not the end and
   * page slots never shift. Each RAW page is the upstream response verbatim;
   * KOL membership is the row's own `tags` (every KOL-board row carries
   * "KOL"), so no second board is fetched.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    const period = PERIOD[timeframe]
    const pageSize = src.page_size ?? PAGE_SIZE
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) {
      throw new TypeError(`[binance_web3] source page_size must be 1..${PAGE_SIZE}`)
    }
    const listUrl = endpoint(src, 'list', LIST_URL)
    return captureReplayLeaderboard(
      { session, fetcher: fetchBoardJson, src, label: 'binance_web3', signal: options?.signal },
      {
        buildRequest: (pageIndex) => ({
          url:
            `${listUrl}?chainId=${encodeURIComponent(chainId(src))}&period=${period}` +
            `&tag=ALL&pageNo=${pageIndex}&pageSize=${pageSize}`,
          method: 'GET',
          headers: HEADERS,
        }),
        publicRequest: { query: ['chainId', 'period', 'tag', 'pageNo', 'pageSize'] },
        pageBinding: { location: 'query', key: 'pageNo' },
        extractMeta: (payload, requestPageIndex) =>
          binanceWeb3LeaderboardMeta(payload, requestPageIndex, pageSize),
        pageSize,
        exhaustion: BINANCE_WEB3_LEADERBOARD_EXHAUSTION,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await binanceWeb3Adapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  async getProfile(): Promise<RawBundle> {
    throw new Error('[binance_web3] profile surface not supported (Tier-A-only source)')
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[binance_web3] positions surface not supported')
  },

  async *getHistory(
    _session: FetchSession,
    _src: SourceRow,
    _exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    throw new Error(`[binance_web3] history surface ${kind} not supported`)
  },

  parseLeaderboard: parseBinanceWeb3LeaderboardPage,
  parseLeaderboardSeries: parseBinanceWeb3LeaderboardSeries,
  parseProfile: parseBinanceWeb3Profile,
  parsePositions: parseBinanceWeb3Positions,
  parseHistory: parseBinanceWeb3History,
}

registerAdapter(binanceWeb3Adapter)

export { binanceWeb3Adapter }
