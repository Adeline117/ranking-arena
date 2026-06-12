/**
 * Bitfinex API-first adapter (spec §7 #26, §9 open item 5).
 *
 * PURE HTTP — no Playwright. The public rankings API beats the UI
 * (modeled on github.com/Buttaa/bfxleaderboardTracker, which reads
 * plu:1w:tGLOBAL:USD/hist and parses row[2]=username, row[6]=value):
 *
 *   GET api-pub.bitfinex.com/v2/rankings/{key}:{period}:tGLOBAL:USD/hist
 *       ?limit&sort=-1
 *
 * Key space (enumerated live 2026-06-12):
 *   plu_diff  unrealised-profit period delta  → THE board (window-PnL
 *             semantics, widest membership: 212 @1w / 211 @1M)
 *   plu       unrealised profit (position)    → extras
 *   plr       realised profit                 → extras (70 @1w)
 *   vol       traded volume                   → extras (192 @1w)
 *   Periods: 1w→7d, 1M→30d. NO 90d period exists. 3h exists but is
 *   sub-TF (and vol:3h serves stale 2021 data) — never requested.
 *
 * /hist returns HISTORICAL snapshots mixed (one per week for 1w, per
 * month for 1M); sort=-1 puts the latest snapshot first, so latest-ts
 * row filtering inside `limit` is complete. Origin refreshes weekly/
 * monthly — cadence_tier_a is relaxed accordingly (12h).
 *
 * TIER-A-ONLY SOURCE: Bitfinex exposes no public per-username profile/
 * positions/history API keyed by leaderboard identity. The tracker's
 * "position inference" (profit moving with BTC price ⇒ long) is a
 * heuristic over snapshot deltas, not a data surface — documented here
 * and in sources.meta, deliberately NOT built (spec Phase 3 note).
 * Values are literal USD (currency='USD', spec §5.8).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type { HistoryKind, RankingTimeframe, RawBundle, RawPage, SourceRow } from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import {
  BFX_RANK,
  parseBitfinexHistory,
  parseBitfinexLeaderboardPage,
  parseBitfinexPositions,
  parseBitfinexProfile,
} from './parsers'

const RANKINGS_BASE = 'https://api-pub.bitfinex.com/v2/rankings'
const DEFAULT_BOARD_KEY = 'plu_diff'
const DEFAULT_EXTRA_KEYS = ['plu', 'plr', 'vol']
const DEFAULT_SYMBOL = 'tGLOBAL'
const DEFAULT_HIST_LIMIT = 2_500 // latest snapshot ≈212 rows; 10× headroom
const DAY_MS = 86_400_000

/** Native period labels; 90d does not exist upstream (timeframes_native=[7,30]). */
const PERIOD: Partial<Record<RankingTimeframe, string>> = { 7: '1w', 30: '1M' }

/** Long-dead-board guard: origin refreshes weekly (1w) / monthly (1M);
 *  a latest snapshot older than ~2 windows + slack means the feed died —
 *  fail the crawl instead of republishing a corpse (vol:3h precedent:
 *  that key still serves April-2021 data). */
const MAX_SNAPSHOT_AGE_DAYS: Partial<Record<RankingTimeframe, number>> = { 7: 21, 30: 75 }

type Row = unknown[]

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** Paced plain-HTTP GET; 401/403/429 feed the gate's backoff. */
async function fetchJson(session: FetchSession, url: string): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[bitfinex] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

interface RankingSnapshot {
  ts: number
  rows: Row[]
  url: string
}

/** Fetch one ranking key's history and keep only the LATEST snapshot
 *  (all rows sharing the max mts — complete under sort=-1). */
async function fetchLatestSnapshot(
  session: FetchSession,
  src: SourceRow,
  key: string,
  period: string
): Promise<RankingSnapshot> {
  const base = endpoint(src, 'rankings', RANKINGS_BASE)
  const symbol = String(src.meta.symbol ?? DEFAULT_SYMBOL)
  const limit = Number(src.meta.hist_limit) || DEFAULT_HIST_LIMIT
  const url = `${base}/${key}:${period}:${symbol}:USD/hist?limit=${limit}&sort=-1`

  const payload = await fetchJson(session, url)
  if (!Array.isArray(payload)) {
    throw new Error(`[bitfinex] unexpected rankings shape from ${url}`)
  }
  const rows = payload.filter((r): r is Row => Array.isArray(r))
  if (rows.length === 0) return { ts: 0, rows: [], url }

  let ts = 0
  for (const r of rows) {
    const mts = Number(r[0])
    if (Number.isFinite(mts) && mts > ts) ts = mts
  }
  return { ts, rows: rows.filter((r) => Number(r[0]) === ts), url }
}

const bitfinexAdapter: SourceAdapter = {
  slug: 'bitfinex',
  capabilities: {
    profile: false, // no public per-username API — Tier-A-only (see header)
    positions: false,
    positionHistory: false,
    orders: false,
    transfers: false,
    copiers: false, // not a copy-trading product
  },

  /**
   * One board fetch (plu_diff) + one fetch per extras key — 4 paced GETs
   * per TF, 8 per crawl. The composite single-page payload embeds every
   * key's latest snapshot so the extras join survives pure re-parse
   * (spec §5.5). reportedTotal = board membership.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const period = PERIOD[timeframe]
    if (!period) throw new Error(`[bitfinex] no native period for ${timeframe}d`)

    const boardKey = String(src.meta.board_key ?? DEFAULT_BOARD_KEY)
    const extraKeys = Array.isArray(src.meta.extra_keys)
      ? (src.meta.extra_keys as string[])
      : DEFAULT_EXTRA_KEYS

    const board = await fetchLatestSnapshot(session, src, boardKey, period)
    if (board.rows.length === 0) {
      throw new Error(`[bitfinex] empty ${boardKey}:${period} board from ${board.url}`)
    }
    const maxAgeDays = Number(src.meta.max_snapshot_age_days) || MAX_SNAPSHOT_AGE_DAYS[timeframe]!
    const ageDays = (Date.now() - board.ts) / DAY_MS
    if (ageDays > maxAgeDays) {
      throw new Error(
        `[bitfinex] stale ${boardKey}:${period} board — latest snapshot ` +
          `${new Date(board.ts).toISOString()} is ${ageDays.toFixed(1)}d old (max ${maxAgeDays}d)`
      )
    }

    const boards: Record<string, { ts: number; rows: Row[] }> = {
      [boardKey]: { ts: board.ts, rows: board.rows },
    }
    for (const key of extraKeys) {
      if (key === boardKey) continue
      const snap = await fetchLatestSnapshot(session, src, key, period)
      boards[key] = { ts: snap.ts, rows: snap.rows }
    }

    // Validation knob (smoke runs): meta.max_rows truncates the board.
    const maxRows = Number(src.meta.max_rows) || null
    if (maxRows !== null) {
      boards[boardKey] = {
        ts: board.ts,
        rows: [...board.rows]
          .sort((a, b) => (Number(a[BFX_RANK]) || 0) - (Number(b[BFX_RANK]) || 0))
          .slice(0, maxRows),
      }
    }

    yield {
      pageIndex: 1,
      payload: {
        timeframe,
        boardKey,
        snapshotTs: board.ts,
        reportedTotal: board.rows.length, // pre-truncation membership
        boards,
      },
      url: board.url,
      fetchedAt: new Date().toISOString(),
    }
  },

  async getProfile(): Promise<RawBundle> {
    throw new Error('[bitfinex] profile surface not supported (Tier-A-only source)')
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[bitfinex] positions surface not supported')
  },

  async *getHistory(
    _session: FetchSession,
    _src: SourceRow,
    _exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    throw new Error(`[bitfinex] history surface ${kind} not supported`)
  },

  parseLeaderboard: parseBitfinexLeaderboardPage,
  parseProfile: parseBitfinexProfile,
  parsePositions: parseBitfinexPositions,
  parseHistory: parseBitfinexHistory,
}

registerAdapter(bitfinexAdapter)

export { bitfinexAdapter }
