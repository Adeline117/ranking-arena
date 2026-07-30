/**
 * Token-level Rankings API
 *
 * GET /api/rankings/by-token?token=BTC&period=90D&limit=50&offset=0
 *   Returns traders ranked by PnL on a specific token.
 *
 * GET /api/rankings/by-token?action=popular-tokens
 *   Returns most-traded tokens by trade count from position history.
 *
 * Cache: 1 hour TTL (cold tier)
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { tieredDel, tieredGet, tieredGetOrSet, tieredSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'
import {
  getTokenTraderRankingCacheKey,
  readSealedTokenTraderRankings,
  type TokenTraderRanking,
} from '@/lib/rankings/token-traders'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

export const runtime = 'nodejs'

interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

const POPULAR_TOKENS_CACHE_KEY = 'rankings:popular-tokens'
const POPULAR_TOKENS_LAST_GOOD_KEY = 'rankings:popular-tokens:last-good:v1'
const POPULAR_TOKENS_LAST_GOOD_TTL_SECONDS = 30 * 24 * 60 * 60

function isPopularTokenList(value: unknown): value is PopularToken[] {
  if (!Array.isArray(value) || value.length > 50) return false
  const seen = new Set<string>()
  return value.every((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false
    const token = Reflect.get(row, 'token')
    const tradeCount = Reflect.get(row, 'trade_count')
    const traderCount = Reflect.get(row, 'trader_count')
    const totalPnl = Reflect.get(row, 'total_pnl')
    if (
      typeof token !== 'string' ||
      token !== token.toUpperCase() ||
      !isValidTokenSymbol(token) ||
      seen.has(token) ||
      !Number.isSafeInteger(tradeCount) ||
      Number(tradeCount) < 0 ||
      !Number.isSafeInteger(traderCount) ||
      Number(traderCount) < 0 ||
      typeof totalPnl !== 'number' ||
      !Number.isFinite(totalPnl)
    ) {
      return false
    }
    seen.add(token)
    return true
  })
}

interface TokenRankingResponse {
  traders: TokenTraderRanking[]
  token: string
  period: '7D' | '30D' | '90D'
  total: number
}

function isTokenRankingResponse(
  value: unknown,
  token: string,
  period: TokenRankingResponse['period'],
  limit: number,
  offset: number,
  proofSources: readonly string[]
): value is TokenRankingResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const traders = Reflect.get(value, 'traders')
  const total = Reflect.get(value, 'total')
  if (
    Reflect.get(value, 'token') !== token ||
    Reflect.get(value, 'period') !== period ||
    !Array.isArray(traders) ||
    traders.length > limit ||
    !Number.isSafeInteger(total) ||
    Number(total) < 0 ||
    (traders.length > 0 && Number(total) < offset + traders.length)
  ) {
    return false
  }

  const allowedSources = new Set(proofSources)
  const seen = new Set<string>()
  return traders.every((trader) => {
    if (!trader || typeof trader !== 'object' || Array.isArray(trader)) return false
    const source = Reflect.get(trader, 'source')
    const traderId = Reflect.get(trader, 'source_trader_id')
    if (
      typeof source !== 'string' ||
      !allowedSources.has(source) ||
      !isPublicRankingSourceAllowed(source) ||
      typeof traderId !== 'string' ||
      traderId.length === 0
    ) {
      return false
    }
    const identity = `${source}\u0000${traderId}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

// ── Popular Tokens Handler ──────────────────────────────────────────────────
async function handlePopularTokens(): Promise<NextResponse> {
  try {
    const result = await tieredGetOrSet<PopularToken[]>(
      POPULAR_TOKENS_CACHE_KEY,
      async () => {
        const supabase = getSupabaseAdmin()

        // Use AbortController with 10s timeout
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        try {
          // Use SQL aggregate via RPC — avoids fetching 50K rows into JS memory.
          // MV now filters junk at source (migration 20260709232817); 50 rows are clean.
          const { data, error } = await supabase
            .rpc('get_popular_tokens', { lookback_days: 90, max_tokens: 50 })
            .abortSignal(controller.signal)

          if (error) throw new Error(error.message)
          if (!data || data.length === 0) return []

          return (
            (
              data as Array<{
                token: string
                trade_count: number
                trader_count: number
                total_pnl: number
              }>
            )
              // U1-5: drop junk symbols (HL-107 / XYZ:TSLA / numeric ids) so the
              // token board matches the SSR list, then cap at 50.
              .filter((row) => isValidTokenSymbol(String(row.token ?? '').toUpperCase()))
              .slice(0, 50)
              .map((row) => ({
                token: String(row.token).toUpperCase(),
                trade_count: Number(row.trade_count),
                trader_count: Number(row.trader_count),
                total_pnl: Number(row.total_pnl),
              }))
          )
        } finally {
          clearTimeout(timeout)
        }
      },
      'cold',
      ['rankings', 'popular-tokens']
    )

    if (!isPopularTokenList(result)) {
      await tieredDel(POPULAR_TOKENS_CACHE_KEY)
      throw new Error('popular token cache failed validation')
    }

    // Keep a substantially longer last-known-good copy. Popular-token counts
    // are discovery metadata, so a clearly labelled stale snapshot is safer
    // during a database outage than turning the whole index into a 500. Empty
    // results are legitimate but must not erase the last non-empty snapshot.
    if (result.length > 0) {
      await tieredSet(
        POPULAR_TOKENS_LAST_GOOD_KEY,
        result,
        'cold',
        ['rankings', 'popular-tokens-last-good'],
        {
          redisTtlSeconds: POPULAR_TOKENS_LAST_GOOD_TTL_SECONDS,
          staleWhileRevalidateSeconds: 0,
        }
      )
    }

    return NextResponse.json(
      { tokens: result },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
    )
  } catch (err) {
    logger.error('[popular-tokens]', err instanceof Error ? err : new Error(String(err)))
    let fallbackData: unknown = null
    try {
      fallbackData = (await tieredGet<unknown>(POPULAR_TOKENS_LAST_GOOD_KEY, 'cold')).data
    } catch (fallbackError) {
      logger.warn('[popular-tokens] last-known-good read failed', fallbackError)
    }
    if (isPopularTokenList(fallbackData) && fallbackData.length > 0) {
      return NextResponse.json(
        { tokens: fallbackData, degraded: true },
        {
          headers: {
            'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300',
            'X-Data-Mode': 'last-known-good',
          },
        }
      )
    }
    return NextResponse.json(
      { error: 'Popular token rankings are temporarily unavailable' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Retry-After': '30',
        },
      }
    )
  }
}

// ── Token Rankings Handler ──────────────────────────────────────────────────
const querySchema = z.object({
  token: z
    .string()
    .min(1)
    .max(20)
    .transform((s) => s.toUpperCase()),
  period: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['7D', '30D', '90D']))
    .catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

export async function GET(request: NextRequest) {
  const rl = await checkRateLimit(request, RateLimitPresets.read)
  if (rl) return rl

  const searchParams = request.nextUrl.searchParams

  // Check if this is a popular-tokens request
  if (searchParams.get('action') === 'popular-tokens') {
    return handlePopularTokens()
  }

  const parsed = querySchema.safeParse(Object.fromEntries(searchParams))

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { token, period, limit, offset } = parsed.data

  try {
    const CACHE_KEY = getTokenTraderRankingCacheKey(token, period, limit, offset)
    const supabase = getSupabaseAdmin()
    const fetchSealedEntry = async () => {
      const sealedRead = await readSealedTokenTraderRankings(supabase, token, period, limit, offset)
      return createSealedRankingCacheEntry({
        ...sealedRead,
        value: { ...sealedRead.value, token, period },
      })
    }
    const readAuthorizedCache = async () => {
      const cached = await tieredGetOrSet<unknown>(CACHE_KEY, fetchSealedEntry, 'cold', [
        'rankings',
        'by-token',
      ])
      const entry = parseSealedRankingCacheEntry<TokenRankingResponse>(cached, period)
      const proofSources = entry?.publication.proofs.map((proof) => proof.source) ?? []
      if (
        !entry ||
        !isTokenRankingResponse(entry.value, token, period, limit, offset, proofSources)
      ) {
        return null
      }

      const currentGeneration = await readSealedRankingAuthorityGeneration(
        supabase,
        period,
        async () => null,
        { timeoutMs: 10_000 }
      )
      return currentGeneration.publicationIdentity === entry.publicationIdentity
        ? entry.value
        : null
    }

    let result = await readAuthorizedCache()
    if (!result) {
      await tieredDel(CACHE_KEY)
      result = await readAuthorizedCache()
    }
    if (!result) {
      throw new Error('token ranking cache did not satisfy the sealed publication contract')
    }

    return NextResponse.json(result, {
      headers: {
        // The Redis value is re-authorized against live publication proofs on
        // every request. A CDN copy cannot perform that check, so it must not
        // outlive a cohort cutover as falsely-current token ranking data.
        'Cache-Control': 'private, no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    logger.error('[by-token]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
