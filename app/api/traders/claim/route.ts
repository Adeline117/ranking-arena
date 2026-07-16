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
import {
  getUserClaimForTrader,
  getUserVerifiedTrader,
  isTraderClaimed,
  submitClaim,
} from '@/lib/data/trader-claims'
import { notifyTraderClaim } from '@/lib/notifications/activity-alerts'
import { sendNotification } from '@/lib/data/notifications'
import { verifyWalletOwnership } from '@/lib/services/wallet-verification'
import { hasVerifiedClaimConnection } from '@/lib/services/claim-connection-proof'
import { logger } from '@/lib/logger'
import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '@/lib/validators/wallet-identity'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'

function requireProofString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiError.validation(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw ApiError.validation(`${field} is too long`)
  }
  return value
}

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
    const rawTraderId = validateString(request.nextUrl.searchParams.get('trader_id'), {
      required: true,
      maxLength: 512,
      fieldName: 'trader_id',
    })
    const rawSource = validateString(request.nextUrl.searchParams.get('source'), {
      required: true,
      maxLength: 100,
      fieldName: 'source',
    })

    if (!rawTraderId || !rawSource) {
      throw ApiError.validation('trader_id and source are required')
    }

    const source = rawSource.toLowerCase()
    const traderId = isDexWalletPlatform(source)
      ? canonicalizeWalletIdentity(rawTraderId, source)
      : rawTraderId

    const [claim, verified, linkedResult] = await Promise.all([
      getUserClaimForTrader(supabase, user.id, traderId, source),
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

    const rawTraderId = validateString(body.trader_id, {
      required: true,
      maxLength: 512,
      fieldName: 'trader_id',
    })
    const rawSource = validateString(body.source, { required: true, fieldName: 'source' })
    const source = rawSource?.toLowerCase()
    const verification_method = validateEnum(body.verification_method, [
      'api_key',
      'signature',
    ] as const)

    if (!rawTraderId || !source || !verification_method) {
      throw ApiError.validation('Missing required parameters')
    }

    let trader_id = rawTraderId
    if (verification_method === 'signature') {
      try {
        trader_id = canonicalizeWalletIdentity(rawTraderId, source)
      } catch (error) {
        throw ApiError.validation(
          error instanceof Error ? error.message : 'Invalid wallet identity'
        )
      }
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
      const proof = body.verification_data
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
        throw ApiError.validation('Wallet signature verification data must be an object')
      }

      const proofRecord = proof as Record<string, unknown>
      const walletAddress = requireProofString(proofRecord.wallet_address, 'wallet_address', 512)
      const signature = requireProofString(proofRecord.signature, 'signature', 2048)
      const message = requireProofString(proofRecord.message, 'message', 2048)

      // Verify that wallet_address matches trader_id
      if (!walletIdentitiesMatch(walletAddress, trader_id, source)) {
        throw ApiError.validation('Wallet address does not match trader account')
      }

      // Verify wallet ownership directly (no HTTP self-fetch)
      try {
        const verification = await verifyWalletOwnership(supabase, user.id, {
          wallet_address: walletAddress,
          signature,
          message,
          platform: source,
          trader_key: trader_id,
        })
        body.verification_data = {
          wallet_address: verification.wallet_address,
          signature,
          message,
        }
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

    let claim
    try {
      claim = await submitClaim(supabase, user.id, {
        trader_id,
        source,
        verification_method,
        verification_data: sanitizedVerificationData,
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw ApiError.validation('This trader has already been claimed')
      }
      throw error
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
