/**
 * Near-real-time rankings API
 *
 * Reads one stable sealed leaderboard_ranks generation and caches the complete
 * proof envelope. The legacy Redis sorted set remains disabled for public reads
 * until it carries the same publication identity as its rows.
 *
 * GET /api/rankings/live?period=90D&limit=50&offset=0
 *
 * Response format matches /api/traders for frontend compatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  filterPublicRankingRows,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const logger = createLogger('rankings-live')

// ── Input validation schema ──────────────────────────────────────────────────
const liveRankingsSchema = z.object({
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
  const rawParams = Object.fromEntries(searchParams)
  const parsed = liveRankingsSchema.safeParse(rawParams)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { period, limit, offset } = parsed.data

  try {
    const supabase = getSupabaseAdmin()
    // Dedicated read-through cache: generic live pages have no generation proof.
    const cacheKey = publicRankingCacheKey(`rankings:live:sealed-v6:${period}:${limit}:${offset}`)
    const cached = await tieredGet<unknown>(cacheKey, 'hot')
    const cachedEntry = parseSealedRankingCacheEntry<Record<string, unknown>>(cached.data, period)
    if (cachedEntry) {
      try {
        const currentGeneration = await readSealedRankingAuthorityGeneration(
          supabase,
          period,
          async () => null,
          { timeoutMs: 10_000 }
        )
        if (currentGeneration.publicationIdentity === cachedEntry.publicationIdentity) {
          const response = NextResponse.json(sanitizePublicRankingSourcePayload(cachedEntry.value))
          // Edge-cache the live ranking briefly so a 万级 airdrop spike is absorbed by
          // the Vercel CDN instead of every client invoking the function.
          // Keyed by full URL (period/limit/offset), no auth personalization.
          response.headers.set('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30')
          response.headers.set('X-Cache', 'HIT')
          response.headers.set('X-Cache-Layer', cached.layer || 'unknown')
          return response
        }
      } catch (error) {
        // A sealed envelope proves only that this was once a valid generation.
        // If live authority cannot be re-established, continue to the strict DB
        // read instead of exposing the cached page as current.
        logger.warn(
          '[rankings-live] Cache generation validation failed:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    // The legacy sorted set has no publication/cohort manifest. Its score order
    // can belong to a prior generation while DB enrichment belongs to the next,
    // so public reads stay on the sealed database generation until that store
    // carries and validates the same proof identity.
    const sealedRead = await readSealedRankingAuthorityGeneration(
      supabase,
      period,
      async (publication) => {
        const authoritySources = publication.proofs.map((proof) => proof.source)
        let query = supabase
          .from('leaderboard_ranks')
          .select(
            'source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, source, source_type, avatar_url, arena_score, rank, profitability_score, risk_control_score, execution_score, trading_style, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type'
          )
          .eq('season_id', period)
          .in('source', authoritySources)
          .filter('rank_publication_id', 'eq', publication.scoreCohortId)

        if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
          query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
        }

        const result = await query
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('rank', { ascending: true })
          .range(offset, offset + limit - 1)
        if (result.error) {
          throw new Error(`live ranking query failed: ${result.error.message}`)
        }
        return (result.data ?? []) as Array<Record<string, unknown>>
      },
      { timeoutMs: 10_000 }
    )

    // Filter the database-native source before mapping. This prevents a legacy
    // aggregator identity from being relabelled as an active canonical source.
    const rawRows = sealedRead.value
    const publicRows = filterPublicRankingRows(rawRows, (row) => row.source)
    const removedNonPublicRows = publicRows.length !== rawRows.length
    const traders = publicRows.map((row) => ({
      id: row.source_trader_id as string,
      handle: (row.handle as string) || null,
      source: row.source as string,
      source_type: row.source_type as string,
      arena_score: row.arena_score != null ? Number(row.arena_score) : 0,
      rank: Number(row.rank),
      roi: row.roi != null ? Number(row.roi) : 0,
      pnl: row.pnl != null ? Number(row.pnl) : null,
      win_rate: row.win_rate != null ? Number(row.win_rate) : null,
      max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
      trades_count: row.trades_count != null ? Number(row.trades_count) : null,
      followers: row.followers != null ? Number(row.followers) : null,
      avatar_url: row.avatar_url as string | null,
      profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
      risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
      execution_score: row.execution_score != null ? Number(row.execution_score) : null,
      trading_style: (row.trading_style as string) || null,
      sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
      trader_type: (row.trader_type as string) || null,
      is_bot:
        row.source === 'web3_bot' ||
        row.trader_type === 'bot' ||
        row.trader_type === 'suspected_bot',
    }))

    const publishedTotal = sealedRead.publication.proofs.reduce(
      (sum, proof) => sum + proof.published_rank_count,
      0
    )
    // If a proxy violates the source fence, fail closed to the finite safe page
    // rather than publishing a proof total beside an untrusted page.
    const totalCount = removedNonPublicRows ? traders.length : publishedTotal
    const responseBody = sanitizePublicRankingSourcePayload({
      traders,
      total: totalCount,
      totalCount,
      period,
      source: 'database_sealed',
      hasMore: !removedNonPublicRows && offset + limit < totalCount,
    })

    const safeRead = { ...sealedRead, value: responseBody }
    tieredSet(cacheKey, createSealedRankingCacheEntry(safeRead), 'hot', [
      'rankings',
      `live:${period}`,
    ]).catch((err) => {
      logger.warn(
        '[rankings-live] Cache write failed:',
        err instanceof Error ? err.message : String(err)
      )
    })

    const response = NextResponse.json(responseBody)
    // Edge-cache the live ranking briefly so a 万级 airdrop spike is absorbed by
    // the Vercel CDN instead of every client invoking the function.
    // Keyed by full URL (period/limit/offset), no auth personalization.
    response.headers.set('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30')
    response.headers.set('X-Cache', 'MISS')
    return response
  } catch (error) {
    logger.error('[rankings-live] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
