// service-layer-exempt: increment_api_key_usage is a custom RPC, not a counter service
/**
 * Public API v3 — Developer-facing API with rate limiting and API key support.
 *
 * GET /api/v3?endpoint=rankings&platform=binance_futures&period=90d&limit=50
 * GET /api/v3?endpoint=trader&platform=binance_futures&trader_key=xxx
 * GET /api/v3?endpoint=search&q=xxx
 *
 * Rate limits:
 * - No API key: 100 requests/day per IP
 * - Valid API key: unlimited
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLeaderboard, getTraderDetail, searchTraders } from '@/lib/data/unified'
import {
  EXCHANGE_CONFIG,
  DEAD_BLOCKED_PLATFORMS,
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
} from '@/lib/constants/exchanges'
import type { TradingPeriod } from '@/lib/data/unified'
import { checkRateLimitFull } from '@/lib/utils/rate-limit'
import { apiSuccess, apiError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'edge'

const log = createLogger('api:v3')

// ---------------------------------------------------------------------------
// API Key validation
// ---------------------------------------------------------------------------

const VALID_API_KEYS = new Set(
  (process.env.API_V3_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
)

interface ApiKeyResult {
  valid: boolean
  allowed: boolean
  remaining: number | null
  dailyLimit: number
}

async function validateAndTrackApiKey(key: string): Promise<ApiKeyResult> {
  // Check env-based keys first (fast path — no usage tracking)
  if (VALID_API_KEYS.has(key)) {
    return { valid: true, allowed: true, remaining: null, dailyLimit: 0 }
  }

  // Database keys: validate + increment usage atomically
  try {
    const supabase = getSupabaseAdmin() as SupabaseClient
    const { data, error } = await supabase.rpc('increment_api_key_usage', { p_key: key })

    if (error || !data || data.length === 0) {
      return { valid: false, allowed: false, remaining: 0, dailyLimit: 0 }
    }

    const row = data[0]
    return {
      valid: true,
      allowed: row.allowed,
      remaining: row.daily_limit === 0 ? null : row.remaining,
      dailyLimit: row.daily_limit,
    }
  } catch {
    return { valid: false, allowed: false, remaining: 0, dailyLimit: 0 }
  }
}

// ---------------------------------------------------------------------------
// Redis-backed daily rate limiter (100 requests/day per IP)
// Uses the existing checkRateLimit infrastructure backed by Upstash Redis.
// Falls back to in-process memory when Redis is unavailable (dev/cold start).
// ---------------------------------------------------------------------------

const FREE_DAILY_LIMIT = 100
// 24 hours in seconds
const DAILY_WINDOW_SECONDS = 86400

async function checkDailyLimit(
  request: NextRequest
): Promise<{ allowed: boolean; remaining: number }> {
  const result = await checkRateLimitFull(request, {
    requests: FREE_DAILY_LIMIT,
    window: DAILY_WINDOW_SECONDS,
    prefix: 'v3_daily',
  })

  if (result.response !== null) {
    // Rate limited
    return { allowed: false, remaining: 0 }
  }

  const remaining = result.meta?.remaining ?? FREE_DAILY_LIMIT - 1
  return { allowed: true, remaining }
}

// ---------------------------------------------------------------------------
// Response helpers (use standard apiSuccess/apiError + CORS headers)
// ---------------------------------------------------------------------------

const _CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
}

// Per-endpoint cache policies:
//   rankings → 5 min fresh, 10 min stale (data refreshes every ~5 min via cron)
//   trader   → 5 min fresh, 10 min stale (same cadence as rankings)
//   search   → 1 min fresh, 5 min stale  (needs fresher results for new traders)
const CACHE_POLICY: Record<string, string> = {
  rankings: 'public, s-maxage=300, stale-while-revalidate=600',
  trader: 'public, s-maxage=300, stale-while-revalidate=600',
  search: 'public, s-maxage=60, stale-while-revalidate=300',
  platforms: 'public, s-maxage=3600, stale-while-revalidate=7200',
  history: 'public, s-maxage=300, stale-while-revalidate=600',
  bulk: 'public, s-maxage=300, stale-while-revalidate=600',
}

function jsonResponse(data: unknown, meta: Record<string, unknown>, status = 200) {
  const endpoint = (meta.endpoint as string) || ''
  const res = apiSuccess(data, meta, status)
  res.headers.set(
    'Cache-Control',
    CACHE_POLICY[endpoint] || 'public, s-maxage=60, stale-while-revalidate=120'
  )
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Credentials', 'false')
  return res
}

function errorResponse(message: string, status: number) {
  const res = apiError('API_ERROR', message, status)
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Credentials', 'false')
  return res
}

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

const v3RankingsSchema = z.object({
  platform: z.string().max(50).optional(),
  period: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['7D', '30D', '90D']))
    .catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

const v3TraderSchema = z.object({
  platform: z.string().min(1).max(50),
  trader_key: z.string().min(1).max(200),
})

const v3SearchSchema = z.object({
  q: z
    .string({ error: "Missing required query parameter 'q'" })
    .min(2, 'Query param "q" must be at least 2 characters')
    .max(200),
  limit: z.coerce.number().int().min(1).max(100).catch(20),
  platform: z.string().max(50).optional(),
})

const v3HistorySchema = z.object({
  platform: z.string().min(1).max(50),
  trader_key: z.string().min(1).max(200),
  days: z.coerce.number().int().min(1).max(90).catch(30),
})

const v3BulkSchema = z.object({
  period: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['7D', '30D', '90D']))
    .catch('90D'),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
})

const v3MainSchema = z.object({
  endpoint: z.enum(['rankings', 'trader', 'search', 'platforms', 'history', 'bulk']),
})

// ---------------------------------------------------------------------------
// Post-processing: clean up API output for consumers
// ---------------------------------------------------------------------------

function shortenAddr(addr: string, chars = 4): string {
  if (!addr || addr.length < 2 * chars + 2) return addr
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`
}

function cleanTraderForApi(
  trader: Record<string, unknown>,
  idx: number,
  offset: number
): Record<string, unknown> {
  const t = { ...trader }

  // 1. Sequential rank based on position in result set (not DB global rank)
  t.rank = offset + idx + 1

  // 2. Handle fallback: use shortened address for DEX wallet addresses
  if (!t.handle && typeof t.traderKey === 'string') {
    const key = t.traderKey as string
    if (key.startsWith('0x') || key.startsWith('dydx1')) {
      t.handle = shortenAddr(key)
    }
  }

  // 3. Followers/copiers: null for DEX platforms (not 0)
  const sourceType = SOURCE_TYPE_MAP[t.platform as string]
  if (sourceType === 'web3') {
    if (t.followers === 0) t.followers = null
    if (t.copiers === 0) t.copiers = null
  }

  return t
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRankings(params: URLSearchParams) {
  // If limit is explicitly 0 or negative, return empty result immediately
  // (Zod .catch(50) would silently fall back to 50 — that's misleading)
  const rawLimit = params.get('limit')
  if (rawLimit != null && Number(rawLimit) <= 0) {
    return { data: [], total: 0 }
  }

  const parsed = v3RankingsSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Invalid parameters', status: 400 }
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const { platform, period, limit, offset } = parsed.data
  const result = await getLeaderboard(supabase, {
    platform,
    period: period as TradingPeriod,
    limit,
    offset,
  })
  const cleaned = result.traders.map((t, i) =>
    cleanTraderForApi(t as unknown as Record<string, unknown>, i, offset)
  )
  return { data: cleaned, total: result.total }
}

async function handleTrader(params: URLSearchParams) {
  const parsed = v3TraderSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Missing required params: platform, trader_key', status: 400 }
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const detail = await getTraderDetail(supabase, {
    platform: parsed.data.platform,
    traderKey: parsed.data.trader_key,
  })
  if (!detail) {
    return { error: 'Trader not found', status: 404 }
  }
  return { data: detail }
}

async function handleSearch(params: URLSearchParams) {
  // If limit is explicitly 0 or negative, return empty result immediately
  const rawLimit = params.get('limit')
  if (rawLimit != null && Number(rawLimit) <= 0) {
    return { data: [], total: 0 }
  }

  const parsed = v3SearchSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || 'Invalid search parameters', status: 400 }
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const { q, limit, platform } = parsed.data
  const traders = await searchTraders(supabase, { query: q, limit, platform })
  const cleaned = traders.map((t, i) =>
    cleanTraderForApi(t as unknown as Record<string, unknown>, i, 0)
  )
  return { data: cleaned, total: cleaned.length }
}

async function handlePlatforms() {
  const activeSources = ALL_SOURCES.filter((s) => !DEAD_BLOCKED_PLATFORMS.includes(s))

  const supabase = getSupabaseAdmin() as SupabaseClient

  // Get trader counts and last updated per platform
  const { data: counts } = await supabase.from('leaderboard_ranks').select('source')

  const countMap: Record<string, number> = {}
  for (const row of counts ?? []) {
    countMap[row.source] = (countMap[row.source] || 0) + 1
  }

  const platforms = activeSources
    .map((source) => {
      const config = EXCHANGE_CONFIG[source]
      return {
        key: source,
        name: config?.name ?? source,
        type: config?.sourceType ?? 'unknown',
        traderCount: countMap[source] ?? 0,
      }
    })
    .filter((p) => p.traderCount > 0)

  return { data: platforms, total: platforms.length }
}

async function handleHistory(params: URLSearchParams) {
  const parsed = v3HistorySchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Missing required params: platform, trader_key', status: 400 }
  }

  const { platform, trader_key, days } = parsed.data
  const since = new Date()
  since.setDate(since.getDate() - days)

  const supabase = getSupabaseAdmin() as SupabaseClient
  const { data, error } = await supabase
    .from('trader_daily_snapshots')
    .select('date, roi, pnl, daily_return_pct, win_rate, max_drawdown, followers, trades_count')
    .eq('platform', platform)
    .eq('trader_key', trader_key)
    .gte('date', since.toISOString().slice(0, 10))
    .order('date', { ascending: true })
    .limit(days)

  if (error) {
    return { error: 'Failed to fetch history', status: 500 }
  }

  if (!data || data.length === 0) {
    return { error: 'No history found for this trader', status: 404 }
  }

  return { data, total: data.length }
}

async function handleBulk(params: URLSearchParams) {
  const parsed = v3BulkSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Invalid parameters', status: 400 }
  }

  const { period, limit } = parsed.data
  const supabase = getSupabaseAdmin() as SupabaseClient
  const result = await getLeaderboard(supabase, {
    period: period as TradingPeriod,
    limit,
    offset: 0,
  })
  const cleaned = result.traders.map((t, i) =>
    cleanTraderForApi(t as unknown as Record<string, unknown>, i, 0)
  )
  return { data: cleaned, total: result.total }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const endpointParsed = v3MainSchema.safeParse(Object.fromEntries(params))

  if (!endpointParsed.success) {
    return errorResponse(
      'Missing or invalid "endpoint" param. Valid values: rankings, trader, search, platforms, history, bulk',
      400
    )
  }

  const endpoint = endpointParsed.data.endpoint

  // --- Auth & rate limiting ---
  const apiKey = request.headers.get('x-api-key')
  let isAuthenticated = false
  let creditsRemaining: number | null = null
  let keyDailyLimit = 0

  if (apiKey) {
    const keyResult = await validateAndTrackApiKey(apiKey)
    if (!keyResult.valid) {
      return errorResponse('Invalid API key', 401)
    }
    if (!keyResult.allowed) {
      return NextResponse.json(
        {
          data: null,
          meta: {
            error: 'API key daily limit exceeded. Upgrade your plan for higher limits.',
            credits_remaining: 0,
            rate_limit: { daily_limit: keyResult.dailyLimit, remaining: 0 },
            docs: '/api-docs',
          },
        },
        {
          status: 429,
          headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '86400' },
        }
      )
    }
    isAuthenticated = true
    creditsRemaining = keyResult.remaining
    keyDailyLimit = keyResult.dailyLimit
  } else {
    // Free tier: 100/day per IP — backed by Redis (survives cold starts)
    const { allowed, remaining } = await checkDailyLimit(request)
    creditsRemaining = remaining

    if (!allowed) {
      return NextResponse.json(
        {
          data: null,
          meta: {
            error:
              'Daily rate limit exceeded (100 requests/day). Get an API key for unlimited access.',
            credits_remaining: 0,
            rate_limit: { daily_limit: FREE_DAILY_LIMIT, remaining: 0 },
            docs: '/api-docs',
          },
        },
        {
          status: 429,
          headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '86400' },
        }
      )
    }
  }

  const rateLimitMeta = isAuthenticated
    ? keyDailyLimit === 0
      ? { rate_limit: { plan: 'api_key', unlimited: true } }
      : { rate_limit: { plan: 'api_key', daily_limit: keyDailyLimit, remaining: creditsRemaining } }
    : {
        credits_remaining: creditsRemaining,
        rate_limit: { daily_limit: FREE_DAILY_LIMIT, remaining: creditsRemaining },
      }

  // --- Route to handler ---
  try {
    let result: { data?: unknown; total?: number; error?: string; status?: number }

    switch (endpoint) {
      case 'rankings':
        result = await handleRankings(params)
        break
      case 'trader':
        result = await handleTrader(params)
        break
      case 'search':
        result = await handleSearch(params)
        break
      case 'platforms':
        result = await handlePlatforms()
        break
      case 'history':
        result = await handleHistory(params)
        break
      case 'bulk':
        result = await handleBulk(params)
        break
      default:
        return errorResponse(
          `Unknown endpoint "${endpoint}". Valid values: rankings, trader, search`,
          400
        )
    }

    if (result.error) {
      return errorResponse(result.error, result.status || 400)
    }

    return jsonResponse(result.data, {
      ...rateLimitMeta,
      ...(result.total != null ? { total: result.total } : {}),
      endpoint,
      version: 'v3',
    })
  } catch (err) {
    // Never expose internal error details to API consumers
    if (err instanceof Error) {
      log.error(`${endpoint} error`, { error: err.message })
    }
    return errorResponse('Internal server error', 500)
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-API-Key, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}
