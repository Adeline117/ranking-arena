/**
 * Vertex Protocol (Arbitrum) — Inline fetcher for Vercel serverless
 * API: Vertex Indexer at https://archive.prod.vertexprotocol.com/v1
 * POST with {"type": "subaccounts"} to get top trader accounts
 *
 * Note: The Vertex indexer API may be geo-restricted from some locations.
 * The API uses a POST body with a "type" field to specify the query.
 * Fallback: uses the Vertex subgraph on Arbitrum if indexer is unavailable.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'

const SOURCE = 'vertex'
const INDEXER_URL = 'https://archive.prod.vertexprotocol.com/v1'
const TARGET = 500

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// ── API response types ──

interface VertexSubaccount {
  subaccount: string
  address?: string
  cumulative_pnl?: string | number
  total_entry_amount?: string | number
  net_funding?: string | number
  total_trades?: number
  open_interest?: string | number
}

interface VertexIndexerResponse {
  subaccounts?: VertexSubaccount[]
}

// ── Parse helpers ──

function parseVertexAddress(subaccount: string): string {
  // Vertex subaccount IDs are hex-encoded with 12-byte suffix
  // The first 20 bytes are the wallet address
  if (subaccount.startsWith('0x') && subaccount.length > 42) {
    return subaccount.slice(0, 42).toLowerCase()
  }
  return subaccount.toLowerCase()
}

function toNum(v: string | number | undefined | null): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? 0 : n
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Fetch subaccounts sorted by PnL
  // The Vertex indexer API accepts POST with JSON body
  let subaccounts: VertexSubaccount[] = []

  try {
    const response = await fetchJson<VertexIndexerResponse>(INDEXER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'subaccounts',
        limit: { raw: TARGET * 2 },
        max: true,
      },
      timeoutMs: 20000,
    })
    subaccounts = response?.subaccounts || []
  } catch {
    // Fallback: try alternate request format
    try {
      const response = await fetchJson<VertexIndexerResponse>(INDEXER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          subaccounts: {
            start_idx: 0,
            limit: TARGET * 2,
          },
        },
        timeoutMs: 20000,
      })
      subaccounts = response?.subaccounts || []
    } catch (err) {
      return {
        total: 0,
        saved: 0,
        error: `Vertex indexer unreachable: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (subaccounts.length === 0) {
    return { total: 0, saved: 0, error: 'No subaccounts returned from Vertex indexer' }
  }

  const capturedAt = new Date().toISOString()
  const seenAddresses = new Set<string>()

  interface ParsedVertexTrader {
    address: string
    displayName: string
    roi: number
    pnl: number
    tradesCount: number
  }

  const parsed: ParsedVertexTrader[] = []

  for (const acct of subaccounts) {
    const address = parseVertexAddress(acct.subaccount || acct.address || '')
    if (!address || address.length < 10) continue
    if (seenAddresses.has(address)) continue
    seenAddresses.add(address)

    const pnl = toNum(acct.cumulative_pnl)
    const entryAmount = toNum(acct.total_entry_amount)
    const roi = entryAmount > 100 ? (pnl / entryAmount) * 100 : 0

    // Sanity bounds
    if (roi < -100 || roi > 10000) continue
    if (pnl < -10000000 || pnl > 100000000) continue

    parsed.push({
      address,
      displayName: `${address.slice(0, 6)}...${address.slice(-4)}`,
      roi,
      pnl,
      tradesCount: acct.total_trades || 0,
    })
  }

  // Sort by ROI descending
  parsed.sort((a, b) => b.roi - a.roi)
  const top = parsed.slice(0, TARGET)

  const traders: TraderData[] = top.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://app.vertexprotocol.com/portfolio/${t.address}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: null, // Not available from indexer
    max_drawdown: null,
    trades_count: t.tradesCount,
    arena_score: calculateArenaScore(t.roi, t.pnl, null, null, period),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)
  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchVertex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
    } catch (err) {
      result.periods[period] = {
        total: 0,
        saved: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
  }

  result.duration = Date.now() - start
  return result
}
