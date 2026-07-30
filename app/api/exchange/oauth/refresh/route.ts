import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { encryptOAuthToken, decryptOAuthToken } from '@/lib/exchange/oauth-token-encryption'
import { fetchOAuthJsonWithTimeout } from '@/lib/exchange/oauth-http'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

type RefreshConfig = {
  clientId: string
  clientSecret: string
  tokenUrl: string
}

const REFRESH_CONFIG: Record<string, RefreshConfig> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BINANCE_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://accounts.binance.com/oauth/token',
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BYBIT_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://api.bybit.com/v5/account/oauth/token',
  },
}

type RefreshConnection = {
  id: string
  user_id: string
  exchange: string
  refresh_token_encrypted: string
}

type RefreshFailure = 'reauth_required' | 'retryable'

type RefreshLease = {
  claimId: string
  expiresAt: number
  tokenCiphertext: string
  storedValue: string
}

const REFRESH_LEASE_PREFIX = 'refresh-lease-v1'
const REFRESH_LEASE_MS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function classifyUpstreamFailure(status: number, payload: unknown): RefreshFailure {
  const errorCode = isRecord(payload) && typeof payload.error === 'string' ? payload.error : ''
  if (status === 401 || errorCode === 'invalid_grant' || errorCode === 'invalid_token') {
    return 'reauth_required'
  }
  return 'retryable'
}

function parseExpiresIn(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseRefreshLease(value: string): RefreshLease | null {
  const parts = value.split(':')
  if (
    parts.length !== 4 ||
    parts[0] !== REFRESH_LEASE_PREFIX ||
    !/^\d{13}$/.test(parts[1]) ||
    !/^[0-9a-f]{32}$/.test(parts[2]) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[3])
  ) {
    return null
  }
  const expiresAt = Number(parts[1])
  const tokenCiphertext = Buffer.from(parts[3], 'base64url').toString('utf8')
  if (
    !Number.isSafeInteger(expiresAt) ||
    !tokenCiphertext ||
    Buffer.from(tokenCiphertext, 'utf8').toString('base64url') !== parts[3]
  ) {
    return null
  }
  return {
    claimId: parts[2],
    expiresAt,
    tokenCiphertext,
    storedValue: value,
  }
}

function createRefreshLease(tokenCiphertext: string): RefreshLease {
  const claimId = crypto.randomBytes(16).toString('hex')
  const expiresAt = Date.now() + REFRESH_LEASE_MS
  const encodedCiphertext = Buffer.from(tokenCiphertext, 'utf8').toString('base64url')
  const storedValue = `${REFRESH_LEASE_PREFIX}:${expiresAt}:${claimId}:${encodedCiphertext}`
  return { claimId, expiresAt, tokenCiphertext, storedValue }
}

function hasExactRefreshClaim(
  raw: unknown,
  expected: {
    connectionId: string
    userId: string
    exchange: string
    lease: string
  }
): boolean {
  return (
    isRecord(raw) &&
    raw.success === true &&
    raw.status === 'claimed' &&
    raw.connection_id === expected.connectionId &&
    raw.user_id === expected.userId &&
    raw.exchange === expected.exchange &&
    raw.refresh_token_encrypted === expected.lease
  )
}

function refreshClaimFailureStatus(raw: unknown): { error: string; status: number } | null {
  if (!isRecord(raw) || raw.success !== false) return null
  switch (raw.reason) {
    case 'ACTOR_UNAVAILABLE':
      return { error: 'Account unavailable', status: 403 }
    case 'CONNECTION_CHANGED':
      return { error: 'Connection changed during refresh', status: 409 }
    case 'INVALID':
      return { error: 'Failed to initialize token refresh', status: 500 }
    default:
      return null
  }
}

/**
 * POST: refresh an OAuth access token for the authenticated viewer.
 *
 * A short, recoverable lease is installed in the refresh-token column before
 * contacting the provider. This prevents two server instances from rotating
 * the same provider token concurrently. Every later write is fenced by the
 * exact viewer/exchange/lease generation.
 */
export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const csrfHeader = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(csrfCookie, csrfHeader)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const exchange =
      isRecord(rawBody) && typeof rawBody.exchange === 'string'
        ? rawBody.exchange.trim().toLowerCase()
        : ''
    if (!exchange) {
      return NextResponse.json({ error: 'Missing exchange' }, { status: 400 })
    }

    const config = REFRESH_CONFIG[exchange]
    if (!config || !config.clientId || !config.clientSecret) {
      return NextResponse.json({ error: `Refresh not configured for ${exchange}` }, { status: 400 })
    }

    const encryptionKey = process.env.ENCRYPTION_KEY
    if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
      logger.error('OAuth refresh encryption key is missing or invalid')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const userId = user.id
    const supabase = getSupabaseAdmin()
    const { data: rawConnection, error: connectionError } = await supabase
      .from('user_exchange_connections')
      .select('id, user_id, exchange, refresh_token_encrypted')
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .eq('is_active', true)
      .single()

    if (connectionError || !rawConnection) {
      return NextResponse.json({ error: 'Active connection not found' }, { status: 404 })
    }
    if (
      rawConnection.user_id !== userId ||
      rawConnection.exchange !== exchange ||
      typeof rawConnection.refresh_token_encrypted !== 'string' ||
      rawConnection.refresh_token_encrypted.length === 0
    ) {
      logger.error('OAuth refresh connection identity mismatch', {
        connectionId: rawConnection.id,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Connection identity mismatch' }, { status: 409 })
    }
    const connection: RefreshConnection = {
      id: rawConnection.id,
      user_id: rawConnection.user_id,
      exchange: rawConnection.exchange,
      refresh_token_encrypted: rawConnection.refresh_token_encrypted,
    }

    const existingLease = parseRefreshLease(connection.refresh_token_encrypted)
    if (
      connection.refresh_token_encrypted.startsWith(`${REFRESH_LEASE_PREFIX}:`) &&
      !existingLease
    ) {
      logger.error('Stored OAuth refresh lease is malformed', {
        connectionId: connection.id,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Stored OAuth credential is invalid' }, { status: 409 })
    }
    if (existingLease && existingLease.expiresAt > Date.now()) {
      return NextResponse.json({ error: 'Token refresh already in progress' }, { status: 409 })
    }
    const tokenCiphertext = existingLease?.tokenCiphertext ?? connection.refresh_token_encrypted

    let refreshToken: string
    try {
      refreshToken = decryptOAuthToken(tokenCiphertext, encryptionKey, {
        viewerId: userId,
        exchange,
        purpose: 'refresh',
      })
    } catch (decryptError) {
      logger.error('Stored OAuth refresh token failed authentication', {
        connectionId: connection.id,
        error: decryptError,
        exchange,
        userId,
      })
      return NextResponse.json(
        { error: 'Stored OAuth credential is invalid; re-authenticate' },
        { status: 409 }
      )
    }

    const refreshLease = createRefreshLease(tokenCiphertext)
    const { data: claimedConnection, error: claimError } = await supabase.rpc(
      'claim_exchange_oauth_refresh_atomic',
      {
        p_user_id: userId,
        p_exchange: exchange,
        p_connection_id: connection.id,
        p_expected_refresh_token_encrypted: connection.refresh_token_encrypted,
        p_lease_refresh_token_encrypted: refreshLease.storedValue,
      }
    )

    if (claimError) {
      logger.error('Failed to claim OAuth refresh generation', {
        connectionId: connection.id,
        error: claimError,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Failed to initialize token refresh' }, { status: 500 })
    }
    if (
      !hasExactRefreshClaim(claimedConnection, {
        connectionId: connection.id,
        userId,
        exchange,
        lease: refreshLease.storedValue,
      })
    ) {
      const failure = refreshClaimFailureStatus(claimedConnection)
      if (failure) {
        return NextResponse.json({ error: failure.error }, { status: failure.status })
      }
      logger.error('OAuth refresh claim ACK identity mismatch', {
        acknowledgement: claimedConnection,
        connectionId: connection.id,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Refresh claim acknowledgement mismatch' }, { status: 500 })
    }

    const markFailure = async (
      failure: RefreshFailure
    ): Promise<'recorded' | 'stale' | 'error'> => {
      const attemptedAt = new Date().toISOString()
      const { data, error } = await supabase
        .from('user_exchange_connections')
        .update({
          // Release the lease back to the exact pre-refresh token generation.
          refresh_token_encrypted: tokenCiphertext,
          // A refresh failure never disables a connection. Only an explicit
          // disconnect/revocation path owns is_active.
          last_sync_at: attemptedAt,
          last_sync_status: 'error',
          last_sync_error:
            failure === 'reauth_required'
              ? 'OAuth token refresh requires re-authorization'
              : 'OAuth token refresh temporarily unavailable',
        })
        .eq('id', connection.id)
        .eq('user_id', userId)
        .eq('exchange', exchange)
        .eq('is_active', true)
        .eq('refresh_token_encrypted', refreshLease.storedValue)
        .select('id, user_id, exchange, refresh_token_encrypted')
        .maybeSingle()

      if (error) {
        logger.error('Failed to record OAuth refresh failure', {
          connectionId: connection.id,
          error,
          exchange,
          userId,
        })
        return 'error'
      }
      if (!data) return 'stale'
      if (
        data.id !== connection.id ||
        data.user_id !== userId ||
        data.exchange !== exchange ||
        data.refresh_token_encrypted !== tokenCiphertext
      ) {
        logger.error('OAuth refresh failure ACK identity mismatch', {
          connectionId: connection.id,
          exchange,
          userId,
        })
        return 'error'
      }
      return 'recorded'
    }

    const failureResponse = async (failure: RefreshFailure) => {
      const outcome = await markFailure(failure)
      if (outcome === 'stale') {
        return NextResponse.json({ error: 'Connection changed during refresh' }, { status: 409 })
      }
      if (outcome === 'error') {
        return NextResponse.json({ error: 'Failed to record refresh result' }, { status: 500 })
      }
      return failure === 'reauth_required'
        ? NextResponse.json({ error: 'Token refresh requires re-authentication' }, { status: 401 })
        : NextResponse.json({ error: 'Token refresh temporarily unavailable' }, { status: 503 })
    }

    const refreshParams = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    })

    let tokenResponse: Awaited<ReturnType<typeof fetchOAuthJsonWithTimeout>>
    try {
      tokenResponse = await fetchOAuthJsonWithTimeout(
        config.tokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: refreshParams.toString(),
        },
        20_000
      )
    } catch (fetchError) {
      logger.warn('OAuth token refresh transport failed', {
        connectionId: connection.id,
        error: fetchError,
        exchange,
        userId,
      })
      return failureResponse('retryable')
    }

    if (!tokenResponse.ok) {
      const failure = classifyUpstreamFailure(tokenResponse.status, tokenResponse.data)
      logger.warn('OAuth token refresh rejected by provider', {
        connectionId: connection.id,
        exchange,
        status: tokenResponse.status,
        userId,
      })
      return failureResponse(failure)
    }

    const tokenPayload = tokenResponse.data
    const accessToken =
      isRecord(tokenPayload) && typeof tokenPayload.access_token === 'string'
        ? tokenPayload.access_token
        : ''
    const rotatedRefreshToken =
      isRecord(tokenPayload) && typeof tokenPayload.refresh_token === 'string'
        ? tokenPayload.refresh_token
        : refreshToken
    if (!accessToken || !rotatedRefreshToken) {
      logger.error('OAuth provider returned a malformed refresh response', {
        connectionId: connection.id,
        exchange,
        userId,
      })
      return failureResponse('retryable')
    }

    const expiresIn = isRecord(tokenPayload) ? parseExpiresIn(tokenPayload.expires_in) : null
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
    const encryptedAccessToken = encryptOAuthToken(accessToken, encryptionKey, {
      viewerId: userId,
      exchange,
      purpose: 'access',
    })
    // Always rewrite the refresh token. This transparently migrates a legacy
    // CBC row to authenticated v2 GCM even when the provider does not rotate.
    const encryptedRefreshToken = encryptOAuthToken(rotatedRefreshToken, encryptionKey, {
      viewerId: userId,
      exchange,
      purpose: 'refresh',
    })
    const refreshedAt = new Date().toISOString()

    const { data: updatedConnection, error: updateError } = await supabase
      .from('user_exchange_connections')
      .update({
        access_token_encrypted: encryptedAccessToken,
        refresh_token_encrypted: encryptedRefreshToken,
        expires_at: expiresAt,
        last_sync_at: refreshedAt,
        last_sync_status: 'success',
        last_sync_error: null,
      })
      .eq('id', connection.id)
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .eq('is_active', true)
      .eq('refresh_token_encrypted', refreshLease.storedValue)
      .select(
        'id, user_id, exchange, access_token_encrypted, refresh_token_encrypted, expires_at, last_sync_status'
      )
      .maybeSingle()

    if (updateError) {
      logger.error('Failed to publish refreshed OAuth tokens', {
        connectionId: connection.id,
        error: updateError,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Failed to save new tokens' }, { status: 500 })
    }
    if (!updatedConnection) {
      return NextResponse.json({ error: 'Connection changed during refresh' }, { status: 409 })
    }
    if (
      updatedConnection.id !== connection.id ||
      updatedConnection.user_id !== userId ||
      updatedConnection.exchange !== exchange ||
      updatedConnection.access_token_encrypted !== encryptedAccessToken ||
      updatedConnection.refresh_token_encrypted !== encryptedRefreshToken ||
      updatedConnection.last_sync_status !== 'success'
    ) {
      logger.error('OAuth refresh success ACK identity mismatch', {
        connectionId: connection.id,
        exchange,
        userId,
      })
      return NextResponse.json({ error: 'Refresh acknowledgement mismatch' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      // Preserve the legacy field while new callers require data identity.
      expiresAt: updatedConnection.expires_at,
      data: {
        viewerId: userId,
        exchange,
        connectionId: connection.id,
        expiresAt: updatedConnection.expires_at,
      },
    })
  } catch (error: unknown) {
    logger.error('Error refreshing OAuth token', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
