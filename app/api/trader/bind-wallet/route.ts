/**
 * POST /api/trader/bind-wallet
 *
 * Bind a DEX wallet to a trader profile by verifying signature ownership.
 *
 * Body: {
 *   platform: string,        // 'hyperliquid', 'gmx', 'dydx', 'gains', 'drift', 'jupiter_perps'
 *   walletAddress: string,   // Wallet address (0x... for EVM, base58 for Solana)
 *   signature: string,       // Signed message
 *   message: string,         // Original message that was signed
 * }
 *
 * Returns: {
 *   success: boolean,
 *   authorizationId?: string,
 *   chain?: 'evm' | 'solana',
 *   error?: string,
 * }
 */

import { NextRequest } from 'next/server'
import {
  requireAuth,
  getSupabaseAdmin,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { bindWallet } from '@/lib/services/wallet-binder'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    // Validate required fields
    const platform = validateString(body.platform, { required: true, fieldName: 'platform' })
    const walletAddress = validateString(body.walletAddress, { required: true, fieldName: 'walletAddress' })
    const signature = validateString(body.signature, { required: true, fieldName: 'signature' })
    const message = validateString(body.message, { required: true, fieldName: 'message' })

    if (!platform || !walletAddress || !signature || !message) {
      return handleError(
        new Error('Missing required fields: platform, walletAddress, signature, message'),
        'bind-wallet'
      )
    }

    // Bind the wallet
    const result = await bindWallet(supabase, user.id, {
      platform,
      walletAddress,
      signature,
      message,
    })

    if (!result.success) {
      return handleError(new Error(result.error || 'Wallet binding failed'), 'bind-wallet')
    }

    logger.info('[bind-wallet] Wallet bound', {
      userId: user.id,
      platform,
      chain: result.chain,
    })

    return success({
      success: true,
      authorizationId: result.authorizationId,
      chain: result.chain,
      message: 'Wallet bound successfully. Your profile is now verified.',
    })
  } catch (error: unknown) {
    return handleError(error, 'bind-wallet')
  }
}
