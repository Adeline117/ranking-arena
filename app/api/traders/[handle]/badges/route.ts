import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
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
  const { handle } = await params

  if (!handle) {
    return NextResponse.json({ error: 'Handle required' }, { status: 400 })
  }

  // Check cache first
  const cacheKey = `badges:${handle}`
  const { data: cached } = await tieredGet<{ badges: EarnedBadge[] }>(cacheKey, 'warm')
  if (cached) {
    return NextResponse.json(cached)
  }

  const supabase = getSupabaseAdmin()

  // Fetch trader data from trader_snapshots (90D period for comprehensive stats)
  const { data: snapshot, error } = await supabase
    .from('trader_snapshots')
    .select(`
      source_trader_id,
      roi,
      pnl,
      win_rate,
      max_drawdown,
      followers,
      arena_score,
      source,
      captured_at
    `)
    .eq('source_trader_id', handle)
    .eq('season_id', '90D')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !snapshot) {
    return NextResponse.json({ badges: [] })
  }

  // Get global rank by counting traders with higher arena_score
  const { count: rankBefore } = await supabase
    .from('trader_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('season_id', '90D')
    .gt('arena_score', snapshot.arena_score ?? 0)

  const rank = (rankBefore ?? 0) + 1

  // Check for on-chain attestation
  const { data: attestation } = await supabase
    .from('trader_attestations')
    .select('attestation_uid')
    .eq('trader_handle', handle)
    .maybeSingle()

  // Check for NFT (via linked user profile)
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('wallet_address')
    .eq('handle', handle)
    .not('wallet_address', 'is', null)
    .maybeSingle()

  let hasNft = false
  if (profile?.wallet_address) {
    // Check NFT balance
    try {
      const { checkNFTMembership } = await import('@/lib/web3/nft')
      hasNft = await checkNFTMembership(profile.wallet_address)
    } catch {
      // NFT check failed, assume no NFT
    }
  }

  // Calculate badges
  const badges: EarnedBadge[] = calculateBadges({
    handle: snapshot.source_trader_id,
    rank,
    roi: snapshot.roi,
    roi90d: snapshot.roi,
    winRate: snapshot.win_rate,
    maxDrawdown: snapshot.max_drawdown,
  })

  const response = { badges }

  // Cache for 5 minutes (warm tier)
  await tieredSet(cacheKey, response, 'warm')

  return NextResponse.json(response)
}
