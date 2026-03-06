import { mintMembershipNFT, isMintingConfigured } from '@/lib/web3/mint'
import { getSupabase, logger } from './shared'

export async function mintNFTForUser(userId: string, plan: string) {
  if (!isMintingConfigured()) {
    logger.info('NFT minting not configured, skipping', { userId })
    return
  }

  try {
    const { data: profile } = await getSupabase()
      .from('user_profiles')
      .select('wallet_address')
      .eq('id', userId)
      .single()

    if (!profile?.wallet_address) {
      logger.info('User has no wallet address, NFT minting skipped', { userId })
      await getSupabase()
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'nft_pending',
          title: '链接钱包领取 NFT 会员证',
          body: '您已成功订阅 Pro 会员！链接钱包后即可获得 NFT 会员证明。',
          data: { plan },
        })
      return
    }

    const mintPlan = plan === 'yearly' ? 'yearly' : 'monthly'
    const result = await mintMembershipNFT(profile.wallet_address, mintPlan)

    if (result.success) {
      logger.info('NFT minted successfully', {
        userId,
        walletAddress: profile.wallet_address,
        tokenId: result.tokenId?.toString(),
        txHash: result.txHash,
      })

      await getSupabase()
        .from('user_profiles')
        .update({
          nft_token_id: result.tokenId?.toString(),
          nft_minted_at: new Date().toISOString(),
        })
        .eq('id', userId)

      await getSupabase()
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'nft_minted',
          title: 'NFT 会员证已铸造',
          body: `您的 Arena Pro NFT 会员证已成功铸造到钱包 ${profile.wallet_address.slice(0, 6)}...${profile.wallet_address.slice(-4)}`,
          data: {
            tokenId: result.tokenId?.toString(),
            txHash: result.txHash,
            plan,
          },
        })
    } else {
      logger.error('NFT minting failed', { userId, error: result.error })
      await getSupabase()
        .from('nft_mint_queue')
        .upsert({
          user_id: userId,
          wallet_address: profile.wallet_address,
          plan: mintPlan,
          status: 'pending',
          error: result.error,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id', ignoreDuplicates: true })
    }
  } catch (err) {
    logger.error('Error in mintNFTForUser', { userId, error: err })
  }
}
