// service-layer-exempt: increment_api_key_usage is a custom RPC, not a counter service
/**
 * Public API v3 — Developer-facing API with rate limiting and API key support.
 *
 * GET /api/v3?endpoint=rankings&platform=binance_futures&period=90d&limit=50
 * GET /api/v3?endpoint=trader&platform=binance_futures&trader_key=xxx
 * GET /api/v3?endpoint=search&q=xxx
 *
 * Append &format=csv to a published list endpoint (rankings/search/platforms/
 * bulk) for a downloadable CSV export instead of JSON. History is quarantined
 * and always returns a JSON error without consuming caller quota.
 *
 * Rate limits:
 * - No API key: 100 requests/day per IP
 * - Valid API key: unlimited
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getLeaderboard, getTraderDetail } from '@/lib/data/unified'
import { quarantineLegacyPositionHistory } from '@/lib/data/trader/history-quarantine'
import { LEGACY_METRIC_PUBLICATION_UNAVAILABLE } from '@/lib/data/trader/history-quarantine'
import { mapLeaderboardRow } from '@/lib/data/trader/mappers'
import {
  EXCHANGE_CONFIG,
  DEAD_BLOCKED_PLATFORMS,
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
} from '@/lib/constants/exchanges'
import type { TraderSource } from '@/lib/constants/exchanges'
import type { TradingPeriod } from '@/lib/data/unified'
import { checkRateLimitFull } from '@/lib/utils/rate-limit'
import { apiSuccess, apiError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const log = createLogger('api:v3')

// The public cohort view is intentionally additive while generated Supabase
// types catch up. Keep this narrow read-only bridge local rather than widening
// the generated client or falling back to the retained parent relation.
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
const V3_PUBLIC_SEARCH_PERIOD = '90D'
const V3_PLATFORM_COUNT_PERIOD = '90D'
const PUBLIC_V3_SEARCH_COLUMNS =
  'source,source_trader_id,handle,avatar_url,source_type,roi,pnl,win_rate,max_drawdown,trades_count,followers,copiers,arena_score,rank,computed_at,season_id,profitability_score,risk_control_score,execution_score,score_completeness,metrics_estimated,trader_type,is_outlier'
const PUBLIC_V3_PLATFORM_COUNT_COLUMNS =
  'source,source_trader_id,season_id,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

type V3RankingVisibility = 'partial' | 'unknown'

interface V3HandlerResult {
  data?: unknown
  total?: number
  totalCountIsExact?: boolean
  hasMore?: boolean
  rankingVisibility?: V3RankingVisibility
  rankingVisibilityReason?: string
  historicalMetricPublication?: typeof LEGACY_METRIC_PUBLICATION_UNAVAILABLE
  error?: string
  status?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositivePublishedRank(row: unknown): row is Record<string, unknown> {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function sanitizePublicSearchRows(value: unknown): {
  rows: Record<string, unknown>[]
  integrityCompromised: boolean
} {
  if (!Array.isArray(value)) return { rows: [], integrityCompromised: true }

  const sanitized = sanitizePublicRankingPayload(
    { traders: value, period: V3_PUBLIC_SEARCH_PERIOD },
    { expectedPeriod: V3_PUBLIC_SEARCH_PERIOD }
  ) as { traders?: unknown[] }
  const rows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(isPositivePublishedRank)
    : []

  // A fresh database read from the security-barrier view should be an all-safe
  // cohort; `integrityCompromised` reports any mismatch. Each caller decides
  // what a mismatch means for its response (see handleSearch, handlePlatforms).
  return {
    rows,
    integrityCompromised: rows.length !== value.length,
  }
}

function sanitizeSearchPattern(query: string): string {
  // PostgREST's `or()` syntax treats commas, dots, parentheses, and wildcard
  // characters as grammar. Keep user text literal enough for ILIKE while
  // preserving Unicode handles and wallet fragments.
  return query
    .trim()
    .slice(0, 100)
    .replace(/[\\%_.,()'"`]/g, '')
}

function publicSearchRelevance(row: Record<string, unknown>, query: string): number {
  const handle = typeof row.handle === 'string' ? row.handle.toLowerCase() : ''
  const traderKey =
    typeof row.source_trader_id === 'string' ? row.source_trader_id.toLowerCase() : ''
  const queryLower = query.toLowerCase()
  let relevance = 0

  if (handle === queryLower || traderKey === queryLower) relevance += 10_000
  if (handle.startsWith(queryLower) || traderKey.startsWith(queryLower)) relevance += 1_000
  if (handle.includes(queryLower) || traderKey.includes(queryLower)) relevance += 100

  const arenaScore = typeof row.arena_score === 'number' ? row.arena_score : 0
  return relevance + arenaScore * 0.1
}

function activeV3PlatformSources(): TraderSource[] {
  return ALL_SOURCES.filter(
    (source) => !DEAD_BLOCKED_PLATFORMS.includes(source) && isPublicRankingSourceAllowed(source)
  )
}

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

// Every response contains per-request rate-limit or API-key quota metadata.
// A shared CDN key does not vary safely on those identities, so all v3 payloads
// must remain private even when their underlying ranking data uses Redis.
const PRIVATE_NO_STORE = 'private, no-store, max-age=0, must-revalidate'

function jsonResponse(data: unknown, meta: Record<string, unknown>, status = 200) {
  const res = apiSuccess(data, meta, status)
  res.headers.set('Cache-Control', PRIVATE_NO_STORE)
  res.headers.set('CDN-Cache-Control', 'no-store')
  res.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Credentials', 'false')
  return res
}

function errorResponse(message: string, status: number, code = 'API_ERROR') {
  const res = apiError(code, message, status)
  res.headers.set('Cache-Control', PRIVATE_NO_STORE)
  res.headers.set('CDN-Cache-Control', 'no-store')
  res.headers.set('Vercel-CDN-Cache-Control', 'no-store')
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

/**
 * Flatten an array of homogeneous objects to RFC-4180 CSV. Union of keys
 * (first-row order, extras appended); nested objects/arrays → JSON; null → ''.
 * Used by the `?format=csv` export for data-seeker consumers.
 */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  const escape = (v: unknown): string => {
    if (v == null) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = keys.join(',')
  const body = rows.map((row) => keys.map((k) => escape(row[k])).join(',')).join('\n')
  return `${header}\n${body}`
}

function cleanTraderForApi(trader: Record<string, unknown>): Record<string, unknown> {
  const t = { ...trader }

  // Persist the publication authority's rank. Search/profile results may be
  // unranked, but a page position must never be presented as a global rank.
  t.rank = t.rank != null ? Number(t.rank) : null

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
    return { data: [], totalCountIsExact: false }
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
  if (result.error) {
    return {
      data: [],
      totalCountIsExact: false,
      hasMore: false,
      rankingVisibility: 'unknown' as const,
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }
  const cleaned = result.traders
    .filter((trader) => trader.rank != null)
    .map((trader) => cleanTraderForApi(trader as unknown as Record<string, unknown>))
  return {
    data: cleaned,
    ...(result.totalCountIsExact && result.total != null ? { total: result.total } : {}),
    totalCountIsExact: result.totalCountIsExact,
    hasMore: result.hasMore,
  }
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
    publicProfileHistoryQuarantine: true,
  })
  if (!detail) {
    return { error: 'Trader not found', status: 404 }
  }
  return { data: quarantineLegacyPositionHistory(detail) }
}

async function handleSearch(params: URLSearchParams) {
  // If limit is explicitly 0 or negative, return empty result immediately
  const rawLimit = params.get('limit')
  if (rawLimit != null && Number(rawLimit) <= 0) {
    return { data: [], totalCountIsExact: false }
  }

  const parsed = v3SearchSchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || 'Invalid search parameters', status: 400 }
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const { q, limit, platform } = parsed.data
  if (platform && !isPublicRankingSourceAllowed(platform)) {
    return {
      data: [],
      totalCountIsExact: false,
      rankingVisibility: 'partial' as const,
      rankingVisibilityReason: 'source_not_publicly_rankable',
    }
  }

  const searchPattern = sanitizeSearchPattern(q)
  if (!searchPattern) {
    return {
      data: [],
      totalCountIsExact: false,
      rankingVisibility: 'partial' as const,
      rankingVisibilityReason: 'search_query_not_rankable',
    }
  }

  try {
    // Search identity and ranking fields in the same sealed 90D cohort. Do
    // not route through the legacy fuzzy RPC: it joins the retained raw cohort
    // and can return a rank/score outside the published population.
    let query = supabase
      .from(PUBLIC_RANKED_LEADERBOARD)
      .select(PUBLIC_V3_SEARCH_COLUMNS)
      .eq('season_id', V3_PUBLIC_SEARCH_PERIOD)
      .not('rank', 'is', null)
      .or(`handle.ilike.%${searchPattern}%,source_trader_id.ilike.%${searchPattern}%`)

    if (platform) query = query.eq('source', platform)

    const { data, error } = await query
      .order('arena_score', { ascending: false, nullsFirst: false })
      .order('rank', { ascending: true, nullsFirst: false })
      // Fetch a small score-ordered candidate set, then restore exact/prefix/
      // contains relevance locally without ever synthesizing a rank.
      .limit(limit * 4)

    if (error || !Array.isArray(data)) {
      return {
        data: [],
        totalCountIsExact: false,
        rankingVisibility: 'unknown' as const,
        rankingVisibilityReason: 'public_cohort_unavailable',
      }
    }

    const cohort = sanitizePublicSearchRows(data)
    // Search is a bounded candidate page with no total, so one row that fails
    // the public-ranking proof is dropped (and counted in the log) and the
    // verified matches are still returned; emptying the whole response for it
    // hid every valid match. When no row at all passes there is no verified
    // result to return, and the response stays unverified as before.
    // (handlePlatforms keeps failing closed: a count map built from fewer rows
    // would be a wrong number, not a shorter list.)
    const droppedRows = data.length - cohort.rows.length
    if (droppedRows > 0 && cohort.rows.length === 0) {
      return {
        data: [],
        totalCountIsExact: false,
        rankingVisibility: 'partial' as const,
        rankingVisibilityReason: 'public_cohort_unverified',
      }
    }
    if (droppedRows > 0) {
      log.warn('public search dropped rows that failed public-ranking proof', {
        dropped: droppedRows,
        kept: cohort.rows.length,
      })
    }

    const cleaned = cohort.rows
      .sort(
        (left, right) =>
          publicSearchRelevance(right, searchPattern) -
            publicSearchRelevance(left, searchPattern) || Number(left.rank) - Number(right.rank)
      )
      .slice(0, limit)
      .map((trader) => cleanTraderForApi({ ...mapLeaderboardRow(trader) }))

    // This is a bounded candidate page, not a same-predicate total. Omitting
    // `total` is intentional: a visible page length must not masquerade as
    // the total number of public matching traders.
    return { data: cleaned, totalCountIsExact: false }
  } catch (err) {
    log.warn('public search cohort unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      data: [],
      totalCountIsExact: false,
      rankingVisibility: 'unknown' as const,
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }
}

async function handlePlatforms() {
  const activeSources = activeV3PlatformSources()

  try {
    // A platform count has to remain bound to the current serving head and
    // source-freshness lease. Do not cache this derivative: a cache hit cannot
    // independently prove those authorities are still live.
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from(PUBLIC_RANKED_LEADERBOARD)
      .select(PUBLIC_V3_PLATFORM_COUNT_COLUMNS)
      .eq('season_id', V3_PLATFORM_COUNT_PERIOD)
      .not('rank', 'is', null)
      // Per-platform trader counts are traders with performance in the
      // period, as in get_hero_stats: idle-window rows are not counted.
      .eq('idle_window', false)

    if (error || !Array.isArray(data)) {
      return {
        data: [],
        totalCountIsExact: false,
        rankingVisibility: 'unknown' as const,
        rankingVisibilityReason: 'public_platform_counts_unavailable',
      }
    }

    // The view is the sole row authority, and the same response-boundary
    // sanitizer used by v3 search makes a malformed direct response partial
    // rather than emitting a shortened count map.
    const cohort = sanitizePublicSearchRows(data)
    if (cohort.integrityCompromised) {
      return {
        data: [],
        totalCountIsExact: false,
        rankingVisibility: 'partial' as const,
        rankingVisibilityReason: 'public_cohort_unverified',
      }
    }

    const activeSourceSet = new Set<string>(activeSources)
    const countMap: Record<string, number> = {}
    for (const row of cohort.rows) {
      if (
        typeof row.source !== 'string' ||
        !activeSourceSet.has(row.source) ||
        !isPublicRankingSourceAllowed(row.source)
      ) {
        return {
          data: [],
          totalCountIsExact: false,
          rankingVisibility: 'partial' as const,
          rankingVisibilityReason: 'public_cohort_unverified',
        }
      }
      countMap[row.source] = (countMap[row.source] || 0) + 1
    }

    const platforms = activeSources.flatMap((source) => {
      const traderCount = countMap[source]
      // Absent from the sealed response is deliberately not rendered as a
      // platform with a fake zero count.
      if (traderCount === undefined) return []
      const config = EXCHANGE_CONFIG[source]
      return [
        {
          key: source,
          name: config?.name ?? source,
          type: config?.sourceType ?? 'unknown',
          traderCount,
        },
      ]
    })

    if (platforms.length === 0) {
      return {
        data: [],
        totalCountIsExact: false,
        rankingVisibility: 'unknown' as const,
        rankingVisibilityReason: 'public_platform_counts_unavailable',
      }
    }

    return { data: platforms, total: platforms.length, totalCountIsExact: true }
  } catch (err) {
    log.warn('public platform cohort unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      data: [],
      totalCountIsExact: false,
      rankingVisibility: 'unknown' as const,
      rankingVisibilityReason: 'public_platform_counts_unavailable',
    }
  }
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
  if (result.error) {
    return {
      data: [],
      totalCountIsExact: false,
      hasMore: false,
      rankingVisibility: 'unknown' as const,
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }
  const cleaned = result.traders
    .filter((trader) => trader.rank != null)
    .map((trader) => cleanTraderForApi(trader as unknown as Record<string, unknown>))
  return {
    data: cleaned,
    ...(result.totalCountIsExact && result.total != null ? { total: result.total } : {}),
    totalCountIsExact: result.totalCountIsExact,
    hasMore: result.hasMore,
  }
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

  // History has no publication proof. Validate its public shape, then fail
  // before API-key usage or the free-tier counter can be incremented. CSV is
  // deliberately ignored so an unavailable response cannot lose its metadata.
  if (endpoint === 'history') {
    const historyParsed = v3HistorySchema.safeParse(Object.fromEntries(params))
    if (!historyParsed.success) {
      return errorResponse('Missing required params: platform, trader_key', 400)
    }
    return errorResponse(
      'Trader history is not published: snapshot provenance is unverified',
      503,
      'TRADER_HISTORY_NOT_PUBLISHED'
    )
  }

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
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': PRIVATE_NO_STORE,
            'Retry-After': '86400',
          },
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
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': PRIVATE_NO_STORE,
            'Retry-After': '86400',
          },
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
    let result: V3HandlerResult

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

    // CSV has no reliable place for an unavailable-cohort state. Preserve the
    // JSON envelope when rank/count authority is partial or unknown instead of
    // turning it into a blank file that consumers may interpret as zero.
    // Otherwise only array payloads are exportable; single-object endpoints
    // (trader) fall through to JSON.
    if (
      params.get('format') === 'csv' &&
      !result.rankingVisibility &&
      !result.historicalMetricPublication &&
      Array.isArray(result.data)
    ) {
      const csv = toCsv(result.data as Record<string, unknown>[])
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="arena-${endpoint}.csv"`,
          'Cache-Control': PRIVATE_NO_STORE,
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    return jsonResponse(result.data, {
      ...rateLimitMeta,
      ...(result.total != null ? { total: result.total } : {}),
      ...(result.totalCountIsExact !== undefined
        ? { total_count_is_exact: result.totalCountIsExact }
        : {}),
      ...(result.hasMore !== undefined ? { has_more: result.hasMore } : {}),
      ...(result.rankingVisibility ? { ranking_visibility: result.rankingVisibility } : {}),
      ...(result.rankingVisibilityReason
        ? { ranking_visibility_reason: result.rankingVisibilityReason }
        : {}),
      ...(result.historicalMetricPublication
        ? { historical_metric_publication: result.historicalMetricPublication }
        : {}),
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
