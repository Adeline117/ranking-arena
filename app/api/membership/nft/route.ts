import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkNFTMembership } from '@/lib/web3/nft'

/**
 * GET /api/membership/nft
 *
 * Check if the authenticated user has a valid NFT membership.
 * Looks up wallet_address from user_profiles, then checks on-chain.
 *
 * Response: { hasNFT: boolean, walletAddress: string | null }
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('wallet_address')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.wallet_address) {
      return NextResponse.json({
        hasNFT: false,
        walletAddress: null,
      })
    }

    const hasNFT = await checkNFTMembership(profile.wallet_address)

    // If user has NFT but their subscription_tier is not pro, update it
    if (hasNFT) {
      await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro' })
        .eq('id', user.id)
        .eq('subscription_tier', 'free') // Only upgrade, never downgrade
    }

    return NextResponse.json({
      hasNFT,
      walletAddress: profile.wallet_address,
    })
  } catch (err) {
    console.error('[NFT check] Error:', err)
    return NextResponse.json({ error: 'Failed to check NFT' }, { status: 500 })
  }
}
