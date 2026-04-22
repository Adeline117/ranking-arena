/**
 * Wallet Signature Verification for DEX Trader Claims
 * POST /api/traders/claim/verify-wallet
 *
 * Verifies that the user owns the wallet address that matches
 * the trader's source_trader_id on DEX platforms.
 *
 * Supports:
 * - EVM chains (Ethereum, Arbitrum, etc.): Hyperliquid, GMX, Gains, Aevo, Kwenta, Vertex, dYdX
 * - Solana: Jupiter Perps, Drift
 */

import { NextRequest } from 'next/server'
import {
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  getSupabaseAdmin,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { verifyWalletOwnership } from '@/lib/services/wallet-verification'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('verify-wallet')

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  let reqPlatform: string | undefined
  let reqTraderKey: string | undefined

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const { wallet_address, signature, message, platform, trader_key } = body
    reqPlatform = platform
    reqTraderKey = trader_key

    const result = await verifyWalletOwnership(supabase, user.id, {
      wallet_address,
      signature,
      message,
      platform,
      trader_key,
    })

    logger.info('Wallet ownership verified', {
      userId: user.id,
      platform,
      traderKey: trader_key,
    })

    return success(result)
  } catch (error: unknown) {
    logger.error('Wallet verification failed', {
      error,
      platform: reqPlatform,
      traderKey: reqTraderKey,
    })
    // Convert plain Error from verifyWalletOwnership to ApiError.validation
    if (error instanceof Error && !(error instanceof ApiError)) {
      return handleError(ApiError.validation(error.message), 'verify-wallet')
    }
    return handleError(error, 'verify-wallet')
  }
}
