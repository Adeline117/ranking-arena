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
  captureNumericLeaderboard,
  type JsonFetcher,
  type NumericLeaderboardPageMeta,
} from '../../fetch/capture'
import {
  parseOkxWeb3History,
  parseOkxWeb3LeaderboardPage,
  parseOkxWeb3Positions,
  parseOkxWeb3Profile,
} from './parsers'
import {
  OKX_WEB3_CHAIN_ID,
  OKX_WEB3_LEADERBOARD_LIST_URL,
  OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP,
  OKX_WEB3_PERIOD_TYPE,
  buildOkxWeb3LeaderboardListUrl,
  projectOkxWeb3LeaderboardRequest,
} from './request-evidence'

const BASE = 'https://web3.okx.com/priapi/v1/dx/market/v2'
const HEADERS = {
  accept: 'application/json',
  referer: 'https://web3.okx.com/copy-trade/leaderboard/solana',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function chainId(src: SourceRow): string {
  const value = String(src.meta.chain_id ?? OKX_WEB3_CHAIN_ID)
  if (value !== OKX_WEB3_CHAIN_ID) {
    throw new TypeError('[okx_web3] source chain_id must be Solana 501')
  }
  return value
}

/** Paced plain-HTTP GET; 401/403/429 feed the gate's backoff. */
async function fetchJson(session: FetchSession, url: string): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, { headers: HEADERS })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[okx_web3] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

/** Capture fetcher intentionally does not pace or throw on HTTP status. */
const fetchLeaderboardJson: JsonFetcher = async (template) => {
  const response = await fetch(template.url, { headers: template.headers })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // Preserve a non-JSON response as null; capture records status before validation fails.
  }
  return { status: response.status, json }
}

interface RankingData {
  rankingInfos?: unknown[]
  totalCount?: number
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new TypeError(`[okx_web3] leaderboard ${label} must be a non-negative safe integer`)
  }
  return value
}

function configuredPageSize(value: unknown): number {
  const pageSize = value ?? OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP
  if (
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    Object.is(pageSize, -0) ||
    pageSize < 1 ||
    pageSize > OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP
  ) {
    throw new TypeError(
      `[okx_web3] source page_size must be a positive safe integer no greater than ${OKX_WEB3_LEADERBOARD_PAGE_SIZE_CAP}`
    )
  }
  return pageSize
}

function configuredCallerPageCap(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (
    typeof numeric !== 'number' ||
    !Number.isSafeInteger(numeric) ||
    Object.is(numeric, -0) ||
    numeric < 1
  ) {
    throw new TypeError('[okx_web3] meta.max_pages must be a positive safe integer')
  }
  return numeric
}

function okxWeb3LeaderboardMeta(
  payload: unknown,
  requestPageIndex: number,
  pageSize: number,
  timeframe: RankingTimeframe
): NumericLeaderboardPageMeta {
  const root = recordOf(payload)
  if (root?.code !== 0) {
    throw new TypeError('[okx_web3] leaderboard response must declare numeric code 0')
  }
  const data = recordOf(root.data)
  if (!data || !Array.isArray(data.rankingInfos)) {
    throw new TypeError('[okx_web3] leaderboard response must contain data.rankingInfos')
  }

  const rankStart = nonNegativeSafeInteger(data.rankStart, 'data.rankStart')
  const rankEnd = nonNegativeSafeInteger(data.rankEnd, 'data.rankEnd')
  const totalCount = nonNegativeSafeInteger(data.totalCount, 'data.totalCount')
  const expectedRankStart = (requestPageIndex - 1) * pageSize
  const expectedRankEnd = expectedRankStart + pageSize
  if (rankStart !== expectedRankStart || rankEnd !== expectedRankEnd) {
    throw new TypeError('[okx_web3] leaderboard response rank bounds must match the request page')
  }
  if (data.rankingInfos.length > pageSize) {
    throw new TypeError('[okx_web3] leaderboard response row count must not exceed the page size')
  }
  if (totalCount < rankStart + data.rankingInfos.length) {
    throw new TypeError('[okx_web3] leaderboard totalCount must cover the returned rank range')
  }

  const expectedPeriodType = OKX_WEB3_PERIOD_TYPE[timeframe]
  const filter = recordOf(data.rankingFilter)
  if (
    !filter ||
    filter.periodType !== expectedPeriodType ||
    filter.chainId !== OKX_WEB3_CHAIN_ID ||
    filter.rankBy !== '1' ||
    filter.desc !== 'true' ||
    filter.label !== ''
  ) {
    throw new TypeError('[okx_web3] leaderboard response filter must echo the requested board')
  }
  for (const rowValue of data.rankingInfos) {
    const row = recordOf(rowValue)
    if (
      !row ||
      row.periodType !== expectedPeriodType ||
      (row.chainId !== Number(OKX_WEB3_CHAIN_ID) && row.chainId !== OKX_WEB3_CHAIN_ID)
    ) {
      throw new TypeError('[okx_web3] leaderboard row must match the requested period and chain')
    }
  }

  return {
    rowCount: data.rankingInfos.length,
    reportedPopulation: totalCount,
    reportedPageCount: null,
    reportedCurrentPage: requestPageIndex,
    reportedPageSize: pageSize,
  }
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

async function captureOkxWeb3Leaderboard(
  session: FetchSession,
  src: SourceRow,
  timeframe: RankingTimeframe
) {
  chainId(src)
  const pageSize = configuredPageSize(src.page_size)
  const callerPageCap = configuredCallerPageCap(src.meta.max_pages)
  const listEndpoint = endpoint(src, 'list', OKX_WEB3_LEADERBOARD_LIST_URL)

  return captureNumericLeaderboard({
    session,
    fetcher: fetchLeaderboardJson,
    buildRequest: (pageIndex) => ({
      url: buildOkxWeb3LeaderboardListUrl({
        endpoint: listEndpoint,
        pageIndex,
        pageSize,
        timeframe,
      }),
      method: 'GET',
      headers: HEADERS,
    }),
    projectPublicRequest: projectOkxWeb3LeaderboardRequest,
    pageBinding: { location: 'query_offset', key: 'rankStart', page_size: pageSize },
    extractMeta: (payload, requestPageIndex) =>
      okxWeb3LeaderboardMeta(payload, requestPageIndex, pageSize, timeframe),
    pageSize,
    callerPageCap,
  })
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

  captureLeaderboard: captureOkxWeb3Leaderboard,

  /** rankStart/rankEnd windows of 20 until totalCount is covered (~3.8k/
   *  5.5k/6.8k per TF at survey time → expected_count NULL, rolling
   *  baseline governs). meta.max_pages caps smoke runs. */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await captureOkxWeb3Leaderboard(session, src, timeframe)
    for (const page of capture.parsePages) yield page
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
      `?periodType=${OKX_WEB3_PERIOD_TYPE[tf]}&chainId=${chainId(src)}` +
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
export { projectOkxWeb3LeaderboardRequest } from './request-evidence'
