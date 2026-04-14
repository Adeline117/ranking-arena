import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { calculateBadges, type EarnedBadge } from '@/lib/badges'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'

/**
 * GET /api/traders/[handle]/badges
 *
 * Returns all badges earned by a trader based on their current stats.
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

  const cacheHeaders = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' }

  // Check cache first
  const cacheKey = `badges:${handle}`
  const { data: cached } = await tieredGet<{ badges: EarnedBadge[] }>(cacheKey, 'warm')
  if (cached) {
    return NextResponse.json(cached, { headers: cacheHeaders })
  }

  const supabase = getSupabaseAdmin()

  // Resolve trader via unified layer
  const resolved = await resolveTrader(supabase, { handle })
  if (!resolved) {
    return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
  }

  // Fetch trader data from leaderboard_ranks (precomputed, fast)
  const { data: rankData, error } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, roi, pnl, win_rate, max_drawdown, followers, arena_score, rank, source, computed_at')
    .eq('source', resolved.platform)
    .eq('source_trader_id', resolved.traderKey)
    .eq('season_id', '90D')
    .maybeSingle()

  if (error || !rankData) {
    return NextResponse.json({ badges: [] })
  }

  const rank = rankData.rank ?? 999999

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
    // Check NFT balance
    try {
      const { checkNFTMembership } = await import('@/lib/web3/nft')
      _hasNft = await checkNFTMembership(profile.wallet_address)
    } catch {
      // NFT check failed, assume no NFT
    }
  }

  // Calculate badges
  const badges: EarnedBadge[] = calculateBadges({
    handle: rankData.source_trader_id,
    rank,
  })

  const response = { badges }

  // Cache for 5 minutes (warm tier)
  await tieredSet(cacheKey, response, 'warm')

  return NextResponse.json(response, { headers: cacheHeaders })
}
