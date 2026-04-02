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
import { getLeaderboard, getTraderDetail, searchTraders } from '@/lib/data/unified'
import type { TradingPeriod } from '@/lib/data/unified'
import { checkRateLimitFull } from '@/lib/utils/rate-limit'
import { apiSuccess, apiError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:v3')

// ---------------------------------------------------------------------------
// API Key validation
// ---------------------------------------------------------------------------

const VALID_API_KEYS = new Set(
  (process.env.API_V3_KEYS || '').split(',').map(k => k.trim()).filter(Boolean)
)

async function validateApiKey(key: string): Promise<boolean> {
  // Check env-based keys first (fast path)
  if (VALID_API_KEYS.has(key)) return true

  // Check database api_keys table (if it exists)
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('api_keys')
      .select('id')
      .eq('key', key)
      .eq('active', true)
      .maybeSingle()
    return !!data
  } catch {
    // Table may not exist yet — only env keys work
    return false
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

function jsonResponse(data: unknown, meta: Record<string, unknown>, status = 200) {
  const res = apiSuccess(data, meta, status)
  res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
  res.headers.set('Access-Control-Allow-Origin', '*')
  return res
}

function errorResponse(message: string, status: number) {
  const res = apiError('API_ERROR', message, status)
  res.headers.set('Access-Control-Allow-Origin', '*')
  return res
}

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

const v3RankingsSchema = z.object({
  platform: z.string().max(50).optional(),
  period: z.string().toUpperCase().pipe(z.enum(['7D', '30D', '90D'])).catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

const v3TraderSchema = z.object({
  platform: z.string().min(1).max(50),
  trader_key: z.string().min(1).max(200),
})

const v3SearchSchema = z.object({
  q: z.string({ error: "Missing required query parameter 'q'" }).min(2, 'Query param "q" must be at least 2 characters').max(200),
  limit: z.coerce.number().int().min(1).max(100).catch(20),
  platform: z.string().max(50).optional(),
})

const v3MainSchema = z.object({
  endpoint: z.enum(['rankings', 'trader', 'search']),
})

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRankings(params: URLSearchParams) {
  const parsed = v3RankingsSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Invalid parameters', status: 400 }
  }

  const supabase = getSupabaseAdmin()
  const { platform, period, limit, offset } = parsed.data
  const result = await getLeaderboard(supabase, { platform, period: period as TradingPeriod, limit, offset })
  return { data: result.traders, total: result.total }
}

async function handleTrader(params: URLSearchParams) {
  const parsed = v3TraderSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: 'Missing required params: platform, trader_key', status: 400 }
  }

  const supabase = getSupabaseAdmin()
  const detail = await getTraderDetail(supabase, { platform: parsed.data.platform, traderKey: parsed.data.trader_key })
  if (!detail) {
    return { error: 'Trader not found', status: 404 }
  }
  return { data: detail }
}

async function handleSearch(params: URLSearchParams) {
  const parsed = v3SearchSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || 'Invalid search parameters', status: 400 }
  }

  const supabase = getSupabaseAdmin()
  const { q, limit, platform } = parsed.data
  const traders = await searchTraders(supabase, { query: q, limit, platform })
  return { data: traders, total: traders.length }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const endpointParsed = v3MainSchema.safeParse(Object.fromEntries(params))

  if (!endpointParsed.success) {
    return errorResponse('Missing or invalid "endpoint" param. Valid values: rankings, trader, search', 400)
  }

  const endpoint = endpointParsed.data.endpoint

  // --- Auth & rate limiting ---
  const apiKey = request.headers.get('x-api-key')
  let isAuthenticated = false
  let creditsRemaining: number | null = null

  if (apiKey) {
    isAuthenticated = await validateApiKey(apiKey)
    if (!isAuthenticated) {
      return errorResponse('Invalid API key', 401)
    }
    // Authenticated: unlimited
    creditsRemaining = null
  } else {
    // Free tier: 100/day per IP — backed by Redis (survives cold starts)
    const { allowed, remaining } = await checkDailyLimit(request)
    creditsRemaining = remaining

    if (!allowed) {
      return NextResponse.json(
        {
          data: null,
          meta: {
            error: 'Daily rate limit exceeded (100 requests/day). Get an API key for unlimited access.',
            credits_remaining: 0,
            rate_limit: { daily_limit: FREE_DAILY_LIMIT, remaining: 0 },
            docs: '/api-docs',
          },
        },
        {
          status: 429,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Retry-After': '86400',
          },
        }
      )
    }
  }

  const rateLimitMeta = isAuthenticated
    ? { rate_limit: { plan: 'api_key', unlimited: true } }
    : { credits_remaining: creditsRemaining, rate_limit: { daily_limit: FREE_DAILY_LIMIT, remaining: creditsRemaining } }

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
      default:
        return errorResponse(`Unknown endpoint "${endpoint}". Valid values: rankings, trader, search`, 400)
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
