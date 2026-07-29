/**
 * Platform Statistics API
 *
 * GET /api/rankings/platform-stats
 *
 * Returns aggregated per-platform statistics from leaderboard_ranks (90D).
 * Includes trader count, average/median arena score, average ROI per platform.
 *
 * Response: { platforms: PlatformStat[], season: '90D' }
 * Redis cache: 1 hour per sealed proof identity. CDN cache: 5 minutes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { getSupabaseAdmin } from '@/lib/api'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { logger } from '@/lib/logger'
import {
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import {
  readSealedRankingAuthorityGeneration,
  sealedRankingPublicationIdentity,
} from '@/lib/rankings/read-sealed-ranking-generation'

// The response is briefly CDN-cacheable; Redis entries are keyed by the exact
// sealed proof identity so a new publication cannot inherit an older aggregate.
export const runtime = 'nodejs'

interface PlatformStat {
  platform: string
  traderCount: number
  avgScore: number
  avgRoi: number
  medianScore: number
  avgWinRate: number | null
}

function finiteNumber(value: unknown, label: string): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new Error(`platform stats ${label} must be numeric`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`platform stats ${label} must be finite`)
  }
  return parsed
}

function parsePlatformStats(input: unknown, allowedSources: readonly string[]): PlatformStat[] {
  if (!Array.isArray(input)) {
    throw new Error('platform stats RPC returned no row array')
  }
  const allowed = new Set(allowedSources)
  const seen = new Set<string>()

  return input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`platform stats row ${index} is malformed`)
    }
    const row = value as Record<string, unknown>
    if (
      typeof row.platform !== 'string' ||
      !allowed.has(row.platform) ||
      !isPublicRankingSourceAllowed(row.platform) ||
      seen.has(row.platform)
    ) {
      throw new Error(`platform stats row ${index} has an unauthorized platform`)
    }
    seen.add(row.platform)

    const traderCount = finiteNumber(row.trader_count, `row ${index} trader_count`)
    const avgScore = finiteNumber(row.avg_score, `row ${index} avg_score`)
    const avgRoi = finiteNumber(row.avg_roi, `row ${index} avg_roi`)
    const medianScore = finiteNumber(row.median_score, `row ${index} median_score`)
    const avgWinRate =
      row.avg_win_rate === null ? null : finiteNumber(row.avg_win_rate, `row ${index} avg_win_rate`)
    if (!Number.isSafeInteger(traderCount) || traderCount <= 0) {
      throw new Error(`platform stats row ${index} trader_count must be positive`)
    }
    if (avgScore < 0 || avgScore > 100 || medianScore < 0 || medianScore > 100) {
      throw new Error(`platform stats row ${index} score is outside 0-100`)
    }
    if (avgWinRate !== null && (avgWinRate < 0 || avgWinRate > 100)) {
      throw new Error(`platform stats row ${index} avg_win_rate is outside 0-100`)
    }

    return {
      platform: row.platform,
      traderCount,
      avgScore,
      avgRoi,
      medianScore,
      avgWinRate,
    }
  })
}

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl

    const supabase = getSupabaseAdmin()
    const sealedStats = await readSealedRankingAuthorityGeneration(
      supabase,
      '90D',
      async (publication) => {
        const allowedSources = publication.proofs
          .map((proof) => proof.source)
          .filter(isPublicRankingSourceAllowed)
        if (allowedSources.length === 0) {
          throw new Error('platform stats publication has no public sources')
        }
        const proofFingerprint = createHash('sha256')
          .update(sealedRankingPublicationIdentity(publication))
          .digest('hex')
          .slice(0, 24)
        const cacheKey = publicRankingCacheKey(
          `rankings:platform-stats:sealed-v2:${proofFingerprint}`
        )

        return tieredGetOrSet<PlatformStat[]>(
          cacheKey,
          async () => {
            const { data: rpcRows, error: rpcError } = await supabase.rpc(
              'get_public_platform_stats',
              {
                p_season_id: '90D',
                p_score_cohort_id: publication.scoreCohortId,
                p_allowed_sources: allowedSources,
              }
            )
            if (rpcError) {
              throw new Error(`RPC get_public_platform_stats failed: ${rpcError.message}`)
            }
            return parsePlatformStats(rpcRows, allowedSources)
          },
          'cold',
          ['rankings', 'platform-stats']
        )
      },
      { timeoutMs: 10_000 }
    )
    const platformStats = sealedStats.value

    return NextResponse.json(
      { platforms: platformStats, season: '90D' },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('[platform-stats]', message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
