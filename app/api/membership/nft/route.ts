import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { checkNFTMembership, getTokenExpiry } from '@/lib/web3/nft'
import { getUserTokenId } from '@/lib/web3/mint'
import logger from '@/lib/logger'

/**
 * GET /api/membership/nft
 *
 * Check if the authenticated user has a valid NFT membership.
 * Returns detailed NFT info including tokenId and expiry date.
 *
 * Response: { hasNft: boolean, tokenId?: string, walletAddress?: string, expiresAt?: string }
 */
export const GET = withAuth(
  async ({ user, supabase }) => {
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

      // If user has NFT but their subscription_tier is not pro, update it.
      // Error-check both entitlement writes: a swallowed failure means a valid NFT
      // holder silently never receives Pro, with no signal to user or ops.
      const { error: tierError } = await supabase
        .from('user_profiles')
        .update({ subscription_tier: 'pro' })
        .eq('id', user.id)
        .eq('subscription_tier', 'free') // Only upgrade, never downgrade
      if (tierError) {
        logger.error('[membership-nft] subscription_tier upgrade failed', {
          userId: user.id,
          error: tierError.message,
        })
      }

      // Also upsert into subscriptions table to keep it in sync as the single source of truth
      const { error: subError } = await supabase.from('subscriptions').upsert(
        {
          user_id: user.id,
          tier: 'pro',
          status: 'active',
          plan: 'nft',
          current_period_start: new Date().toISOString(),
          current_period_end: expiresAt || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      if (subError) {
        logger.error('[membership-nft] subscriptions upsert failed', {
          userId: user.id,
          error: subError.message,
        })
      }
    }

    // Backward-compatible response shape
    return NextResponse.json({
      hasNft,
      tokenId,
      walletAddress: profile.wallet_address,
      expiresAt,
    })
  },
  { name: 'membership-nft', rateLimit: 'authenticated' }
)
