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
 * tag=ALL, no clicking needed). KOL membership: the KOL board is fetched
 * ONCE per session (period=90d — the widest window; anyone active on a
 * shorter board is active on 90d) and embedded into every page payload as
 * kolAddresses → traderMeta.binance_web3_kol.
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
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import {
  parseBinanceWeb3History,
  parseBinanceWeb3LeaderboardPage,
  parseBinanceWeb3Positions,
  parseBinanceWeb3Profile,
} from './parsers'

const LIST_URL =
  'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query'
const PAGE_SIZE = 25 // API max
const PERIOD: Record<RankingTimeframe, string> = { 7: '7d', 30: '30d', 90: '90d' }
const MAX_KOL_PAGES = 10 // KOL board is ~4 pages; hard safety cap

type Dict = Record<string, unknown>

interface BoardData {
  data?: Dict[]
  pages?: number
  size?: number
  current?: number
}

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function chainId(src: SourceRow): string {
  return String(src.meta.chain_id ?? '56')
}

/** Paced plain-HTTP GET with the browser-ish headers the bapi expects. */
async function fetchJson(session: FetchSession, url: string): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        origin: 'https://web3.binance.com',
        referer: 'https://web3.binance.com/en/leaderboard',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[binance_web3] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

function listUrl(
  src: SourceRow,
  tag: string,
  period: string,
  pageNo: number,
  pageSize: number
): string {
  const base = endpoint(src, 'list', LIST_URL)
  return `${base}?chainId=${chainId(src)}&period=${period}&tag=${tag}&pageNo=${pageNo}&pageSize=${pageSize}`
}

/** Board payload shape: { code, data: { data, pages, size, current } };
 *  geo-blocked requests answer 200 with an empty body — surface that as a
 *  hard error rather than publishing an empty board. */
function boardData(payload: unknown, url: string): BoardData {
  const root = (payload ?? {}) as { code?: unknown; data?: unknown }
  if (root.code !== '000000') {
    throw new Error(`[binance_web3] API code ${String(root.code)} from ${url}`)
  }
  return (root.data ?? {}) as BoardData
}

// ── KOL membership set, memoized per session ──

const kolCache = new WeakMap<FetchSession, Promise<string[]>>()

function getKolAddresses(session: FetchSession, src: SourceRow): Promise<string[]> {
  let cached = kolCache.get(session)
  if (!cached) {
    cached = (async () => {
      const addresses: string[] = []
      let pageCount = MAX_KOL_PAGES
      for (let pageNo = 1; pageNo <= Math.min(pageCount, MAX_KOL_PAGES); pageNo++) {
        const url = listUrl(src, 'KOL', '90d', pageNo, PAGE_SIZE)
        const data = boardData(await fetchJson(session, url), url)
        if (typeof data.pages === 'number') pageCount = data.pages
        const rows = Array.isArray(data.data) ? data.data : []
        for (const row of rows) {
          const addr = String(row.address ?? '').toLowerCase()
          if (addr.startsWith('0x')) addresses.push(addr)
        }
        if (rows.length < PAGE_SIZE) break
      }
      return addresses
    })()
    kolCache.set(session, cached)
    cached.catch(() => kolCache.delete(session)) // never memoize a failure
  }
  return cached
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
   * tag=ALL pages 1..data.pages (page counts differ per TF: ~9/21/30 at
   * survey time — expected_count is NULL, the rolling baseline governs).
   *
   * The endpoint returns VARIABLE row counts mid-crawl (server-side row
   * filtering after pagination; verified live: page 2 of 9 came back with
   * 23/25 rows) — so "short page = end" is wrong here. Fetch every page up
   * to the reported page count, dedupe by address (the live board shifts
   * under pagination), then re-chunk into exact page_size chunks so the
   * Tier-A rank re-anchoring ((pageIndex−1)×page_size) stays gap-free
   * (hyperliquid pattern: RAW stores the normalized board).
   * Every chunk payload embeds the session's KOL set for pure re-parse.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const kolAddresses = await getKolAddresses(session, src)
    const period = PERIOD[timeframe]
    const pageSize = src.page_size ?? PAGE_SIZE
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPagesKnob = Number(src.meta.max_pages) || null

    const seen = new Set<string>()
    const rows: Dict[] = []
    let pageCount: number | null = null
    let lastUrl = listUrl(src, 'ALL', period, 1, pageSize)
    for (let pageNo = 1; pageNo <= (maxPagesKnob ?? pageCount ?? 1); pageNo++) {
      const url = listUrl(src, 'ALL', period, pageNo, pageSize)
      lastUrl = url
      const data = boardData(await fetchJson(session, url), url)
      if (typeof data.pages === 'number' && pageCount === null) {
        pageCount = maxPagesKnob !== null ? Math.min(data.pages, maxPagesKnob) : data.pages
      }
      const pageRows = Array.isArray(data.data) ? data.data : []
      if (pageRows.length === 0) break
      for (const row of pageRows) {
        const addr = String(row.address ?? '').toLowerCase()
        if (!addr.startsWith('0x') || seen.has(addr)) continue
        seen.add(addr)
        rows.push(row)
      }
    }

    const fetchedAt = new Date().toISOString()
    for (let i = 0; i < rows.length; i += pageSize) {
      yield {
        pageIndex: Math.floor(i / pageSize) + 1,
        payload: {
          board: { code: '000000', data: { data: rows.slice(i, i + pageSize) } },
          kolAddresses,
          timeframe,
        },
        url: lastUrl,
        fetchedAt,
      }
    }
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
  parseProfile: parseBinanceWeb3Profile,
  parsePositions: parseBinanceWeb3Positions,
  parseHistory: parseBinanceWeb3History,
}

registerAdapter(binanceWeb3Adapter)

export { binanceWeb3Adapter }
