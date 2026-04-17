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

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, notFound, serverError } from '@/lib/api/response'
import { resolveExchangeUid, isCexVerifiable } from '@/lib/validators/exchange-uid-resolver'
import { encrypt } from '@/lib/crypto/encryption'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader } from '@/lib/data/unified'

const logger = createLogger('verify-ownership')

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { exchange, traderId, source, apiKey, apiSecret, passphrase } = body as {
      exchange?: string
      traderId?: string
      source?: string
      apiKey?: string
      apiSecret?: string
      passphrase?: string
    }

    if (!exchange || !traderId || !source) {
      return badRequest('Missing required parameters: exchange, traderId, source')
    }

    if (!apiKey || !apiSecret) {
      return badRequest('Missing required parameters: apiKey, apiSecret')
    }

    // Validate this is a CEX platform that supports API key verification
    if (!isCexVerifiable(source)) {
      return badRequest(`Platform ${source} does not support API key verification. Use wallet signature for DEX platforms.`)
    }

    // 2. Look up trader's source_trader_id from Arena DB (unified data layer)
    const resolved = await resolveTrader(supabase, {
      handle: traderId,
      platform: source,
    })

    const traderKey = resolved?.traderKey || traderId

    if (!resolved) {
      return notFound('Trader not found in Arena database')
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
      return serverError('Verification succeeded but failed to store credentials. Please try again.')
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
  },
  {
    name: 'verify-ownership',
    rateLimit: 'sensitive',
  }
)
