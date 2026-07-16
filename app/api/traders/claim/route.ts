/**
 * Trader Claim API
 * GET /api/traders/claim - Get user's claim status (includes all linked traders)
 * POST /api/traders/claim - Submit claim with verification (supports multi-account)
 *
 * After verification passes (API key UID match or wallet signature), the
 * claim enters MANUAL owner review ('reviewing'); activation happens on
 * admin approval via activateClaim() (2026-07-09 owner decision).
 */

import crypto from 'crypto'
import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { getUserClaim, getUserVerifiedTrader, isTraderClaimed } from '@/lib/data/trader-claims'
import { notifyTraderClaim } from '@/lib/notifications/activity-alerts'
import { sendNotification } from '@/lib/data/notifications'
import { verifyWalletOwnership } from '@/lib/services/wallet-verification'
import { hasVerifiedClaimConnection } from '@/lib/services/claim-connection-proof'
import { logger } from '@/lib/logger'

/**
 * GET /api/traders/claim
 * Get user's claim status, including all linked traders
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const [claim, verified, linkedResult] = await Promise.all([
      getUserClaim(supabase, user.id),
      getUserVerifiedTrader(supabase, user.id),
      supabase
        .from('user_linked_traders')
        .select(
          'id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method, created_at, updated_at'
        )
        .eq('user_id', user.id)
        .order('display_order', { ascending: true }),
    ])

    const linkedTraders = linkedResult.data || []

    return success({
      claim,
      verified_trader: verified,
      is_verified: !!verified,
      linked_traders: linkedTraders,
      linked_count: linkedTraders.length,
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim GET')
  }
}

/**
 * POST /api/traders/claim
 * Submit claim with verification proof.
 *
 * For CEX (API key): requires prior successful verify-ownership call
 * For DEX (wallet): requires signature verification
 *
 * Body: {
 *   trader_id: string,
 *   source: string,
 *   verification_method: 'api_key' | 'signature',
 *   verification_data: { verified_uid?: string, wallet_address?: string, signature?: string, message?: string },
 * }
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const trader_id = validateString(body.trader_id, { required: true, fieldName: 'trader_id' })
    const rawSource = validateString(body.source, { required: true, fieldName: 'source' })
    const source = rawSource?.toLowerCase()
    const verification_method = validateEnum(body.verification_method, [
      'api_key',
      'signature',
    ] as const)

    if (!trader_id || !source || !verification_method) {
      throw ApiError.validation('Missing required parameters')
    }

    // Early check if already claimed (optimization — DB unique constraint is the real guard against race conditions)
    const isClaimed = await isTraderClaimed(supabase, trader_id, source)
    if (isClaimed) {
      throw ApiError.validation('This trader account has been claimed or is under review')
    }

    // For API key verification, validate that verify-ownership was called and UID matches
    if (verification_method === 'api_key') {
      const verifiedUid = body.verification_data?.verified_uid

      if (!verifiedUid) {
        throw ApiError.validation(
          'API key verification required. Please complete the verification step first.'
        )
      }

      // Re-check the server-stored proof. Futures/spot leaderboard sources map
      // to the base exchange connection written by verify-ownership.
      const connectionIsVerified = await hasVerifiedClaimConnection(
        supabase,
        user.id,
        source,
        trader_id
      )

      if (!connectionIsVerified) {
        logger.warn('[trader-claim] UID mismatch in claim submission', {
          userId: user.id,
          platform: source,
        })
        throw ApiError.validation(
          'Verification mismatch. Your verified account does not match this trader.'
        )
      }
    }

    // For wallet signature verification, verify the signature server-side
    if (verification_method === 'signature') {
      const { wallet_address, signature, message } = body.verification_data || {}

      if (!wallet_address || !signature || !message) {
        throw ApiError.validation(
          'Wallet signature verification requires wallet_address, signature, and message'
        )
      }

      // Verify that wallet_address matches trader_id
      if (wallet_address.toLowerCase() !== trader_id.toLowerCase()) {
        throw ApiError.validation('Wallet address does not match trader account')
      }

      // Verify wallet ownership directly (no HTTP self-fetch)
      try {
        await verifyWalletOwnership(supabase, user.id, {
          wallet_address,
          signature,
          message,
          platform: source,
          trader_key: trader_id,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Wallet signature verification failed'
        throw ApiError.validation(msg)
      }
    }

    // Verification passed — queue for MANUAL owner review (2026-07-09 owner
    // decision: "UID 加人工,我来一个个看"). The API-key UID match / wallet
    // signature above proves account OWNERSHIP; the owner personally confirms
    // the claim before any badge/authorization side effect fires. The whole
    // activation chain (verified_traders / user_linked_traders / user_profiles
    // / trader_authorizations) moved to activateClaim(), called from the admin
    // approve path (lib/data/trader-claims.ts reviewClaim).

    // Hash sensitive UIDs before storing in verification_data
    let sanitizedVerificationData = body.verification_data || {}
    if (verification_method === 'api_key' && sanitizedVerificationData.verified_uid) {
      const uidHash = crypto
        .createHash('sha256')
        .update(String(sanitizedVerificationData.verified_uid))
        .digest('hex')
        .slice(0, 16)
      sanitizedVerificationData = { uid_hash: uidHash }
    }

    const { data: claim, error: claimError } = await supabase
      .from('trader_claims')
      .insert({
        user_id: user.id,
        trader_id,
        source,
        verification_method,
        verification_data: sanitizedVerificationData,
        status: 'reviewing',
      })
      .select()
      .single()

    if (claimError) {
      if (claimError.code === '23505') {
        throw ApiError.validation('This trader has already been claimed')
      }
      throw claimError
    }

    // In-app notification to the claimant (fire-and-forget, deduped).
    sendNotification(
      supabase,
      {
        user_id: user.id,
        type: 'system',
        title: 'Claim under review',
        message: `Your claim for ${trader_id} (${source}) passed verification and is awaiting manual review.`,
        reference_id: String(claim.id),
      },
      'trader-claim-submit'
    )
    // Owner alert (Telegram) — the review queue ping.
    notifyTraderClaim(user.email ?? null, trader_id, source)

    return success({
      claim,
      message:
        'Verification passed! Your claim is under review — you will be notified once approved.',
      auto_approved: false,
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim POST')
  }
}
