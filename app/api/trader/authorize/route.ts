/**
 * POST /api/trader/authorize
 *
 * Save a private, read-only exchange account connection.
 * This endpoint does not claim or publish a public leaderboard profile.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { bindApiKey, revokeApiKey } from '@/lib/services/api-key-binder'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

interface AuthorizeRequest {
  platform: string
  apiKey: string
  apiSecret: string
  passphrase?: string
  label?: string
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

const V1_PUBLIC_ACCOUNT_BINDING_PLATFORMS = new Set(['binance', 'bybit', 'bitget'])
const AUTHORIZE_FIELDS = new Set([
  'platform',
  'apiKey',
  'apiSecret',
  'passphrase',
  'label',
  'syncFrequency',
])
const SYNC_FREQUENCIES = new Set<NonNullable<AuthorizeRequest['syncFrequency']>>([
  'realtime',
  '5min',
  '15min',
  '1hour',
])
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

function privateJson(body: unknown, init?: { status?: number }) {
  return withPrivateNoStore(NextResponse.json(body, init))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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
  if (rateLimitResp) return withPrivateNoStore(rateLimitResp)

  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return privateJson({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = auth

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    if (!isRecord(rawBody)) {
      return privateJson({ error: 'Request body must be an object' }, { status: 400 })
    }
    if (Object.keys(rawBody).some((field) => !AUTHORIZE_FIELDS.has(field))) {
      return privateJson({ error: 'Unknown authorization request fields' }, { status: 400 })
    }

    const { platform, apiKey, apiSecret, passphrase, label, syncFrequency } = rawBody

    // Validate required fields
    if (
      typeof platform !== 'string' ||
      typeof apiKey !== 'string' ||
      typeof apiSecret !== 'string' ||
      !platform.trim() ||
      !apiKey.trim() ||
      !apiSecret.trim() ||
      platform.length > 64 ||
      apiKey.length > 1024 ||
      apiSecret.length > 4096
    ) {
      return privateJson(
        { error: 'Missing required fields: platform, apiKey, apiSecret' },
        { status: 400 }
      )
    }
    const normalizedPlatform = platform.trim().toLowerCase()
    if (!V1_PUBLIC_ACCOUNT_BINDING_PLATFORMS.has(normalizedPlatform)) {
      return privateJson({ error: 'Unsupported V1 account-connection platform' }, { status: 400 })
    }
    if (
      passphrase !== undefined &&
      (typeof passphrase !== 'string' || !passphrase.trim() || passphrase.length > 1024)
    ) {
      return privateJson({ error: 'Invalid passphrase' }, { status: 400 })
    }
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 120)) {
      return privateJson({ error: 'Invalid label' }, { status: 400 })
    }
    if (
      syncFrequency !== undefined &&
      (typeof syncFrequency !== 'string' ||
        !SYNC_FREQUENCIES.has(syncFrequency as NonNullable<AuthorizeRequest['syncFrequency']>))
    ) {
      return privateJson({ error: 'Invalid sync frequency' }, { status: 400 })
    }

    // This is the only live public account-binding endpoint. The retired
    // /api/exchange/connect route returns 410 so no legacy direct table writer
    // can create partial connection/authorization state.
    const result = await bindApiKey(getSupabaseAdmin(), user.id, {
      platform: normalizedPlatform,
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      passphrase: typeof passphrase === 'string' ? passphrase.trim() : undefined,
      label: typeof label === 'string' ? label.trim() : undefined,
      syncFrequency: syncFrequency as AuthorizeRequest['syncFrequency'],
    })

    if (!result.success) {
      const storageFailure = result.errorCode === 'storage_failed'
      logger.warn('[Authorize] API key binding failed', {
        platform: normalizedPlatform,
        userId: user.id,
        errorCode: result.errorCode,
      })

      return privateJson(
        {
          error: storageFailure ? 'Failed to store authorization' : 'API key validation failed',
          details: storageFailure ? undefined : result.error,
        },
        { status: storageFailure ? 500 : 400 }
      )
    }

    if (!result.authorizationId) {
      logger.error('[Authorize] Atomic binder returned success without an authorization id', {
        userId: user.id,
        platform: normalizedPlatform,
      })
      return privateJson({ error: 'Failed to store authorization' }, { status: 500 })
    }

    return privateJson({
      success: true,
      authorizationId: result.authorizationId,
      traderId: result.traderId,
      nickname: result.nickname,
      permissions: result.permissions,
      initialSyncQueued: false,
      publicProfilePublishing: false,
      message:
        'Read-only account connection saved. It is not linked to or publishing a public leaderboard profile.',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    // SECURITY: Do not leak internal error details to client
    return privateJson({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * GET /api/trader/authorize
 *
 * List user's authorizations
 */
export async function GET(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResp) return withPrivateNoStore(rateLimitResp)

  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return privateJson({ error: 'Unauthorized' }, { status: 401 })
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
      return privateJson({ error: 'Failed to fetch authorizations' }, { status: 500 })
    }

    return privateJson({
      authorizations: authorizations || [],
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return privateJson({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/trader/authorize?id=<authorization_id>
 *
 * Revoke authorization
 */
export async function DELETE(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return withPrivateNoStore(rateLimitResp)

  try {
    const auth = await getStrictUser(request)
    if (!auth) {
      return privateJson({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = auth

    // Get authorization ID from query
    const { searchParams } = new URL(request.url)
    const authorizationId = searchParams.get('id')

    if (!authorizationId) {
      return privateJson({ error: 'Missing authorization ID' }, { status: 400 })
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authorizationId)) {
      return privateJson({ error: 'Invalid authorization ID' }, { status: 400 })
    }

    const revoked = await revokeApiKey(getSupabaseAdmin(), user.id, authorizationId)
    if (!revoked.success) {
      if (revoked.errorCode === 'not_found') {
        return privateJson({ error: 'Authorization not found' }, { status: 404 })
      }
      logger.error('[Authorize] Atomic authorization revocation failed', {
        userId: user.id,
        authorizationId,
      })
      return privateJson({ error: 'Failed to revoke authorization' }, { status: 500 })
    }

    return privateJson({
      success: true,
      message: 'Authorization revoked',
    })
  } catch (error) {
    logger.apiError('/api/trader/authorize', error, {})
    return privateJson({ error: 'Internal server error' }, { status: 500 })
  }
}
