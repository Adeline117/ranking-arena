import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkNFTMembership, getTokenExpiry } from '@/lib/web3/nft'
import { getUserTokenId } from '@/lib/web3/mint'

/**
 * GET /api/membership/nft
 *
 * Check if the authenticated user has a valid NFT membership.
 * Returns detailed NFT info including tokenId and expiry date.
 *
 * Response: { hasNft: boolean, tokenId?: string, walletAddress?: string, expiresAt?: string }
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
        hasNft: false,
        walletAddress: null,
      })
    }

    const hasNft = await checkNFTMembership(profile.wallet_address)

    // Get detailed NFT info if user has one
    let tokenId: string | undefined
    let expiresAt: string | undefined

    if (hasNft) {
      const tokenIdBigInt = await getUserTokenId(profile.wallet_address)
      if (tokenIdBigInt !== null) {
        tokenId = tokenIdBigInt.toString()
        const expiry = await getTokenExpiry(tokenIdBigInt)
        if (expiry) {
          expiresAt = expiry.toISOString()
        }
      }

      // If user has NFT but their subscription_tier is not pro, update it
      await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro' })
        .eq('id', user.id)
        .eq('subscription_tier', 'free') // Only upgrade, never downgrade
    }

    return NextResponse.json({
      hasNft,
      tokenId,
      walletAddress: profile.wallet_address,
      expiresAt,
    })
  } catch (err) {
    console.error('[NFT check] Error:', err)
    return NextResponse.json({ error: 'Failed to check NFT' }, { status: 500 })
  }
}
