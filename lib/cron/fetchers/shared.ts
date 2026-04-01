/**
 * Shared utilities for inline platform fetchers
 * Used by Vercel serverless functions — no child_process, no puppeteer
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { z } from 'zod'
import { dataLogger, fireAndForget } from '@/lib/utils/logger'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { syncToClickHouse } from '@/lib/analytics/dual-write'
import { retryUpsert } from '@/lib/utils/supabase-retry'
import { validateSnapshot } from '@/lib/pipeline/validate-snapshot'

/** Resolve market_type from SOURCE_TYPE_MAP for trader_profiles_v2 */
function getMarketType(source: string): string {
  return SOURCE_TYPE_MAP[source] || 'futures'
}

// ============================================
// Failure Classification
// ============================================

export type FailureReason =
  | 'geo_blocked'      // 451/403 + geo-block indicators
  | 'waf_blocked'      // Cloudflare/Akamai WAF (HTML response)
  | 'auth_required'    // 401 — needs API key
  | 'endpoint_gone'    // 404 — API changed
  | 'rate_limited'     // 429 — too many requests
  | 'timeout'          // Request timed out
  | 'empty_data'       // 200 but no usable data
  | 'parse_error'      // Response couldn't be parsed
  | 'unknown'

export interface FetchDiagnostic {
  url: string
  httpStatus?: number
  failureReason: FailureReason
  hasCloudflareHeaders: boolean
  responseIsHtml: boolean
  durationMs: number
  error?: string
}

export function classifyFetchError(
  error: unknown,
  responseStatus?: number,
  responseBody?: string,
  responseHeaders?: Record<string, string>
): FailureReason {
  const msg = error instanceof Error ? error.message : String(error || '')
  const body = responseBody || ''
  const hasCfRay = !!responseHeaders?.['cf-ray']
  const isHtml = body.trimStart().startsWith('<') || body.includes('<!DOCTYPE')

  // Timeout
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
    return 'timeout'
  }

  // Rate limit
  if (responseStatus === 429 || msg.includes('429') || msg.includes('rate limit')) {
    return 'rate_limited'
  }

  // Geo-block
  if (
    responseStatus === 451 ||
    msg.includes('451') ||
    msg.includes('restricted location') ||
    msg.includes('Geo-blocked') ||
    (responseStatus === 403 && (msg.includes('geo') || body.includes('restricted')))
  ) {
    return 'geo_blocked'
  }

  // Auth required
  if (responseStatus === 401 || msg.includes('401') || msg.includes('Unauthorized')) {
    return 'auth_required'
  }

  // Endpoint gone
  if (responseStatus === 404 || msg.includes('404') || msg.includes('Not Found')) {
    return 'endpoint_gone'
  }

  // WAF / Cloudflare block
  if (
    isHtml ||
    (responseStatus === 403 && hasCfRay) ||
    msg.includes('Access Denied') ||
    msg.includes('WAF') ||
    msg.includes('Cloudflare') ||
    (responseStatus === 403 && body.includes('challenge'))
  ) {
    return 'waf_blocked'
  }

  // Generic 403 (likely geo or WAF)
  if (responseStatus === 403 || msg.includes('403')) {
    return 'geo_blocked'
  }

  return 'unknown'
}

// ============================================
// VPS Proxy Support
// ============================================

const VPS_PROXY_URL = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP || ''

export async function fetchViaVpsProxy<T = unknown>(
  targetUrl: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
  }
): Promise<T> {
  if (!VPS_PROXY_URL) {
    throw new Error('VPS_PROXY_URL not configured')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs || 30000)

  try {
    const res = await fetch(VPS_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Key': (process.env.VPS_PROXY_KEY || '').trim(),
      },
      body: JSON.stringify({
        url: targetUrl,
        method: opts?.method || 'GET',
        headers: opts?.headers || {},
        body: opts?.body || null,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`VPS proxy returned HTTP ${res.status}`)
    }

    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Smart fetch: direct → VPS proxy fallback
 * Only falls back to VPS proxy for geo/WAF blocks.
 */
export async function fetchWithFallback<T = unknown>(
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
    platform?: string
  }
): Promise<{ data: T; via: 'direct' | 'vps_proxy' }> {
  // Try direct first
  try {
    const data = await fetchJson<T>(url, opts)
    return { data, via: 'direct' }
  } catch (directErr) {
    const reason = classifyFetchError(directErr)

    // Only fallback to VPS for blockable errors
    if (
      (reason === 'geo_blocked' || reason === 'waf_blocked') &&
      VPS_PROXY_URL
    ) {
      dataLogger.warn(
        `[${opts?.platform || 'fetcher'}] Direct blocked (${reason}), trying VPS proxy for ${url.slice(0, 80)}...`
      )
      try {
        const data = await fetchViaVpsProxy<T>(url, opts)
        return { data, via: 'vps_proxy' }
      } catch (proxyErr) {
        // Both failed — throw with combined context
        throw new Error(
          `Direct: ${directErr instanceof Error ? directErr.message : String(directErr)}; ` +
          `VPS proxy: ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`
        )
      }
    }

    // Not a blockable error, re-throw original
    throw directErr
  }
}

// ============================================
// Types
// ============================================

/** @deprecated Write-path type for data pipeline. Use UnifiedTrader from '@/lib/types/unified-trader' for reads. */
export interface TraderData {
  source: string
  source_trader_id: string
  handle: string | null
  profile_url?: string | null
  season_id: string
  rank?: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers?: number | null
  copiers?: number | null
  trades_count?: number | null
  arena_score: number | null
  captured_at: string
  // Phase 1 扩展字段
  sharpe_ratio?: number | null
  aum?: number | null
  avatar_url?: string | null
}

/**
 * Zod schema for TraderData — validates all connector output before DB writes.
 * safeParse rejects malformed records (NaN, Infinity, wrong types) and logs failures.
 */
export const TraderDataSchema = z.object({
  source: z.string().min(1),
  source_trader_id: z.string().min(1),
  handle: z.string().nullable(),
  profile_url: z.string().nullable().optional(),
  season_id: z.string().min(1),
  rank: z.number().int().positive().nullable().optional(),
  roi: z.number().finite().min(-100).max(100000).nullable(),
  pnl: z.number().finite().nullable(),
  win_rate: z.number().finite().min(0).max(100).nullable(),
  max_drawdown: z.number().finite().min(0).max(100).nullable(),
  followers: z.number().finite().nonnegative().nullable().optional(),
  copiers: z.number().finite().nonnegative().nullable().optional(),
  trades_count: z.number().finite().nonnegative().nullable().optional(),
  arena_score: z.number().finite().nullable(),
  captured_at: z.string().min(1),
  sharpe_ratio: z.number().finite().min(-20).max(20).nullable().optional(),
  aum: z.number().finite().nonnegative().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
})

/** Tracks which tables succeeded/failed during a write batch */
export interface WriteConsistency {
  trader_sources: 'ok' | 'failed'  // now writes to unified `traders` table
  trader_snapshots_v2: 'ok' | 'failed'
}

export interface FetchResult {
  source: string
  periods: Record<string, { total: number; saved: number; error?: string }>
  duration: number
  write_consistency?: WriteConsistency
}

export type PlatformFetcher = (
  supabase: SupabaseClient,
  periods: string[]
) => Promise<FetchResult>

// ============================================
// Supabase
// ============================================

export function getSupabaseClient(): SupabaseClient | null {
  try {
    return getSupabaseAdmin()
  } catch {
    return null
  }
}

// ============================================
// Arena Score V3 Calculation
// (Synced with lib/utils/arena-score.ts — 2-component: ROI:60 + PnL:40)
// ============================================

const clip = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
const safeLog1p = (x: number) => (x <= -1 ? 0 : Math.log(1 + x))

const ARENA_PARAMS: Record<string, { tanhCoeff: number; roiExponent: number }> = {
  '7D': { tanhCoeff: 0.08, roiExponent: 1.8 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6 },
}

const PNL_PARAMS: Record<string, { base: number; coeff: number }> = {
  '7D': { base: 300, coeff: 0.42 },
  '30D': { base: 600, coeff: 0.30 },
  '90D': { base: 650, coeff: 0.27 },
}

const MAX_RETURN = 60
const MAX_PNL = 40

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
  _maxDrawdown: number | null,
  _winRate: number | null,
  period: string
): number {
  const params = ARENA_PARAMS[period] || ARENA_PARAMS['90D']
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90

  // Cap ROI to prevent extreme values (e.g. Hyperliquid 1M%+)
  const cappedRoi = Math.min(roi, 10000)

  // Return score (0-60)
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100)
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 > 0 ? clip(MAX_RETURN * Math.pow(r0, params.roiExponent), 0, MAX_RETURN) : 0

  // PnL score (0-40)
  const pnlScore = calcPnlScore(pnl, period)

  return Math.round((returnScore + pnlScore) * 100) / 100
}

// ============================================
// Upsert Helpers
// ============================================

export async function upsertTraders(
  supabase: SupabaseClient,
  traders: TraderData[]
): Promise<{ saved: number; error?: string; write_consistency?: WriteConsistency }> {
  if (traders.length === 0) return { saved: 0 }

  // Validate all records with Zod before DB writes
  const validated: TraderData[] = []
  let rejected = 0
  for (const t of traders) {
    const result = TraderDataSchema.safeParse(t)
    if (result.success) {
      validated.push(t)
    } else {
      rejected++
      if (rejected <= 10) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
        dataLogger.warn(`[validation] Rejected trader ${t.source}/${t.source_trader_id}: ${issues}`)
      }
    }
  }
  if (rejected > 0) {
    // Log total + first issue summary to detect systemic API format changes
    const severity = rejected > traders.length * 0.5 ? 'error' : 'warn'
    const msg = `[validation] ${rejected}/${traders.length} traders rejected (source: ${traders[0]?.source})`
    if (severity === 'error') dataLogger.error(msg)
    else dataLogger.warn(msg)
  }
  if (validated.length === 0) return { saved: 0, error: `All ${traders.length} traders failed validation` }

  // Normalize 0x addresses to lowercase before dedup and DB writes
  // This prevents duplicate entries for the same trader with different casing
  for (const t of validated) {
    if (t.source_trader_id.startsWith('0x') || t.source_trader_id.startsWith('0X')) {
      t.source_trader_id = t.source_trader_id.toLowerCase()
    }
  }

  // Deduplicate by (source, source_trader_id, season_id) — PostgreSQL ON CONFLICT
  // cannot affect the same row twice in a single upsert batch
  const deduped: TraderData[] = []
  const seenKeys = new Set<string>()
  for (const t of validated) {
    const key = `${t.source}|${t.source_trader_id}|${t.season_id}`
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      deduped.push(t)
    }
  }
  if (deduped.length < validated.length) {
    dataLogger.warn(`[upsert] Deduped ${validated.length - deduped.length} duplicate traders for ${validated[0]?.source}`)
  }

  // Validate snapshots before DB writes — catch ROI/PnL confusion, extreme outliers, missing fields
  let snapshotRejected = 0
  const snapshotValidated = deduped.filter(t => {
    const { valid, reasons } = validateSnapshot({
      platform: t.source,
      trader_key: t.source_trader_id,
      roi_pct: t.roi,
      pnl_usd: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
    })
    if (!valid) {
      snapshotRejected++
      if (snapshotRejected <= 10) {
        dataLogger.warn(`[upsert] Skipping invalid snapshot for ${t.source}/${t.source_trader_id}: ${reasons.join(', ')}`)
      }
    }
    return valid
  })
  if (snapshotRejected > 0) {
    dataLogger.warn(`[upsert] Snapshot validation rejected ${snapshotRejected}/${deduped.length} traders for ${deduped[0]?.source}`)
  }
  if (snapshotValidated.length === 0) {
    return { saved: 0, error: `All ${deduped.length} traders failed snapshot validation` }
  }

  const BATCH = 50 // Reduced from 500→200→50 to avoid Supabase statement timeout (57014) + deadlock (40P01)

  let saved = 0
  const writeErrors: string[] = []

  // Track write consistency across all batches
  const consistency: WriteConsistency = {
    trader_sources: 'ok',
    trader_snapshots_v2: 'ok',
  }

  for (let i = 0; i < snapshotValidated.length; i += BATCH) {
    const batch = snapshotValidated.slice(i, i + BATCH)

    // --- 1. traders (unified identity table) ---
    // Replaces both trader_sources and trader_profiles_v2 (merged 2026-03-18)
    try {
      const traderRows = batch.map((t) => ({
        platform: t.source,
        trader_key: t.source_trader_id,
        market_type: getMarketType(t.source),
        handle: t.handle || null,
        avatar_url: t.avatar_url || null,
        profile_url: t.profile_url || null,
        followers: t.followers ?? 0,
        aum: t.aum || null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }))

      // Emergency fix 2026-04-01: Add retry logic for Supabase 502 errors
      const { error: traderErr } = await retryUpsert(
        supabase,
        'traders',
        traderRows,
        { onConflict: 'platform,trader_key' },
        { maxAttempts: 3, initialDelayMs: 2000 }
      )

      if (traderErr) {
        consistency.trader_sources = 'failed'
        writeErrors.push(`traders: ${traderErr.message} (${traderErr.code})`)
        dataLogger.warn(`[upsert] traders error: ${traderErr.message}`)
      }
    } catch (err) {
      consistency.trader_sources = 'failed'
      dataLogger.error(`[upsert] traders exception: ${err instanceof Error ? err.message : String(err)}`)
    }

    // --- 3. trader_snapshots (v1) — REMOVED ---
    // v1 writes eliminated 2026-03-18. v2 is now the sole snapshot table.
    // compute-leaderboard reads v2 only. v1 table retained read-only for scripts.

    // --- 4. trader_snapshots_v2 (PRIMARY) ---
    try {
      const snapshots = batch.map((t) => {
        const w = t.season_id?.toUpperCase() || '30D'

        // Real data only — null is better than estimated values.
        // Enrichment pipeline fills in WR/MDD/Sharpe from real API data + equity curve.
        return {
        platform: t.source,
        market_type: getMarketType(t.source),
        trader_key: t.source_trader_id,
        window: w,
        as_of_ts: t.captured_at,
        // Flat columns — read by leaderboard, scoring, and frontend
        // Cap extreme ROI values (>100,000% is likely a normalization bug)
        // Also null out roi if roi ≈ pnl (data mapping error, e.g. Hyperliquid)
        roi_pct: t.roi != null && Math.abs(t.roi) > 100000 ? null
          : (t.roi != null && t.pnl != null && Math.abs(t.roi) > 1000 && Math.abs(t.roi - t.pnl) < 1) ? null
          : (t.roi ?? null),
        pnl_usd: t.pnl ?? null,
        win_rate: t.win_rate ?? null,
        max_drawdown: t.max_drawdown ?? null,
        arena_score: t.arena_score ?? null,  // computed by compute-leaderboard, don't overwrite with placeholder
        sharpe_ratio: t.sharpe_ratio ?? null,
        trades_count: t.trades_count ?? null,
        followers: null, // Arena internal only — do NOT write exchange follower counts
        copiers: null,  // Arena internal only — do NOT write exchange copier counts
        // JSONB metrics — full data for detail views and future use
        metrics: {
          roi: t.roi ?? null,
          pnl: t.pnl ?? null,
          win_rate: t.win_rate ?? null,
          max_drawdown: t.max_drawdown ?? null,
          trades_count: t.trades_count ?? null,
          followers: null,
          copiers: null,
          sharpe_ratio: t.sharpe_ratio ?? null,
          arena_score: t.arena_score ?? null,
          aum: t.aum || null,
        },
        quality_flags: {
          is_suspicious: false,
          suspicion_reasons: [],
          data_completeness: t.win_rate != null && t.max_drawdown != null ? 1.0 : 0.7,
        },
        updated_at: new Date().toISOString(),
      }})

      // Upsert snapshots — update metrics on conflict so re-runs refresh data
      // Emergency fix 2026-04-01: Add retry logic for Supabase 502 errors
      const { error: snapErr } = await retryUpsert(
        supabase,
        'trader_snapshots_v2',
        snapshots,
        { onConflict: 'platform,market_type,trader_key,window,as_of_ts' },
        { maxAttempts: 3, initialDelayMs: 2000 }
      )

      if (snapErr) {
        consistency.trader_snapshots_v2 = 'failed'
        writeErrors.push(`trader_snapshots_v2: ${snapErr.message} (${snapErr.code})`)
        dataLogger.error(`[upsert] trader_snapshots_v2 error: ${snapErr.message}`)
      }
    } catch (err) {
      consistency.trader_snapshots_v2 = 'failed'
      dataLogger.error(`[upsert] trader_snapshots_v2 exception: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Count as saved if v2 snapshot write succeeded (v2 is now the primary table)
    if (consistency.trader_snapshots_v2 !== 'failed') {
      saved += batch.length

      // Fire-and-forget: update live rankings sorted set for traders with arena_score
      import('@/lib/realtime/ranking-store').then(({ updateTraderScore }) => {
        for (const t of batch) {
          if (t.arena_score != null && t.arena_score > 0) {
            updateTraderScore(t.season_id, t.source, t.source_trader_id, t.arena_score).catch(err => dataLogger.warn('[RankingStore] Failed to update trader score:', err.message))
          }
        }
      }).catch(err => dataLogger.warn('[RankingStore] Failed to import ranking-store module:', err.message))

      // Fire-and-forget: dual-write snapshots to ClickHouse for analytics
      fireAndForget(
        syncToClickHouse('trader_snapshots_history', batch.map(t => ({
          platform: t.source,
          trader_key: t.source_trader_id,
          period: t.season_id,
          roi_pct: t.roi ?? 0,
          pnl_usd: t.pnl ?? 0,
          arena_score: t.arena_score ?? 0,
          win_rate: t.win_rate ?? null,
          max_drawdown: t.max_drawdown ?? null,
          sharpe_ratio: t.sharpe_ratio ?? null,
          followers: t.followers ?? 0,
          rank: t.rank ?? 0,
          captured_at: new Date().toISOString(),
        }))),
        'clickhouse-snapshot-sync'
      )
    }
  }

  // Log structured warning if any table had partial failures
  const failedTables = Object.entries(consistency)
    .filter(([, status]) => status === 'failed')
    .map(([table]) => table)
  if (failedTables.length > 0) {
    dataLogger.warn(
      `[upsert] Partial write failure for ${validated[0]?.source}: ` +
      `failed=[${failedTables.join(',')}], succeeded=[${Object.entries(consistency).filter(([, s]) => s === 'ok').map(([t]) => t).join(',')}]`
    )
  }

  // Surface write errors so callers can detect and report failures
  const writeError = failedTables.length > 0
    ? `Write failed for tables: ${failedTables.join(', ')}${writeErrors.length > 0 ? ` (${writeErrors.slice(0, 3).join('; ')})` : ''}`
    : undefined

  return { saved, error: writeError, write_consistency: consistency }
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
      // Read body for diagnostic context
      const body = await res.text().catch(() => '')
      const isHtml = body.trimStart().startsWith('<')
      const hasCfRay = !!res.headers.get('cf-ray')

      let detail = `HTTP ${res.status} from ${url}`
      if (isHtml) detail += ' (response is HTML, likely WAF/CF block)'
      if (hasCfRay) detail += ` [cf-ray: ${res.headers.get('cf-ray')}]`
      if (res.status === 451) detail += ' (geo-blocked)'
      if (res.status === 401) detail += ' (auth required)'

      throw new Error(detail)
    }

    // Detect HTML responses masquerading as 200 (CF challenge pages)
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      throw new Error(`HTTP ${res.status} from ${url} (response is HTML, likely WAF/CF block)`)
    }

    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch with VPS proxy fallback.
 * Tries direct first; on geo-block/WAF error, falls back to VPS proxy.
 */
export async function fetchWithVpsFallback<T = unknown>(
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
  }
): Promise<T> {
  try {
    return await fetchJson<T>(url, opts)
  } catch (directErr) {
    const msg = directErr instanceof Error ? directErr.message : ''
    const isBlocked =
      msg.includes('451') || msg.includes('403') || msg.includes('Access Denied') || msg.includes('geo-blocked')

    if (!isBlocked) throw directErr

    const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP
    if (!vpsUrl) throw directErr

    const res = await fetch(vpsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Key': (process.env.VPS_PROXY_KEY || '').trim(),
      },
      body: JSON.stringify({
        url,
        method: opts?.method || 'GET',
        headers: opts?.headers || {},
        body: opts?.body || null,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs || 20000),
    })
    if (!res.ok) throw new Error(`VPS proxy HTTP ${res.status}`)
    return (await res.json()) as T
  }
}

/**
 * fetchJson with automatic retry + exponential backoff.
 * Retries on 5xx, network errors, and timeouts. Does NOT retry 4xx.
 */
export async function fetchJsonWithRetry<T = unknown>(
  url: string,
  opts?: Parameters<typeof fetchJson>[1] & { maxRetries?: number }
): Promise<T> {
  const { maxRetries = 2, ...fetchOpts } = opts ?? {}

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchJson<T>(url, fetchOpts)
    } catch (error) {
      lastError = error
      const msg = error instanceof Error ? error.message : ''
      const is5xx = /HTTP 5\d\d/.test(msg)
      const isNetwork = /abort|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg)

      if (attempt >= maxRetries || (!is5xx && !isNetwork)) {
        throw error
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 8000) * (0.5 + Math.random() * 0.5)
      dataLogger.warn(`[fetchJsonWithRetry] Attempt ${attempt + 1} failed for ${url}, retrying in ${Math.round(delay)}ms`)
      await sleep(delay)
    }
  }
  throw lastError
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function parseNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

/**
 * Platform data format configuration.
 * Declares whether each platform returns ROI and win_rate as decimal (0.5 = 50%) or percentage (50 = 50%).
 */
export type DataFormat = 'decimal' | 'percentage'

export interface PlatformFormatConfig {
  roiFormat: DataFormat
  winRateFormat: DataFormat
}

/**
 * Explicit format declarations for every known platform.
 * 'decimal' means 0.5 = 50%, 'percentage' means 50 = 50%.
 *
 * NOTE: Some fetchers (binance-futures, gateio, binance-spot, bybit, bybit-spot)
 * do their own ROI conversion inline (e.g. `roi * 100`) before calling normalizeROI,
 * so their entries here reflect what the API *actually* returns, but callers may
 * skip normalizeROI entirely. Update those fetchers if migrating them.
 */
export const PLATFORM_FORMAT: Record<string, PlatformFormatConfig> = {
  // DEX platforms — typically return decimal
  hyperliquid:      { roiFormat: 'decimal', winRateFormat: 'decimal' },
  dydx:             { roiFormat: 'decimal', winRateFormat: 'decimal' },
  drift:            { roiFormat: 'decimal', winRateFormat: 'decimal' },
  gmx:              { roiFormat: 'decimal', winRateFormat: 'decimal' },
  gains:            { roiFormat: 'decimal', winRateFormat: 'decimal' },
  vertex:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  'jupiter-perps':  { roiFormat: 'decimal', winRateFormat: 'decimal' },
  jupiter_perps:    { roiFormat: 'decimal', winRateFormat: 'decimal' },
  aevo:             { roiFormat: 'decimal', winRateFormat: 'decimal' },
  paradex:          { roiFormat: 'decimal', winRateFormat: 'decimal' },
  kwenta:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  synthetix:        { roiFormat: 'decimal', winRateFormat: 'decimal' },
  mux:              { roiFormat: 'decimal', winRateFormat: 'decimal' },
  uniswap:          { roiFormat: 'decimal', winRateFormat: 'decimal' },
  pancakeswap:      { roiFormat: 'decimal', winRateFormat: 'decimal' },

  // CEX platforms returning decimal ROI
  gateio:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  coinex:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  bingx:            { roiFormat: 'decimal', winRateFormat: 'decimal' },
  toobit:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  btse:             { roiFormat: 'decimal', winRateFormat: 'decimal' },
  cryptocom:        { roiFormat: 'decimal', winRateFormat: 'decimal' },
  pionex:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  mexc:             { roiFormat: 'decimal', winRateFormat: 'decimal' },
  bitget_futures:   { roiFormat: 'decimal', winRateFormat: 'percentage' },
  bitget_spot:      { roiFormat: 'decimal', winRateFormat: 'decimal' },
  kucoin:           { roiFormat: 'decimal', winRateFormat: 'decimal' },
  blofin:           { roiFormat: 'decimal', winRateFormat: 'decimal' },

  // CEX platforms returning percentage ROI
  binance_futures:  { roiFormat: 'percentage', winRateFormat: 'decimal' },
  // binance_spot: REMOVED 2026-03-14
  bybit:            { roiFormat: 'percentage', winRateFormat: 'percentage' },
  bybit_spot:       { roiFormat: 'percentage', winRateFormat: 'percentage' },
  okx_futures:      { roiFormat: 'percentage', winRateFormat: 'percentage' },
  okx_web3:         { roiFormat: 'percentage', winRateFormat: 'percentage' },
  htx_futures:      { roiFormat: 'percentage', winRateFormat: 'percentage' },
  phemex:           { roiFormat: 'percentage', winRateFormat: 'decimal' },
  weex:             { roiFormat: 'percentage', winRateFormat: 'decimal' },
  bitmart:          { roiFormat: 'percentage', winRateFormat: 'percentage' },
  bitunix:          { roiFormat: 'decimal', winRateFormat: 'decimal' },
  btcc:             { roiFormat: 'percentage', winRateFormat: 'percentage' },
  xt:               { roiFormat: 'percentage', winRateFormat: 'percentage' },
  binance_web3:     { roiFormat: 'percentage', winRateFormat: 'percentage' },
  web3_bot:         { roiFormat: 'percentage', winRateFormat: 'percentage' },
  lbank:            { roiFormat: 'percentage', winRateFormat: 'decimal' },
  okx_spot:         { roiFormat: 'percentage', winRateFormat: 'percentage' },
  perpetual_protocol: { roiFormat: 'decimal', winRateFormat: 'decimal' },
  whitebit:         { roiFormat: 'percentage', winRateFormat: 'percentage' },
  bitfinex:         { roiFormat: 'percentage', winRateFormat: 'percentage' },
}

/**
 * Normalize win rate to percentage form (50 = 50%).
 *
 * @param wr - raw win rate value
 * @param format - 'decimal' (0.65 = 65%) or 'percentage' (65 = 65%).
 *                 If omitted, uses legacy heuristic (wr <= 1 → decimal) with a warning.
 */
export function normalizeWinRate(wr: number | null, format?: DataFormat): number | null {
  if (wr == null) return null
  if (format === 'decimal') return wr * 100
  if (format === 'percentage') return wr
  // Legacy heuristic fallback — log warning in non-test environments
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    dataLogger.warn(`[normalizeWinRate] No format specified for value ${wr}, using heuristic. Pass 'decimal' or 'percentage' explicitly.`)
  }
  return wr <= 1 ? wr * 100 : wr
}

/**
 * Normalize ROI to percentage form (50 = 50%).
 *
 * @param rawRoi - raw ROI value from the exchange API
 * @param platformOrFormat - either a platform name (looked up in PLATFORM_FORMAT)
 *                           or an explicit DataFormat ('decimal' | 'percentage').
 *                           If omitted, uses legacy heuristic with a warning.
 */
export function normalizeROI(rawRoi: number | null, platformOrFormat?: string | DataFormat): number | null {
  if (rawRoi == null) return null

  // Resolve format
  let format: DataFormat | undefined
  if (platformOrFormat === 'decimal' || platformOrFormat === 'percentage') {
    format = platformOrFormat
  } else if (platformOrFormat) {
    format = PLATFORM_FORMAT[platformOrFormat]?.roiFormat
  }

  if (format === 'decimal') {
    return rawRoi * 100
  }
  if (format === 'percentage') {
    return rawRoi
  }

  // Legacy heuristic fallback — log warning in non-test environments
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    dataLogger.warn(`[normalizeROI] No format resolved for platform="${platformOrFormat}", value=${rawRoi}. Using heuristic. Pass format explicitly.`)
  }
  return Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi
}

/**
 * Get the win rate format for a platform from PLATFORM_FORMAT.
 * Returns undefined if platform is not found (triggers legacy heuristic in normalizeWinRate).
 */
export function getWinRateFormat(platform: string): DataFormat | undefined {
  return PLATFORM_FORMAT[platform]?.winRateFormat
}
// ============================================
// Verify Endpoint Helper
// ============================================

export interface VerifyResult {
  platform: string
  healthy: boolean
  apiReachable: boolean
  responseFormat: 'valid' | 'invalid' | 'error'
  failureReason?: FailureReason
  latencyMs: number
  checkedAt: string
  details?: string
}

export async function verifyEndpoint(
  platform: string,
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
    validateResponse?: (data: unknown) => boolean
  }
): Promise<VerifyResult> {
  const start = Date.now()
  const checkedAt = new Date().toISOString()

  try {
    const data = await fetchJson(url, {
      method: opts?.method,
      headers: opts?.headers,
      body: opts?.body,
      timeoutMs: opts?.timeoutMs || 10000,
    })

    const latencyMs = Date.now() - start
    const isValid = opts?.validateResponse ? opts.validateResponse(data) : !!data

    return {
      platform,
      healthy: isValid,
      apiReachable: true,
      responseFormat: isValid ? 'valid' : 'invalid',
      failureReason: isValid ? undefined : 'empty_data',
      latencyMs,
      checkedAt,
    }
  } catch (err) {
    const latencyMs = Date.now() - start
    const reason = classifyFetchError(err)

    return {
      platform,
      healthy: false,
      apiReachable: false,
      responseFormat: 'error',
      failureReason: reason,
      latencyMs,
      checkedAt,
      details: err instanceof Error ? err.message : String(err),
    }
  }
}

// cron reset Mon Feb  9 09:11:44 PST 2026
