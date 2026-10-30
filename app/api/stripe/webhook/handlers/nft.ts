import { getUserTokenIdStrict, mintMembershipNFT, isMintingConfigured } from '@/lib/web3/mint'
import { sendNotification } from '@/lib/data/notifications'
import { getSupabase, logger } from './shared'

const MINT_CLAIM_PREFIX = 'pending:stripe-checkout:'
const MINT_CLAIM_STALE_MS = 10 * 60 * 1000

function isMintClaim(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(MINT_CLAIM_PREFIX)
}

export async function mintNFTForUser(userId: string, plan: string, checkoutSessionId: string) {
  if (!isMintingConfigured()) {
    logger.info('NFT minting not configured, skipping', { userId })
    return
  }

  const supabase = getSupabase()
  const claimMarker = `${MINT_CLAIM_PREFIX}${checkoutSessionId}`

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('wallet_address, nft_token_id, nft_minted_at')
      .eq('id', userId)
      .single()

    if (profileError) {
      throw new Error(`NFT profile read failed: ${profileError.message}`)
    }

    if (profile?.nft_token_id && !isMintClaim(profile.nft_token_id)) {
      logger.info('NFT already minted for user, skipping', {
        userId,
        tokenId: profile.nft_token_id,
      })
      return
    }

    if (!profile?.wallet_address) {
      logger.info('User has no wallet address, NFT minting skipped', { userId })
      sendNotification(
        getSupabase(),
        {
          user_id: userId,
          type: 'nft_pending',
          title: '链接钱包领取 NFT 会员证',
          message: '您已成功订阅 Pro 会员！链接钱包后即可获得 NFT 会员证明。',
          link: '/settings/linked-accounts',
        },
        'NFT pending notification'
      )
      return
    }

    // Reconcile the chain before claiming. This closes the crash window where
    // a transaction confirmed but the durable profile marker was not written.
    // The strict lookup throws on RPC failure so an outage can never be
    // mistaken for a zero balance and trigger a duplicate mint.
    const existingTokenId = await getUserTokenIdStrict(profile.wallet_address)
    if (existingTokenId !== null) {
      let markerQuery = supabase
        .from('user_profiles')
        .update({
          nft_token_id: existingTokenId.toString(),
          nft_minted_at: new Date().toISOString(),
        })
        .eq('id', userId)
      markerQuery = profile.nft_token_id
        ? markerQuery.eq('nft_token_id', profile.nft_token_id)
        : markerQuery.is('nft_token_id', null)
      const { data: marked, error: markerError } = await markerQuery.select('id').maybeSingle()
      if (markerError || !marked) {
        throw new Error(markerError?.message || 'NFT chain reconciliation lost marker authority')
      }
      logger.info('Reconciled existing NFT from chain', {
        userId,
        tokenId: existingTokenId.toString(),
      })
      return
    }

    const now = new Date()
    let claimQuery = supabase
      .from('user_profiles')
      .update({ nft_token_id: claimMarker, nft_minted_at: now.toISOString() })
      .eq('id', userId)

    if (profile.nft_token_id === null) {
      claimQuery = claimQuery.is('nft_token_id', null)
    } else {
      const claimedAt = profile.nft_minted_at ? Date.parse(profile.nft_minted_at) : Number.NaN
      if (Number.isFinite(claimedAt) && claimedAt > now.getTime() - MINT_CLAIM_STALE_MS) {
        throw new Error('NFT mint is already claimed by another checkout delivery')
      }
      claimQuery = claimQuery
        .eq('nft_token_id', profile.nft_token_id)
        .lt('nft_minted_at', new Date(now.getTime() - MINT_CLAIM_STALE_MS).toISOString())
    }

    const { data: claimed, error: claimError } = await claimQuery.select('id').maybeSingle()
    if (claimError || !claimed) {
      throw new Error(claimError?.message || 'NFT mint claim was not acquired')
    }

    // Lifetime plans use 'yearly' duration for NFT (renewed indefinitely via webhook)
    const mintPlan: 'monthly' | 'yearly' = plan === 'monthly' ? 'monthly' : 'yearly'
    const result = await mintMembershipNFT(profile.wallet_address, mintPlan)

    if (result.success && result.tokenId !== undefined) {
      logger.info('NFT minted successfully', {
        userId,
        walletAddress: profile.wallet_address,
        tokenId: result.tokenId?.toString(),
        txHash: result.txHash,
      })

      const { data: marked, error: markerError } = await supabase
        .from('user_profiles')
        .update({
          nft_token_id: result.tokenId.toString(),
          nft_minted_at: new Date().toISOString(),
        })
        .eq('id', userId)
        .eq('nft_token_id', claimMarker)
        .select('id')
        .maybeSingle()

      if (markerError || !marked) {
        throw new Error(markerError?.message || 'NFT mint marker write lost claim authority')
      }

      sendNotification(
        getSupabase(),
        {
          user_id: userId,
          type: 'nft_minted',
          title: 'NFT 会员证已铸造',
          message: `您的 Arena Pro NFT 会员证已成功铸造到钱包 ${profile.wallet_address.slice(0, 6)}...${profile.wallet_address.slice(-4)}（token #${result.tokenId?.toString() ?? '?'}）`,
          reference_id: result.txHash,
        },
        'NFT minted notification'
      )
    } else {
      const { error: releaseError } = await supabase
        .from('user_profiles')
        .update({ nft_token_id: null, nft_minted_at: null })
        .eq('id', userId)
        .eq('nft_token_id', claimMarker)
      if (releaseError) {
        throw new Error(`NFT mint failed and claim release failed: ${releaseError.message}`)
      }
      throw new Error(result.error || 'NFT mint failed without a token id')
    }
  } catch (err) {
    logger.error('Error in mintNFTForUser', { userId, error: err })
    throw err
  }
}
