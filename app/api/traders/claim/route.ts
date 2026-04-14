/**
 * Trader Claim API
 * GET /api/traders/claim - Get user's claim status (includes all linked traders)
 * POST /api/traders/claim - Submit claim with verification (supports multi-account)
 *
 * After verification passes (API key UID match or wallet signature),
 * the claim is auto-approved without manual review.
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
  getUserClaim,
  getUserVerifiedTrader,
  isTraderClaimed,
} from '@/lib/data/trader-claims'
import { notifyTraderClaim } from '@/lib/notifications/activity-alerts'
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
        .select('id, user_id, trader_id, source, label, is_primary, display_order, verified_at, verification_method, created_at, updated_at')
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
    const source = validateString(body.source, { required: true, fieldName: 'source' })
    const verification_method = validateEnum(
      body.verification_method,
      ['api_key', 'signature', 'video', 'social'] as const
    )

    if (!trader_id || !source || !verification_method) {
      throw ApiError.validation('Missing required parameters')
    }

    // Early check if already claimed (optimization — DB unique constraint is the real guard against race conditions)
    const isClaimed = await isTraderClaimed(supabase, trader_id, source)
    if (isClaimed) {
      throw ApiError.validation('This trader account has been claimed or is under review')
    }

    // Check how many linked traders the user already has (for is_primary logic)
    const { data: existingLinks } = await supabase
      .from('user_linked_traders')
      .select('id')
      .eq('user_id', user.id)
    const isFirstClaim = !existingLinks || existingLinks.length === 0

    // For API key verification, validate that verify-ownership was called and UID matches
    if (verification_method === 'api_key') {
      const verifiedUid = body.verification_data?.verified_uid

      if (!verifiedUid) {
        throw ApiError.validation('API key verification required. Please complete the verification step first.')
      }

      // Double-check: the verified_uid in the exchange connection must match trader_id
      const { data: connection } = await supabase
        .from('user_exchange_connections')
        .select('verified_uid')
        .eq('user_id', user.id)
        .eq('exchange', source)
        .eq('is_active', true)
        .maybeSingle()

      if (!connection?.verified_uid || String(connection.verified_uid) !== String(trader_id)) {
        logger.warn('[trader-claim] UID mismatch in claim submission', {
          userId: user.id,
          platform: source,
        })
        throw ApiError.validation('Verification mismatch. Your verified account does not match this trader.')
      }
    }

    // For wallet signature verification, verify the signature server-side
    if (verification_method === 'signature') {
      const { wallet_address, signature, message } = body.verification_data || {}

      if (!wallet_address || !signature || !message) {
        throw ApiError.validation('Wallet signature verification requires wallet_address, signature, and message')
      }

      // Verify that wallet_address matches trader_id
      if (wallet_address.toLowerCase() !== trader_id.toLowerCase()) {
        throw ApiError.validation('Wallet address does not match trader account')
      }

      // Signature verification is done in /api/traders/claim/verify-wallet
      // If we reach here, it was already verified client-side.
      // But we double-check the signature here for security.
      const verifyUrl = new URL('/api/traders/claim/verify-wallet', request.url)
      const verifyRes = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: request.headers.get('Authorization') || '',
        },
        body: JSON.stringify({ wallet_address, signature, message, platform: source }),
      })

      if (!verifyRes.ok) {
        const verifyData = await verifyRes.json().catch(() => ({}))
        throw ApiError.validation(verifyData.error || 'Wallet signature verification failed')
      }
    }

    // Verification passed - auto-approve the claim
    const now = new Date().toISOString()

    // Hash sensitive UIDs before storing in verification_data
    let sanitizedVerificationData = body.verification_data || {}
    if (verification_method === 'api_key' && sanitizedVerificationData.verified_uid) {
      const uidHash = crypto.createHash('sha256')
        .update(String(sanitizedVerificationData.verified_uid))
        .digest('hex')
        .slice(0, 16)
      sanitizedVerificationData = { uid_hash: uidHash }
    }

    // Create claim record as 'verified' (auto-approved)
    const { data: claim, error: claimError } = await supabase
      .from('trader_claims')
      .insert({
        user_id: user.id,
        trader_id,
        source,
        verification_method,
        verification_data: sanitizedVerificationData,
        status: 'verified',
        verified_at: now,
      })
      .select()
      .single()

    if (claimError) {
      if (claimError.code === '23505') {
        throw ApiError.validation('This trader has already been claimed')
      }
      throw claimError
    }

    // Create verified_traders record
    const { error: verifiedError } = await supabase
      .from('verified_traders')
      .insert({
        user_id: user.id,
        trader_id,
        source,
        verified_at: now,
        verification_method,
      })

    if (verifiedError && verifiedError.code !== '23505') {
      logger.error('[trader-claim] Failed to create verified_traders record', verifiedError)
    }

    // Create user_linked_traders record
    const { error: linkError } = await supabase
      .from('user_linked_traders')
      .upsert({
        user_id: user.id,
        trader_id,
        source,
        is_primary: isFirstClaim,
        display_order: isFirstClaim ? 0 : (existingLinks?.length ?? 0),
        verified_at: now,
        verification_method,
      }, {
        onConflict: 'user_id, trader_id, source',
      })

    if (linkError) {
      logger.error('[trader-claim] Failed to create user_linked_traders record', linkError)
    }

    // Update user_profiles
    const newCount = (existingLinks?.length ?? 0) + 1
    await supabase
      .from('user_profiles')
      .update({
        is_verified_trader: true,
        verified_trader_id: isFirstClaim ? trader_id : undefined,
        verified_trader_source: isFirstClaim ? source : undefined,
        linked_trader_count: newCount,
      })
      .eq('id', user.id)

    // If there's an existing authorization flow, trigger it too
    // This merges the "authorize" functionality into claim
    if (verification_method === 'api_key') {
      const { data: existingAuth } = await supabase
        .from('trader_authorizations')
        .select('id')
        .eq('user_id', user.id)
        .eq('platform', source)
        .eq('trader_id', trader_id)
        .maybeSingle()

      if (!existingAuth) {
        // Get encrypted credentials from exchange connection
        const { data: conn } = await supabase
          .from('user_exchange_connections')
          .select('api_key_encrypted, api_secret_encrypted, passphrase_encrypted')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .maybeSingle()

        if (conn?.api_key_encrypted) {
          await supabase
            .from('trader_authorizations')
            .insert({
              user_id: user.id,
              platform: source,
              trader_id,
              encrypted_api_key: conn.api_key_encrypted,
              encrypted_api_secret: conn.api_secret_encrypted,
              encrypted_passphrase: conn.passphrase_encrypted,
              permissions: ['read'],
              status: 'active',
              last_verified_at: now,
              sync_frequency: 'realtime',
            })
        }
      }
    }

    // Notify
    notifyTraderClaim(user.email ?? null, trader_id, source)

    return success({
      claim,
      message: 'Claim verified and approved! Your profile is now verified.',
      auto_approved: true,
    })
  } catch (error: unknown) {
    return handleError(error, 'trader claim POST')
  }
}
