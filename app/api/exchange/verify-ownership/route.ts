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
import { badRequest, forbidden, notFound, serverError } from '@/lib/api/response'
import { exchangeApiConnectionSaveResultSchema } from '@/lib/exchange/api-key-lifecycle'
import { resolveExchangeUid, isCexVerifiable } from '@/lib/validators/exchange-uid-resolver'
// Must use the SAME module the sync reader (app/api/exchange/sync) decrypts with.
// lib/crypto/encryption outputs a base64 blob; lib/exchange/encryption outputs
// iv:tag:ct colon-hex. Writing crypto-format here made sync hit its legacy-base64
// branch and decrypt every verify-ownership credential to garbage.
import { encrypt } from '@/lib/exchange/encryption'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader } from '@/lib/data/unified'
import { getSupabaseAdmin } from '@/lib/supabase/server'

const logger = createLogger('verify-ownership')

function connectionExchangeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_(futures|spot)$/, '')
}

function comparisonExchangeId(value: string): string {
  const exchange = connectionExchangeId(value)
  if (exchange === 'gate') return 'gateio'
  if (exchange === 'huobi') return 'htx'
  return exchange
}

export const POST = withAuth(
  async ({ user, request }) => {
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

    if (
      typeof exchange !== 'string' ||
      !exchange.trim() ||
      typeof traderId !== 'string' ||
      !traderId.trim() ||
      typeof source !== 'string' ||
      !source.trim()
    ) {
      return badRequest('Missing required parameters: exchange, traderId, source')
    }

    if (
      typeof apiKey !== 'string' ||
      !apiKey.trim() ||
      typeof apiSecret !== 'string' ||
      !apiSecret.trim()
    ) {
      return badRequest('Missing required parameters: apiKey, apiSecret')
    }

    const normalizedSource = source.trim().toLowerCase()
    const requestedTraderId = traderId.trim()
    const connectionExchange = connectionExchangeId(normalizedSource)
    if (comparisonExchangeId(exchange) !== comparisonExchangeId(normalizedSource)) {
      return badRequest('Exchange does not match the trader source')
    }

    // Validate this is a CEX platform that supports API key verification
    if (!isCexVerifiable(normalizedSource)) {
      return badRequest(
        `Platform ${normalizedSource} does not support API key verification. Use wallet signature for DEX platforms.`
      )
    }

    // 2. Look up trader's source_trader_id from Arena DB (unified data layer)
    const adminSupabase = getSupabaseAdmin()
    const resolved = await resolveTrader(adminSupabase, {
      handle: requestedTraderId,
      platform: normalizedSource,
    })

    const traderKey = resolved?.traderKey || requestedTraderId

    if (!resolved) {
      return notFound('Trader not found in Arena database')
    }

    // 3. Resolve the UID from the user's API credentials
    // NEVER log the API key or secret
    const resolveResult = await resolveExchangeUid(normalizedSource, {
      apiKey,
      apiSecret,
      passphrase,
    })

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

    if (resolveResult.isReadOnly !== true) {
      return NextResponse.json(
        {
          error: 'Read-only API key required',
          verified: false,
          message:
            'Disable trading, withdrawal, and transfer permissions on this API key before connecting it.',
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
        platform: normalizedSource,
        // Log only that there's a mismatch, NOT the actual UIDs for security
        match: false,
      })

      return NextResponse.json(
        {
          error: 'Verification failed',
          verified: false,
          message:
            'The API key does not belong to this trader account. Your account UID does not match the trader being claimed.',
        },
        { status: 403 }
      )
    }

    // 5. Store encrypted credentials for future data sync (optional)
    const encryptedApiKey = encrypt(apiKey)
    const encryptedApiSecret = encrypt(apiSecret)
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null

    // UID resolution happens outside PostgreSQL. Persist the proof only after
    // reacquiring the canonical account lifecycle lock, so a concurrent
    // moderation/deletion transaction cannot be followed by reactivation.
    const { data: saveResult, error: upsertError } = await adminSupabase.rpc(
      'upsert_exchange_api_connection_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_exchange: connectionExchange,
        p_api_key_encrypted: encryptedApiKey,
        p_api_secret_encrypted: encryptedApiSecret,
        p_passphrase_encrypted: encryptedPassphrase,
        p_verified_uid: resolvedUid,
        p_scope_permissions: resolveResult.permissions?.length
          ? resolveResult.permissions
          : ['read'],
      }
    )

    if (upsertError) {
      logger.error('[verify-ownership] Failed to store exchange connection', {
        code: upsertError.code,
        userId: user.id,
      })
      return serverError(
        'Verification succeeded but failed to store credentials. Please try again.'
      )
    }

    const parsedSave = exchangeApiConnectionSaveResultSchema.safeParse(saveResult)
    if (!parsedSave.success) {
      logger.error('[verify-ownership] Invalid atomic persistence acknowledgement', {
        userId: user.id,
      })
      return serverError(
        'Verification succeeded but failed to store credentials. Please try again.'
      )
    }
    if (parsedSave.data.status === 'suspended' || parsedSave.data.status === 'missing_account') {
      return forbidden('Account unavailable')
    }
    if (
      parsedSave.data.status !== 'saved' ||
      parsedSave.data.user_id !== user.id ||
      parsedSave.data.exchange !== connectionExchange ||
      !parsedSave.data.verified
    ) {
      logger.error('[verify-ownership] Atomic persistence was rejected', {
        status: parsedSave.data.status,
        userId: user.id,
      })
      return serverError(
        'Verification succeeded but failed to store credentials. Please try again.'
      )
    }

    logger.info('[verify-ownership] Verification passed', {
      userId: user.id,
      platform: normalizedSource,
      match: true,
    })

    return NextResponse.json({
      success: true,
      verified: true,
      uid: resolvedUid,
      data: {
        viewerId: parsedSave.data.user_id,
        exchange: parsedSave.data.exchange,
        source: normalizedSource,
        traderId: requestedTraderId,
        verifiedUid: resolvedUid,
      },
      message: 'Account ownership verified successfully',
    })
  },
  {
    name: 'verify-ownership',
    rateLimit: 'sensitive',
  }
)
