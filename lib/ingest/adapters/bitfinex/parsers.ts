/**
 * Bitfinex pure parsers (spec §7 #26).
 *
 * Input is the composite RAW payload the adapter stores per crawl:
 *   { timeframe, boardKey, snapshotTs,
 *     boards: { [key]: { ts, rows: <verbatim API arrays> } } }
 *
 * Ranking row layout (verified live 2026-06-12 against the rankings API;
 * matches bfxleaderboardTracker's twitterArg=2 / valueArg=6):
 *   [0] mts        snapshot timestamp (ms)
 *   [2] username   public leaderboard handle — the ONLY identity
 *   [3] rank       1-based position
 *   [6] value      metric value in literal USD
 *   [8] unknown    small int 0/1/2 (badge-ish) — kept verbatim in raw
 * All other indexes observed null (index 12 occasionally a ms timestamp)
 * — the full array is preserved in raw.row.
 *
 * Board membership/rank come from boards[boardKey] (plu_diff). The other
 * keys (plu/plr/vol) are joined by username into raw.extras — membership
 * differs per key, so misses are simply absent (NULL-collapse, spec §3).
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
} from '../../core/types'

export const BFX_MTS = 0
export const BFX_USERNAME = 2
export const BFX_RANK = 3
export const BFX_VALUE = 6

type Row = unknown[]

interface KeySnapshot {
  ts?: unknown
  rows?: unknown
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rowsOf(snap: KeySnapshot | undefined): Row[] {
  return Array.isArray(snap?.rows) ? (snap!.rows as unknown[]).filter(Array.isArray) : []
}

/** username → value map for one extras key's snapshot. */
function valueByUsername(snap: KeySnapshot | undefined): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rowsOf(snap)) {
    const username = row[BFX_USERNAME]
    const value = num(row[BFX_VALUE])
    if (typeof username === 'string' && username.length > 0 && value !== null) {
      map.set(username, value)
    }
  }
  return map
}

// ── Leaderboard ──

export function parseBitfinexLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as {
    boardKey?: unknown
    snapshotTs?: unknown
    reportedTotal?: unknown
    boards?: Record<string, KeySnapshot>
  }
  const boards = payload.boards ?? {}
  const boardKey = typeof payload.boardKey === 'string' ? payload.boardKey : 'plu_diff'
  const boardRows = rowsOf(boards[boardKey])

  const extras = new Map<string, Map<string, number>>()
  for (const [key, snap] of Object.entries(boards)) {
    if (key === boardKey) continue
    extras.set(key, valueByUsername(snap))
  }

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < boardRows.length; i++) {
    const row = boardRows[i]
    const username = row[BFX_USERNAME]
    if (typeof username !== 'string' || username.length === 0) continue

    const joined: Record<string, number> = {}
    for (const [key, byName] of extras) {
      const v = byName.get(username)
      if (v !== undefined) joined[key] = v
    }

    rows.push({
      exchangeTraderId: username,
      rank: num(row[BFX_RANK]) ?? i + 1,
      nickname: username,
      avatarUrlOrigin: null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: null, // the API exposes absolute USD values only
      headlinePnl: num(row[BFX_VALUE]),
      headlineWinRate: null,
      traderMeta: null,
      raw: {
        row, // verbatim API array (mts/rank/value + unmapped indexes)
        board_key: boardKey,
        snapshot_ts: num(payload.snapshotTs),
        extras: joined, // plu / plr / vol values where the username appears
      },
    })
  }

  // Pre-truncation membership embedded fetch-side (smoke runs truncate
  // the stored board); fall back to what we can see.
  return { rows, reportedTotal: num(payload.reportedTotal) ?? boardRows.length }
}

// ── Unsupported surfaces (Tier-A-only source) ──

export function parseBitfinexProfile(_raw: unknown, _ctx: ParseCtx): ParsedProfile {
  throw new Error('[bitfinex] profile surface not supported (Tier-A-only source)')
}

export function parseBitfinexPositions(_raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  throw new Error('[bitfinex] positions surface not supported')
}

export function parseBitfinexHistory(
  _raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  throw new Error(`[bitfinex] history surface ${kind} not supported`)
}
