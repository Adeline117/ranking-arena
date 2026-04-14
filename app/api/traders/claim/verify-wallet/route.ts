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

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const { wallet_address, signature, message, platform, trader_key } = body

    const result = await verifyWalletOwnership(supabase, user.id, {
      wallet_address,
      signature,
      message,
      platform,
      trader_key,
    })

    return success(result)
  } catch (error: unknown) {
    // Convert plain Error from verifyWalletOwnership to ApiError.validation
    if (error instanceof Error && !(error instanceof ApiError)) {
      return handleError(ApiError.validation(error.message), 'verify-wallet')
    }
    return handleError(error, 'verify-wallet')
  }
}
