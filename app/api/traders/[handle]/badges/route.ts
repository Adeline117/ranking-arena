import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { calculateBadges, type EarnedBadge } from '@/lib/badges'
import { getOrSetWithLock } from '@/lib/cache'
import { logger } from '@/lib/logger'
import {
  isPublicRankingSourceAllowed,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const BADGE_PERIOD = '90D'
const BADGE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'
const PUBLIC_RANKED_BADGE_COLUMNS =
  'source_trader_id,roi,pnl,win_rate,max_drawdown,followers,arena_score,rank,source,computed_at,score_completeness,metrics_estimated,is_outlier,season_id'

interface BadgeCacheScope {
  source: string
  sourceTraderId: string
  period: typeof BADGE_PERIOD
}

interface BadgeCacheValue {
  scope: BadgeCacheScope
  row: unknown | null
}

type BadgePublicRankedRow = Record<string, unknown> & { rank: number }

interface SanitizedBadgeCohort {
  row: BadgePublicRankedRow | null
  integrityCompromised: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasPositiveRank(row: unknown): row is BadgePublicRankedRow {
  return (
    isRecord(row) && typeof row.rank === 'number' && Number.isSafeInteger(row.rank) && row.rank > 0
  )
}

function hasExactBadgeCacheScope(
  value: unknown,
  expected: BadgeCacheScope
): value is BadgeCacheScope {
  return (
    isRecord(value) &&
    value.source === expected.source &&
    value.sourceTraderId === expected.sourceTraderId &&
    value.period === expected.period
  )
}

function badgeCacheKey(scope: BadgeCacheScope): string {
  return publicRankingCacheKey(
    `badges:verified:v2:${encodeURIComponent(scope.source)}:${encodeURIComponent(scope.sourceTraderId)}`
  )
}

function sanitizeBadgeCohort(value: unknown, expected: BadgeCacheScope): SanitizedBadgeCohort {
  const envelope = isRecord(value) ? value : null
  const hasValidEnvelope =
    hasExactBadgeCacheScope(envelope?.scope, expected) &&
    (envelope?.row === null || isRecord(envelope?.row))
  const rawRow = hasValidEnvelope ? envelope.row : null

  // A cached absence is valid and intentionally distinguishable from an
  // invalid cache envelope. A non-null row must be re-checked on every hit:
  // cache TTL alone cannot prove source freshness or metric completeness.
  if (rawRow === null) {
    return { row: null, integrityCompromised: !hasValidEnvelope }
  }

  const sanitized = sanitizePublicRankingPayload(
    { traders: [rawRow], period: expected.period },
    { expectedPeriod: expected.period }
  ) as { traders?: unknown[] }
  const row = Array.isArray(sanitized.traders) ? sanitized.traders[0] : null
  const hasExpectedIdentity =
    isRecord(row) &&
    row.source === expected.source &&
    row.source_trader_id === expected.sourceTraderId

  return {
    row: hasExpectedIdentity && hasPositiveRank(row) ? row : null,
    integrityCompromised: !hasValidEnvelope || !hasExpectedIdentity || !hasPositiveRank(row),
  }
}

function badgeResponse(
  badges: EarnedBadge[],
  visibility: 'partial' | 'unknown' | null = null,
  reason: string | null = null
) {
  return NextResponse.json(
    {
      badges,
      ...(visibility ? { ranking_visibility: visibility } : {}),
      ...(reason
        ? { ranking_visibility_reason: reason, ranking_visibility_reasons: [reason] }
        : {}),
    },
    { headers: { 'Cache-Control': BADGE_CACHE_CONTROL } }
  )
}

/**
 * GET /api/traders/[handle]/badges
 *
 * Badge rank tiers are public ranking claims. They can only be calculated
 * from the sealed `public_ranked_leaderboard` cohort; unranked/profile-only
 * observations remain visible on their own surfaces but earn no rank badge.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse
  const { handle } = await params

  if (!handle) {
    return NextResponse.json({ error: 'Handle required' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  // Resolution establishes only a canonical identity. It does not establish
  // ranking eligibility; that boundary is the view read below.
  const resolved = await resolveTrader(supabase, { handle })
  if (!resolved) {
    return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
  }
  if (!isPublicRankingSourceAllowed(resolved.platform)) {
    return badgeResponse([], 'partial', 'source_not_publicly_rankable')
  }

  const scope: BadgeCacheScope = {
    source: resolved.platform,
    sourceTraderId: resolved.traderKey,
    period: BADGE_PERIOD,
  }

  let cached: BadgeCacheValue
  try {
    cached = await getOrSetWithLock<BadgeCacheValue>(
      badgeCacheKey(scope),
      async () => {
        // The security-barrier view proves source, history, freshness, and
        // complete score inputs before identity filters are applied here.
        const { data, error } = await supabase
          .from('public_ranked_leaderboard')
          .select(PUBLIC_RANKED_BADGE_COLUMNS)
          .eq('source', scope.source)
          .eq('source_trader_id', scope.sourceTraderId)
          .eq('season_id', scope.period)
          .not('rank', 'is', null)
          .maybeSingle()

        if (error) throw error
        return { scope, row: data }
      },
      {
        ttl: 300,
        lockTtl: 10,
        tags: [PUBLIC_RANKING_REDIS_TAG, `season:${BADGE_PERIOD}`],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )
  } catch (error) {
    logger.warn('[badges] public cohort query failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return badgeResponse([], 'unknown', 'public_cohort_unavailable')
  }

  const cohort = sanitizeBadgeCohort(cached, scope)
  if (cohort.integrityCompromised) {
    return badgeResponse([], 'partial', 'public_cohort_unverified')
  }
  if (!cohort.row) {
    return badgeResponse([], 'unknown', 'public_rank_unavailable')
  }

  // Check for on-chain attestation (table not yet created)
  const _attestation = null

  // Check for NFT (via linked user profile)
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('wallet_address')
    .eq('handle', handle)
    .not('wallet_address', 'is', null)
    .maybeSingle()

  let _hasNft = false
  if (profile?.wallet_address) {
    try {
      const { checkNFTMembership } = await import('@/lib/web3/nft')
      _hasNft = await checkNFTMembership(profile.wallet_address)
    } catch {
      // NFT evidence is optional and never substitutes for a rank proof.
    }
  }

  const badges: EarnedBadge[] = calculateBadges({
    handle: scope.sourceTraderId,
    rank: cohort.row.rank,
  })

  return badgeResponse(badges)
}
