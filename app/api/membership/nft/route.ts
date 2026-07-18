import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { checkNFTMembership, getTokenExpiry } from '@/lib/web3/nft'
import { getUserTokenId } from '@/lib/web3/mint'

/**
 * GET /api/membership/nft
 *
 * Return the authenticated user's on-chain NFT badge details.
 * NFT ownership is display-only: paid/trial/grant ledgers are the sole source
 * of Pro authority, so this read endpoint must never mutate entitlement state.
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
