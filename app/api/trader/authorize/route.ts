/**
 * POST /api/trader/authorize
 *
 * Authorize trader to display real trading data
 * Validates API key and stores encrypted credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { encryptAuthorizationCredential } from '@/lib/exchange/authorization-credentials'
import { validateExchangeApiKey } from '@/lib/validators/api-key-validator'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { enqueueFirstPartySync } from '@/lib/ingest/first-party/enqueue'

export const dynamic = 'force-dynamic'

interface AuthorizeRequest {
  platform: string
  apiKey: string
  apiSecret: string
  passphrase?: string
  label?: string
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

async function getStrictUser(request: NextRequest) {
  // Keep this endpoint bearer-only. Database access is service-scoped below,
  // so ownership must always be expressed explicitly in every query.
  const authHeader = request.headers.get('authorization')
  const match = authHeader?.match(/^Bearer\s+(\S+)$/i)
  if (!match) return null

  return getAuthUser(request)
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = auth

    // Parse request body
    const body: AuthorizeRequest = await request.json()
    const { platform, apiKey, apiSecret, passphrase, label, syncFrequency } = body

    // Validate required fields
    if (!platform || !apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: platform, apiKey, apiSecret' },
        { status: 400 }
      )
    }

    // Validate platform
    const validPlatforms = [
      'binance',
      'binance_futures',
      'binance_spot',
      'bybit',
      'bybit_spot',
      'okx',
      'okx_futures',
      'bitget',
      'bitget_futures',
      'bitget_spot',
    ]

    if (!validPlatforms.includes(platform.toLowerCase())) {
      return NextResponse.json({ error: `Unsupported platform: ${platform}` }, { status: 400 })
    }

    // Validate API key with exchange
    const validationResult = await validateExchangeApiKey(platform, {
      apiKey,
      apiSecret,
      passphrase,
    })

    if (!validationResult.isValid) {
      logger.warn('[Authorize] API key validation failed', {
        platform,
        userId: user.id,
        error: validationResult.error,
      })

      return NextResponse.json(
        {
          error: 'API key validation failed',
          details: validationResult.error,
        },
        { status: 400 }
      )
    }

    // Encrypt credentials
    const encryptedApiKey = encryptAuthorizationCredential(apiKey)
    const encryptedApiSecret = encryptAuthorizationCredential(apiSecret)
    const encryptedPassphrase = passphrase ? encryptAuthorizationCredential(passphrase) : null
    const now = new Date().toISOString()

    // Use service role client for database write
    const supabaseService = getSupabaseAdmin()

    // Check if authorization already exists
    const { data: existing } = await supabaseService
      .from('trader_authorizations')
      .select('id')
      .eq('user_id', user.id)
      .eq('platform', platform)
      .eq('trader_id', validationResult.traderId!)
      .single()

    let authorizationId: string

    if (existing) {
      // Update existing authorization
      const { data: updated, error: updateError } = await supabaseService
        .from('trader_authorizations')
        .update({
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validationResult.permissions || [],
          read_only_verified_at: now,
          status: 'active',
          last_verified_at: now,
          last_sync_at: null,
          last_sync_status: 'pending',
          consecutive_failures: 0,
          verification_error: null,
          label,
          sync_frequency: syncFrequency || 'realtime',
          updated_at: now,
        })
        .eq('id', existing.id)
        .select('id')
        .single()

      if (updateError) {
        logger.dbError('update-authorization', updateError, {
          userId: user.id,
          platform,
        })
        return NextResponse.json({ error: 'Failed to update authorization' }, { status: 500 })
      }

      authorizationId = updated!.id
    } else {
      // Create new authorization
      const { data: created, error: createError } = await supabaseService
        .from('trader_authorizations')
        .insert({
          user_id: user.id,
          platform,
          trader_id: validationResult.traderId!,
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validationResult.permissions || [],
          read_only_verified_at: now,
          status: 'active',
          last_verified_at: now,
          last_sync_status: 'pending',
          label,
          sync_frequency: syncFrequency || 'realtime',
        })
        .select('id')
        .single()

      if (createError) {
        logger.dbError('create-authorization', createError, {
          userId: user.id,
          platform,
        })
        return NextResponse.json({ error: 'Failed to create authorization' }, { status: 500 })
      }

      authorizationId = created!.id
    }

    // Queue the canonical worker pipeline. The periodic worker scheduler is the
    // durability fallback, but a successful bind should not wait for its next pass.
    const initialSyncQueued = await enqueueFirstPartySync(authorizationId)

    return NextResponse.json({
      success: true,
      authorizationId,
      traderId: validationResult.traderId,
      nickname: validationResult.nickname,
      permissions: validationResult.permissions,
      initialSyncQueued,
      message: initialSyncQueued
        ? 'Authorization successful! Your live trading data is queued for verification.'
        : 'Authorization saved. The background scheduler will verify it shortly.',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * GET /api/trader/authorize
 *
 * List user's authorizations
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = auth
    const supabase = getSupabaseAdmin()

    // Return only the safe status projection; encrypted credentials and OAuth
    // tokens never leave the service boundary.
    const { data: authorizations, error } = await supabase
      .from('trader_authorizations')
      .select(
        'id, platform, trader_id, status, permissions, label, sync_frequency, read_only_verified_at, last_sync_at, last_sync_status, verification_error, created_at'
      )
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (error) {
      logger.dbError('fetch-authorizations', error, { userId: user.id })
      return NextResponse.json({ error: 'Failed to fetch authorizations' }, { status: 500 })
    }

    return NextResponse.json({
      authorizations: authorizations || [],
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/trader/authorize?id=<authorization_id>
 *
 * Revoke authorization
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = auth

    // Get authorization ID from query
    const { searchParams } = new URL(request.url)
    const authorizationId = searchParams.get('id')

    if (!authorizationId) {
      return NextResponse.json({ error: 'Missing authorization ID' }, { status: 400 })
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authorizationId)) {
      return NextResponse.json({ error: 'Invalid authorization ID' }, { status: 400 })
    }

    // The service client bypasses RLS, so both identifiers are mandatory. The
    // returned row proves that this caller actually owned the target.
    const { data: revoked, error } = await getSupabaseAdmin()
      .from('trader_authorizations')
      .update({
        status: 'revoked',
        updated_at: new Date().toISOString(),
      })
      .eq('id', authorizationId)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle()

    if (error) {
      logger.dbError('revoke-authorization', error, {
        userId: user.id,
        authorizationId,
      })
      return NextResponse.json({ error: 'Failed to revoke authorization' }, { status: 500 })
    }
    if (!revoked) {
      return NextResponse.json({ error: 'Authorization not found' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      message: 'Authorization revoked',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
