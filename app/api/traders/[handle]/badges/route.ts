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

  // Fetch trader data
  const { data: trader, error } = await supabase
    .from('traders')
    .select(`
      handle,
      arena_score,
      roi,
      roi_7d,
      roi_30d,
      roi_90d,
      win_rate,
      max_drawdown,
      aum,
      copiers,
      created_at
    `)
    .eq('handle', handle)
    .maybeSingle()

  if (error || !trader) {
    return NextResponse.json({ badges: [] })
  }

  // Get global rank
  const { count: rankBefore } = await supabase
    .from('traders')
    .select('*', { count: 'exact', head: true })
    .gt('arena_score', trader.arena_score ?? 0)

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
    handle: trader.handle,
    rank,
    arenaScore: trader.arena_score,
    roi: trader.roi,
    roi30d: trader.roi_30d,
    roi90d: trader.roi_90d,
    winRate: trader.win_rate,
    maxDrawdown: trader.max_drawdown,
    aum: trader.aum,
    copiers: trader.copiers,
    startDate: trader.created_at,
    hasOnChainAttestation: !!attestation,
    hasNft,
  })

  const response = { badges }

  // Cache for 5 minutes (warm tier)
  await tieredSet(cacheKey, response, 'warm')

  return NextResponse.json(response)
}
