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
 *   exchange: string,  // must exactly match source after normalization
 *   traderId: string,  // trader's source_trader_id or handle
 *   source: string,    // platform name in Arena DB
 *   apiKey: string,
 *   apiSecret: string,
 *   passphrase?: string,  // required for OKX, Bitget
 * }
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api/response'
import { exchangeApiConnectionSaveResultSchema } from '@/lib/exchange/api-key-lifecycle'
import {
  VERIFY_OWNERSHIP_MAX_PLATFORM_LENGTH,
  VERIFY_OWNERSHIP_MAX_REQUEST_BYTES,
  VERIFY_OWNERSHIP_MAX_VALUE_LENGTH,
  VERIFY_OWNERSHIP_SOURCES,
  verifyOwnershipConnectionExchange,
} from '@/lib/exchange/ownership-verification-contract'
import { resolveExchangeUid } from '@/lib/validators/exchange-uid-resolver'
// Must use the SAME module the sync reader (app/api/exchange/sync) decrypts with.
// lib/crypto/encryption outputs a base64 blob; lib/exchange/encryption outputs
// iv:tag:ct colon-hex. Writing crypto-format here made sync hit its legacy-base64
// branch and decrypt every verify-ownership credential to garbage.
import { encrypt } from '@/lib/exchange/encryption'
import { createLogger } from '@/lib/utils/logger'
import { resolveTrader } from '@/lib/data/unified'
import { getSupabaseAdmin } from '@/lib/supabase/server'

const logger = createLogger('verify-ownership')

const nonBlankCredentialSchema = z
  .string()
  .min(1)
  .max(VERIFY_OWNERSHIP_MAX_VALUE_LENGTH)
  .refine((value) => value.trim().length > 0)

const verifyOwnershipRequestSchema = z
  .object({
    exchange: z
      .string()
      .min(1)
      .max(VERIFY_OWNERSHIP_MAX_PLATFORM_LENGTH)
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.enum(VERIFY_OWNERSHIP_SOURCES)),
    traderId: z
      .string()
      .min(1)
      .max(VERIFY_OWNERSHIP_MAX_VALUE_LENGTH)
      .transform((value) => value.trim())
      .refine((value) => value.length > 0),
    source: z
      .string()
      .min(1)
      .max(VERIFY_OWNERSHIP_MAX_PLATFORM_LENGTH)
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.enum(VERIFY_OWNERSHIP_SOURCES)),
    apiKey: nonBlankCredentialSchema,
    apiSecret: nonBlankCredentialSchema,
    passphrase: nonBlankCredentialSchema.optional(),
  })
  .strict()
  .refine((value) => value.exchange === value.source, {
    message: 'Exchange does not match the trader source',
  })

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'too_large' }

async function readBoundedJson(request: Request): Promise<BoundedJsonResult> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const bytes = Number(declaredLength)
    if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, reason: 'invalid' }
    if (bytes > VERIFY_OWNERSHIP_MAX_REQUEST_BYTES) return { ok: false, reason: 'too_large' }
  }
  if (!request.body) return { ok: false, reason: 'invalid' }

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > VERIFY_OWNERSHIP_MAX_REQUEST_BYTES) {
        await reader.cancel()
        return { ok: false, reason: 'too_large' }
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

export const POST = withAuth(
  async ({ user, request }) => {
    const decodedBody = await readBoundedJson(request)
    if (!decodedBody.ok && decodedBody.reason === 'too_large') {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
    }
    if (!decodedBody.ok) {
      return badRequest('Invalid JSON body')
    }

    const parsedBody = verifyOwnershipRequestSchema.safeParse(decodedBody.value)
    if (!parsedBody.success) {
      return badRequest('Invalid ownership verification request')
    }
    const { apiKey, apiSecret, passphrase, source, traderId } = parsedBody.data
    const connectionExchange = verifyOwnershipConnectionExchange(source)

    // 2. Look up trader's source_trader_id from Arena DB (unified data layer)
    const adminSupabase = getSupabaseAdmin()
    const resolved = await resolveTrader(adminSupabase, {
      handle: traderId,
      platform: source,
    })

    if (!resolved) {
      return notFound('Trader not found in Arena database')
    }
    const traderKey = String(resolved.traderKey).trim()
    if (
      resolved.platform !== source ||
      !traderKey ||
      traderKey.length > VERIFY_OWNERSHIP_MAX_VALUE_LENGTH
    ) {
      logger.error('[verify-ownership] Trader resolver returned a mismatched identity', {
        userId: user.id,
        platform: source,
      })
      return serverError('Could not resolve the requested trader identity')
    }

    // 3. Resolve the UID from the user's API credentials
    // NEVER log the API key or secret
    const resolveResult = await resolveExchangeUid(source, {
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
    const traderSourceId = traderKey

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
      platform: source,
      match: true,
    })

    return NextResponse.json({
      success: true,
      verified: true,
      uid: resolvedUid,
      data: {
        viewerId: parsedSave.data.user_id,
        exchange: parsedSave.data.exchange,
        source,
        traderId: traderSourceId,
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
