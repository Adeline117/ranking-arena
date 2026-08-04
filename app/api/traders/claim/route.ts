/**
 * Trader Claim API
 * GET /api/traders/claim - Get user's claim status (includes all linked traders)
 * POST /api/traders/claim - Submit claim with verification (supports multi-account)
 *
 * After a server-challenge wallet signature passes, the claim enters manual
 * owner review ('reviewing'); activation happens only on admin approval.
 */

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
  getVerifiedTrader,
  isTraderClaimed,
  submitClaim,
} from '@/lib/data/trader-claims'
import { notifyTraderClaim } from '@/lib/notifications/activity-alerts'
import { sendNotification } from '@/lib/data/notifications'
import {
  verifyWalletOwnership,
  type WalletClaimChallengeAttestation,
  type WalletReplayReservation,
} from '@/lib/services/wallet-verification'
import { logger } from '@/lib/logger'
import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '@/lib/validators/wallet-identity'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { claimMethodForSource } from '@/lib/constants/trader-claim-platforms'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

function withPrivateNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

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
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

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

    const [claim, exactVerified, linkedResult] = await Promise.all([
      getUserClaimForTrader(supabase, user.id, traderId, source),
      getVerifiedTrader(supabase, traderId, source),
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
    const verified =
      exactVerified?.user_id === user.id &&
      exactVerified.trader_id === traderId &&
      exactVerified.source === source
        ? exactVerified
        : null

    return withPrivateNoStore(
      success({
        claim,
        verified_trader: verified,
        is_verified: !!verified,
        linked_traders: linkedTraders,
        linked_count: linkedTraders.length,
      })
    )
  } catch (error: unknown) {
    return withPrivateNoStore(handleError(error, 'trader claim GET'))
  }
}

/**
 * POST /api/traders/claim
 * Submit claim with verification proof.
 *
 * V1 accepts only the wallet sources whose public leaderboard identity is the
 * same address verified by the signature challenge.
 *
 * Body: {
 *   trader_id: string,
 *   source: string,
 *   verification_method: 'signature',
 *   verification_data: { wallet_address: string, signature: string, challenge_id: string },
 * }
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return withPrivateNoStore(rateLimitResponse)

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
    const verification_method = validateEnum(body.verification_method, ['signature'] as const)

    if (!rawTraderId || !source || !verification_method) {
      throw ApiError.validation('Missing required parameters')
    }

    const requiredClaimMethod = claimMethodForSource(source)
    if (requiredClaimMethod === 'unsupported') {
      throw ApiError.validation(`Trader claims are not supported for source ${source}`)
    }
    if (verification_method !== requiredClaimMethod) {
      throw ApiError.validation(`Source ${source} requires ${requiredClaimMethod} verification`)
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

    let walletReplayReservation: WalletReplayReservation | null = null
    let challengeAttestation: WalletClaimChallengeAttestation | null = null

    // For wallet signature verification, verify the signature server-side
    if (verification_method === 'signature') {
      const proof = body.verification_data
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
        throw ApiError.validation('Wallet signature verification data must be an object')
      }

      const proofRecord = proof as Record<string, unknown>
      const walletAddress = requireProofString(proofRecord.wallet_address, 'wallet_address', 512)
      const signature = requireProofString(proofRecord.signature, 'signature', 2048)
      const challengeId = requireProofString(proofRecord.challenge_id, 'challenge_id', 64)

      // Verify that wallet_address matches trader_id
      if (!walletIdentitiesMatch(walletAddress, trader_id, source)) {
        throw ApiError.validation('Wallet address does not match trader account')
      }

      // Verify wallet ownership directly (no HTTP self-fetch)
      try {
        const verification = await verifyWalletOwnership(supabase, user.id, {
          wallet_address: walletAddress,
          signature,
          challenge_id: challengeId,
          platform: source,
          trader_key: trader_id,
        })
        walletReplayReservation = verification.reservation
        challengeAttestation = verification.challenge_attestation
      } catch (err) {
        if ((err as { statusCode?: unknown })?.statusCode === 503) throw err
        const msg = err instanceof Error ? err.message : 'Wallet signature verification failed'
        throw ApiError.validation(msg)
      }
    }

    // Verification passed — queue for manual owner review. The wallet
    // signature proves control of the leaderboard address; the owner confirms
    // the claim before any verified profile or badge projection is created.
    // Activation is centralized in activateClaim(), called from the admin
    // approval path (lib/data/trader-claims.ts reviewClaim).

    if (!challengeAttestation) {
      throw ApiError.validation('A verified wallet challenge attestation is required')
    }

    let claim
    try {
      claim = await submitClaim(supabase, user.id, {
        trader_id,
        source,
        ...challengeAttestation,
      })
    } catch (error) {
      if (walletReplayReservation) {
        try {
          await walletReplayReservation.release()
        } catch (releaseError) {
          // Fail closed: if Redis is unavailable, its TTL keeps the reservation
          // blocked. Never issue a blind DEL that could release another request.
          logger.error('[trader-claim] Wallet challenge cleanup failed', {}, releaseError as Error)
        }
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw ApiError.validation('This trader has already been claimed')
      }
      throw error
    }

    if (walletReplayReservation) {
      try {
        const consumed = await walletReplayReservation.consume()
        if (!consumed) {
          // The claim is already durable. A missing ownership token must not
          // turn into an unsafe cleanup; challenge expiry and the DB identity
          // constraint remain fail-closed.
          logger.error('[trader-claim] Wallet challenge consume lost reservation ownership', {
            userId: user.id,
            source,
          })
        }
      } catch (consumeError) {
        // Leaving the owner token until TTL is safer than retrying with a
        // non-atomic write after the claim has already committed.
        logger.error('[trader-claim] Wallet challenge consume failed', {}, consumeError as Error)
      }
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

    return withPrivateNoStore(
      success({
        claim,
        message:
          'Verification passed! Your claim is under review — you will be notified once approved.',
        auto_approved: false,
      })
    )
  } catch (error: unknown) {
    const response = handleError(error, 'trader claim POST')
    if ((error as { statusCode?: unknown })?.statusCode === 503) {
      response.headers.set('Retry-After', '30')
      response.headers.set('Cache-Control', 'private, no-store')
    }
    return withPrivateNoStore(response)
  }
}
