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
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getLeaderboard, getTraderDetail, searchTraders } from '@/lib/data/unified'
import type { TradingPeriod } from '@/lib/data/unified'
import { getIdentifier } from '@/lib/utils/rate-limit'

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
// In-memory daily rate limiter (per IP, resets at midnight UTC)
// ---------------------------------------------------------------------------

const FREE_DAILY_LIMIT = 100
const dailyCounts = new Map<string, { count: number; date: string }>()

function checkDailyLimit(identifier: string): { allowed: boolean; remaining: number } {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const entry = dailyCounts.get(identifier)

  // Periodic cleanup — remove stale entries (different date)
  if (Math.random() < 0.01) {
    for (const [k, v] of dailyCounts.entries()) {
      if (v.date !== today) dailyCounts.delete(k)
    }
  }

  if (!entry || entry.date !== today) {
    dailyCounts.set(identifier, { count: 1, date: today })
    return { allowed: true, remaining: FREE_DAILY_LIMIT - 1 }
  }

  if (entry.count >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 }
  }

  entry.count++
  return { allowed: true, remaining: FREE_DAILY_LIMIT - entry.count }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, meta: Record<string, unknown>, status = 200) {
  return NextResponse.json({ data, meta }, {
    status,
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { data: null, meta: { error: message } },
    { status, headers: { 'Access-Control-Allow-Origin': '*' } }
  )
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRankings(params: URLSearchParams) {
  const supabase = getSupabaseAdmin()
  const platform = params.get('platform') || undefined
  const rawPeriod = (params.get('period') || '90D').toUpperCase()
  const period = (['7D', '30D', '90D'].includes(rawPeriod) ? rawPeriod : '90D') as TradingPeriod
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(params.get('offset') || '0', 10) || 0, 0)

  const result = await getLeaderboard(supabase, { platform, period, limit, offset })
  return { data: result.traders, total: result.total }
}

async function handleTrader(params: URLSearchParams) {
  const platform = params.get('platform')
  const traderKey = params.get('trader_key')
  if (!platform || !traderKey) {
    return { error: 'Missing required params: platform, trader_key', status: 400 }
  }

  const supabase = getSupabaseAdmin()
  const detail = await getTraderDetail(supabase, { platform, traderKey })
  if (!detail) {
    return { error: 'Trader not found', status: 404 }
  }
  return { data: detail }
}

async function handleSearch(params: URLSearchParams) {
  const q = params.get('q')
  if (!q || q.length < 2) {
    return { error: 'Query param "q" must be at least 2 characters', status: 400 }
  }

  const supabase = getSupabaseAdmin()
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10) || 20, 1), 100)
  const platform = params.get('platform') || undefined
  const traders = await searchTraders(supabase, { query: q, limit, platform })
  return { data: traders, total: traders.length }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const endpoint = params.get('endpoint')

  if (!endpoint) {
    return errorResponse('Missing "endpoint" param. Valid values: rankings, trader, search', 400)
  }

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
    // Free tier: 100/day per IP
    const identifier = getIdentifier(request)
    const { allowed, remaining } = checkDailyLimit(identifier)
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
    const message = err instanceof Error ? err.message : 'Internal server error'
    return errorResponse(message, 500)
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
