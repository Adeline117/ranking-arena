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
import { z } from 'zod'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
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

const ClaimIdentitySchema = {
  trader_id: z.string().trim().min(1).max(512),
  source: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((value) => value.toLowerCase()),
}

const ClaimRequestSchema = z.discriminatedUnion('verification_method', [
  z
    .object({
      ...ClaimIdentitySchema,
      verification_method: z.literal('api_key'),
      verification_data: z.object({ verified_uid: z.string().trim().min(1).max(512) }).strict(),
    })
    .strict(),
  z
    .object({
      ...ClaimIdentitySchema,
      verification_method: z.literal('signature'),
      verification_data: z
        .object({
          wallet_address: z.string().min(1).max(512),
          signature: z.string().min(1).max(2048),
          message: z.string().min(1).max(2048),
        })
        .strict(),
    })
    .strict(),
])

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
      getUserVerifiedTrader(supabase, user.id, traderId, source),
      supabase
        .from('user_linked_traders')
        .select(
          'id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method, created_at, updated_at'
        )
        .eq('user_id', user.id)
        .order('display_order', { ascending: true }),
    ])

    if (linkedResult.error) throw linkedResult.error
    const linkedTraders = linkedResult.data || []
    if (linkedTraders.some((linked) => linked.user_id !== user.id)) {
      throw new Error('Claim status returned a mismatched linked account')
    }

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
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      throw ApiError.validation('Invalid JSON body')
    }

    const parsedBody = ClaimRequestSchema.safeParse(rawBody)
    if (!parsedBody.success) throw ApiError.validation('Invalid claim request')
    const body = parsedBody.data
    const rawTraderId = body.trader_id
    const source = body.source
    const verification_method = body.verification_method

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

    if (
      body.verification_method === 'api_key' &&
      body.verification_data.verified_uid !== trader_id
    ) {
      throw ApiError.validation(
        'Verification mismatch. The verified UID does not match this trader.'
      )
    }
    if (
      body.verification_method === 'signature' &&
      !walletIdentitiesMatch(body.verification_data.wallet_address, trader_id, source)
    ) {
      throw ApiError.validation('Wallet address does not match trader account')
    }

    // Early check if already claimed (optimization — DB unique constraint is the real guard against race conditions)
    const isClaimed = await isTraderClaimed(supabase, trader_id, source)
    if (isClaimed) {
      throw ApiError.validation('This trader account has been claimed or is under review')
    }

    let sanitizedVerificationData: Record<string, unknown>

    // For API key verification, validate that verify-ownership was called and UID matches
    if (body.verification_method === 'api_key') {
      const verifiedUid = body.verification_data.verified_uid

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

      const uidHash = crypto.createHash('sha256').update(verifiedUid).digest('hex').slice(0, 16)
      sanitizedVerificationData = { uid_hash: uidHash }
    } else {
      // For wallet signature verification, verify the signature server-side.
      const { wallet_address: walletAddress, signature, message } = body.verification_data

      // Verify wallet ownership directly (no HTTP self-fetch)
      try {
        const verification = await verifyWalletOwnership(supabase, user.id, {
          wallet_address: walletAddress,
          signature,
          message,
          platform: source,
          trader_key: trader_id,
        })
        sanitizedVerificationData = {
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
        reference_id: `submitted:${claim.id}`,
      },
      'trader-claim-submit',
      { deduplicate: true, dedupWindowSeconds: 604800 }
    )
    // Owner alert (Telegram) — the review queue ping.
    notifyTraderClaim(user.email ?? null, trader_id, source)

    // Return a minimal, identity-bound receipt. Never echo signature material or
    // other verification_data back to the browser after it has been consumed.
    return success({
      claimId: claim.id,
      traderId: claim.trader_id,
      source: claim.source,
      viewerId: claim.user_id,
      method: claim.verification_method,
      status: claim.status,
      autoApproved: false as const,
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim POST')
  }
}
