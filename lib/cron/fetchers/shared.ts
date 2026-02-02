/**
 * Shared utilities for inline platform fetchers
 * Used by Vercel serverless functions — no child_process, no puppeteer
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ============================================
// Types
// ============================================

export interface TraderData {
  source: string
  source_trader_id: string
  handle: string
  profile_url?: string | null
  season_id: string
  rank?: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers?: number | null
  trades_count?: number | null
  arena_score: number | null
  captured_at: string
}

export interface FetchResult {
  source: string
  periods: Record<string, { total: number; saved: number; error?: string }>
  duration: number
}

export type PlatformFetcher = (
  supabase: SupabaseClient,
  periods: string[]
) => Promise<FetchResult>

// ============================================
// Supabase
// ============================================

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// ============================================
// Arena Score V2 Calculation
// (Synced with lib/utils/arena-score.ts and scripts/lib/shared.mjs)
// ============================================

const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const safeLog1p = (x: number) => (x <= -1 ? 0 : Math.log(1 + x))

const ARENA_PARAMS: Record<string, { tanhCoeff: number; roiExponent: number; mddThreshold: number; winRateCap: number }> = {
  '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}

const PNL_PARAMS: Record<string, { base: number; coeff: number }> = {
  '7D': { base: 500, coeff: 0.40 },
  '30D': { base: 2000, coeff: 0.35 },
  '90D': { base: 5000, coeff: 0.30 },
}

const MAX_RETURN = 70
const MAX_PNL = 15
const MAX_DD = 8
const MAX_STAB = 7
const WR_BASELINE = 45

function calcPnlScore(pnl: number | null, period: string): number {
  if (pnl == null || pnl <= 0) return 0
  const p = PNL_PARAMS[period] || PNL_PARAMS['90D']
  const logArg = 1 + pnl / p.base
  if (logArg <= 0) return 0
  return clip(MAX_PNL * Math.tanh(p.coeff * Math.log(logArg)), 0, MAX_PNL)
}

export function calculateArenaScore(
  roi: number,
  pnl: number | null,
  maxDrawdown: number | null,
  winRate: number | null,
  period: string
): number {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90

  // Normalize win rate
  const wr = winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null

  // Return score (0-70)
  const intensity = (365 / days) * safeLog1p(roi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(MAX_RETURN * Math.pow(r0, params.roiExponent), 0, MAX_RETURN) : 0

  // PnL score (0-15)
  const pnlScore = calcPnlScore(pnl, period)

  // Drawdown score (0-8)
  const drawdownScore =
    maxDrawdown != null
      ? clip(MAX_DD * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, MAX_DD)
      : 4

  // Stability score (0-7)
  const stabilityScore =
    wr != null
      ? clip(MAX_STAB * clip((wr - WR_BASELINE) / (params.winRateCap - WR_BASELINE), 0, 1), 0, MAX_STAB)
      : 3.5

  return Math.round((returnScore + pnlScore + drawdownScore + stabilityScore) * 100) / 100
}

// ============================================
// Upsert Helpers
// ============================================

export async function upsertTraders(
  supabase: SupabaseClient,
  traders: TraderData[]
): Promise<{ saved: number; error?: string }> {
  if (traders.length === 0) return { saved: 0 }

  const BATCH = 100

  let saved = 0

  for (let i = 0; i < traders.length; i += BATCH) {
    const batch = traders.slice(i, i + BATCH)

    // Upsert trader_sources
    const sources = batch.map((t) => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      handle: t.handle,
      profile_url: t.profile_url || null,
      is_active: true,
      updated_at: new Date().toISOString(),
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sources, { onConflict: 'source,source_trader_id' })

    if (srcErr) console.warn(`[upsert] trader_sources error: ${srcErr.message}`)

    // Upsert trader_snapshots
    const snapshots = batch.map((t) => ({
      source: t.source,
      source_trader_id: t.source_trader_id,
      season_id: t.season_id,
      rank: t.rank || null,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers || null,
      trades_count: t.trades_count || null,
      arena_score: t.arena_score,
      captured_at: t.captured_at,
    }))

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })

    if (snapErr) {
      console.warn(`[upsert] trader_snapshots error: ${snapErr.message}`)
      return { saved, error: snapErr.message }
    }

    saved += batch.length
  }

  return { saved }
}

// ============================================
// HTTP Helpers
// ============================================

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

export async function fetchJson<T = unknown>(
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
  }
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs || 15000)

  try {
    const res = await fetch(url, {
      method: opts?.method || 'GET',
      headers: { ...DEFAULT_HEADERS, ...opts?.headers },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`)
    }

    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function parseNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

export function normalizeWinRate(wr: number | null): number | null {
  if (wr == null) return null
  return wr <= 1 ? wr * 100 : wr
}
