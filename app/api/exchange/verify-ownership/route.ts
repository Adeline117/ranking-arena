/**
 * Verify Exchange Account Ownership
 * POST /api/exchange/verify-ownership
 *
 * SECURITY FIX: Now properly validates that the API key belongs to the
 * specific trader being claimed by comparing the account UID from the
 * exchange API with the trader's source_trader_id in Arena DB.
 *
 * Request body:
 * {
 *   exchange: 'binance',
 *   traderId: string,  // trader's source_trader_id or handle
 *   source: string,    // platform name in Arena DB
 *   apiKey: string,
 *   apiSecret: string,
 *   passphrase?: string,  // required for OKX, Bitget
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { resolveExchangeUid, isCexVerifiable } from '@/lib/validators/exchange-uid-resolver'
import { encrypt } from '@/lib/crypto/encryption'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { resolveTrader } from '@/lib/data/unified'

export async function POST(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    // 1. Auth check
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = req.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = req.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const body = await req.json()
    const { exchange, traderId, source, apiKey, apiSecret, passphrase } = body

    if (!exchange || !traderId || !source) {
      return NextResponse.json(
        { error: 'Missing required parameters: exchange, traderId, source' },
        { status: 400 }
      )
    }

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Missing required parameters: apiKey, apiSecret' },
        { status: 400 }
      )
    }

    // Validate this is a CEX platform that supports API key verification
    if (!isCexVerifiable(source)) {
      return NextResponse.json(
        { error: `Platform ${source} does not support API key verification. Use wallet signature for DEX platforms.` },
        { status: 400 }
      )
    }

    // 2. Look up trader's source_trader_id from Arena DB (unified data layer)
    const supabase = getSupabaseAdmin()

    const resolved = await resolveTrader(supabase, {
      handle: traderId,
      platform: source,
    })

    const traderKey = resolved?.traderKey || traderId

    if (!resolved) {
      return NextResponse.json(
        { error: 'Trader not found in Arena database', verified: false },
        { status: 404 }
      )
    }

    // 3. Resolve the UID from the user's API credentials
    // NEVER log the API key or secret
    const resolveResult = await resolveExchangeUid(source, { apiKey, apiSecret, passphrase })

    if (!resolveResult.success || !resolveResult.uid) {
      return NextResponse.json(
        {
          error: 'API key validation failed',
          verified: false,
          message: resolveResult.error || 'Could not validate API credentials',
        },
        { status: 400 }
      )
    }

    // 4. CRITICAL SECURITY CHECK: Compare resolved UID with trader's source_trader_id
    const resolvedUid = resolveResult.uid.trim()
    const traderSourceId = String(traderKey).trim()

    if (resolvedUid !== traderSourceId) {
      logger.warn('[verify-ownership] UID mismatch', {
        userId: user.id,
        platform: source,
        // Log only that there's a mismatch, NOT the actual UIDs for security
        match: false,
      })

      return NextResponse.json(
        {
          error: 'Verification failed',
          verified: false,
          message: 'The API key does not belong to this trader account. Your account UID does not match the trader being claimed.',
        },
        { status: 403 }
      )
    }

    // 5. Store encrypted credentials for future data sync (optional)
    const encryptedApiKey = encrypt(apiKey)
    const encryptedApiSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null

    // Upsert exchange connection for this user
    const { error: upsertError } = await supabase
      .from('user_exchange_connections')
      .upsert(
        {
          user_id: user.id,
          exchange: exchange,
          api_key_encrypted: encryptedApiKey,
          api_secret_encrypted: encryptedApiSecret,
          passphrase_encrypted: encryptedPassphrase,
          is_active: true,
          verified_uid: resolvedUid,
          last_verified_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,exchange' }
      )

    if (upsertError) {
      logger.error('[verify-ownership] Failed to store exchange connection', upsertError)
      return NextResponse.json(
        { error: 'Verification succeeded but failed to store credentials. Please try again.', verified: false },
        { status: 500 }
      )
    }

    logger.info('[verify-ownership] Verification passed', {
      userId: user.id,
      platform: source,
      match: true,
    })

    return NextResponse.json({
      success: true,
      verified: true,
      uid: resolvedUid,
      message: 'Account ownership verified successfully',
    })
  } catch (error: unknown) {
    logger.error('[verify-ownership] Error:', error)
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json(
      { error: 'Verification failed', verified: false },
      { status: 500 }
    )
  }
}
