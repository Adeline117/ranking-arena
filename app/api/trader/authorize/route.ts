/**
 * POST /api/trader/authorize
 *
 * Authorize trader to display real trading data
 * Validates API key and stores encrypted credentials
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { bindApiKey } from '@/lib/services/api-key-binder'
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

    // The shared binder performs exchange verification, canonical encryption,
    // and a single lifecycle-locked transaction for both credential tables.
    // Keeping a second direct writer here previously allowed a validation that
    // started before a ban to reactivate credentials after the ban committed.
    const bindResult = await bindApiKey(getSupabaseAdmin(), user.id, {
      platform,
      apiKey,
      apiSecret,
      passphrase,
      label,
      syncFrequency,
    })

    if (!bindResult.success) {
      logger.warn('[Authorize] API key validation failed', {
        platform,
        userId: user.id,
        reason: bindResult.reason,
      })

      return NextResponse.json(
        {
          error:
            bindResult.reason === 'account_unavailable'
              ? 'Account unavailable'
              : bindResult.reason === 'persistence_failed'
                ? 'Failed to store authorization'
                : 'API key validation failed',
          details: bindResult.reason === 'persistence_failed' ? undefined : bindResult.error,
        },
        {
          status:
            bindResult.reason === 'account_unavailable'
              ? 403
              : bindResult.reason === 'persistence_failed'
                ? 500
                : 400,
        }
      )
    }
    if (!bindResult.authorizationId || !bindResult.traderId) {
      logger.error('[Authorize] Binder returned an incomplete success acknowledgement', {
        userId: user.id,
        platform,
      })
      return NextResponse.json({ error: 'Failed to store authorization' }, { status: 500 })
    }

    const authorizationId = bindResult.authorizationId

    // Queue the canonical worker pipeline. The periodic worker scheduler is the
    // durability fallback, but a successful bind should not wait for its next pass.
    const initialSyncQueued = await enqueueFirstPartySync(authorizationId)

    return NextResponse.json({
      success: true,
      authorizationId,
      traderId: bindResult.traderId,
      nickname: bindResult.nickname,
      permissions: bindResult.permissions,
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
