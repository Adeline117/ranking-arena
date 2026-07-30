import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/utils/logger'
import { encryptOAuthToken } from '@/lib/exchange/oauth-token-encryption'
import { fetchOAuthJsonWithTimeout } from '@/lib/exchange/oauth-http'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'

const logger = createLogger('exchange-oauth-callback')

type OAuthStateClaim = {
  status?: unknown
  id?: unknown
  code_verifier?: unknown
  claim_token?: unknown
}

type OAuthCompletion = {
  connectionId: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseExpiresIn(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 366 * 24 * 60 * 60 ? parsed : null
}

function providerErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) return 'Failed to exchange token'
  const message =
    typeof payload.error_description === 'string'
      ? payload.error_description
      : typeof payload.error === 'string'
        ? payload.error
        : ''
  return message.length > 0 && message.length <= 200 ? message : 'Failed to exchange token'
}

function parseClaim(
  raw: unknown
): { id: string; codeVerifier: string | null; claimToken: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const claim = raw as OAuthStateClaim
  if (
    claim.status !== 'claimed' ||
    typeof claim.id !== 'string' ||
    !UUID_PATTERN.test(claim.id) ||
    typeof claim.claim_token !== 'string' ||
    !UUID_PATTERN.test(claim.claim_token) ||
    (claim.code_verifier !== null && typeof claim.code_verifier !== 'string')
  ) {
    return null
  }
  return {
    id: claim.id,
    codeVerifier: claim.code_verifier,
    claimToken: claim.claim_token,
  }
}

function parseCompletion(
  raw: unknown,
  expected: {
    userId: string
    exchange: string
    stateId: string
  }
): OAuthCompletion | null {
  if (!isRecord(raw) || raw.success !== true || raw.status !== 'connected') return null
  if (
    raw.user_id !== expected.userId ||
    raw.exchange !== expected.exchange ||
    raw.state_id !== expected.stateId ||
    typeof raw.connection_id !== 'string' ||
    !UUID_PATTERN.test(raw.connection_id)
  ) {
    return null
  }
  return { connectionId: raw.connection_id }
}

function completionFailureStatus(raw: unknown): { error: string; status: number } | null {
  if (!isRecord(raw) || raw.success !== false) return null
  switch (raw.reason) {
    case 'ACTOR_UNAVAILABLE':
      return { error: 'Account unavailable', status: 403 }
    case 'STALE_CLAIM':
      return { error: 'Authorization state changed; please retry', status: 409 }
    case 'INVALID':
      return { error: 'Invalid authorization result', status: 400 }
    default:
      return null
  }
}

// OAuth Token 交换配置（根据 Binance 官方文档）
const TOKEN_CONFIG: Record<
  string,
  {
    clientId: string
    clientSecret: string
    tokenUrl: string
    redirectUri: string
    userInfoUrl?: string
  }
> = {
  binance: {
    clientId: process.env.BINANCE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BINANCE_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://accounts.binance.com/oauth/token',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
    userInfoUrl: 'https://www.binanceapis.com/oauth-api/v1/user-info',
  },
  bybit: {
    clientId: process.env.BYBIT_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.BYBIT_OAUTH_CLIENT_SECRET || '',
    tokenUrl: 'https://api.bybit.com/v5/account/oauth/token',
    redirectUri: `${env.NEXT_PUBLIC_APP_URL}/exchange/auth/callback`,
  },
}

/**
 * POST: 用授权码交换 Access Token
 */
export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // Auth check - use authenticated user's ID
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const csrfCookie = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const csrfHeader = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(csrfCookie, csrfHeader)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const rawBody: unknown = await request.json()
    const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {}
    const exchange = typeof body.exchange === 'string' ? body.exchange.trim() : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const state = typeof body.state === 'string' ? body.state.trim() : ''
    const userId = user.id // Use authenticated user ID, not from body

    if (!exchange || !code || state.length < 32 || state.length > 512) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // 获取 token 配置
    const config = TOKEN_CONFIG[exchange]
    if (!config || !config.clientId) {
      return NextResponse.json({ error: `OAuth not configured for ${exchange}` }, { status: 400 })
    }

    const encryptionKey = process.env.ENCRYPTION_KEY
    if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
      logger.error('ENCRYPTION_KEY not configured or invalid')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    // Claim state in one database statement. The lease is released on every
    // retryable failure and fenced by a random token so a stale worker cannot
    // consume a state reclaimed by a newer callback.
    const { data: rawClaim, error: claimError } = await supabase.rpc(
      'claim_exchange_oauth_state_atomic',
      {
        p_user_id: userId,
        p_exchange: exchange,
        p_state: state,
        p_lease_seconds: 300,
      }
    )
    if (claimError) {
      logger.error('Failed to claim OAuth state', { error: claimError, userId, exchange })
      return NextResponse.json({ error: 'Failed to validate OAuth state' }, { status: 500 })
    }
    const stateClaim = parseClaim(rawClaim)
    if (!stateClaim) {
      return NextResponse.json(
        { error: 'Invalid, expired, or already used state' },
        { status: 400 }
      )
    }

    let claimConsumed = false

    try {
      // 构建 token 交换参数
      // Binance 使用 application/x-www-form-urlencoded 格式
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
      })

      // 根据是否使用 PKCE 选择认证方式
      if (stateClaim.codeVerifier) {
        // PKCE 流程：使用 code_verifier
        tokenParams.append('code_verifier', stateClaim.codeVerifier)
      } else {
        // 标准流程：使用 client_secret
        tokenParams.append('client_secret', config.clientSecret)
      }

      // 交换 code 获取 access_token
      const tokenResponse = await fetchOAuthJsonWithTimeout(
        config.tokenUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: tokenParams.toString(),
        },
        20_000
      )

      if (!tokenResponse.ok) {
        logger.error('Token exchange failed', { exchange, status: tokenResponse.status })
        return NextResponse.json(
          { error: providerErrorMessage(tokenResponse.data) },
          { status: 400 }
        )
      }

      const tokenData = tokenResponse.data
      const accessToken =
        isRecord(tokenData) && typeof tokenData.access_token === 'string'
          ? tokenData.access_token
          : ''
      const refreshToken =
        isRecord(tokenData) && typeof tokenData.refresh_token === 'string'
          ? tokenData.refresh_token
          : null
      const expiresIn = isRecord(tokenData) ? parseExpiresIn(tokenData.expires_in) : null

      if (!accessToken) {
        return NextResponse.json({ error: 'No access token received' }, { status: 400 })
      }

      // 加密存储 tokens
      const encryptedAccessToken = encryptOAuthToken(accessToken, encryptionKey, {
        viewerId: userId,
        exchange,
        purpose: 'access',
      })
      const encryptedRefreshToken = refreshToken
        ? encryptOAuthToken(refreshToken, encryptionKey, {
            viewerId: userId,
            exchange,
            purpose: 'refresh',
          })
        : null

      // 计算过期时间
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null

      // 尝试获取用户信息
      let exchangeUserId: string | null = null
      if (config.userInfoUrl) {
        try {
          const userInfoResponse = await fetchOAuthJsonWithTimeout(
            config.userInfoUrl,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
            10_000
          )
          if (userInfoResponse.ok) {
            const userInfo = userInfoResponse.data
            // Binance 返回格式: { code: "000000", data: { userId: "...", email: "..." } }
            if (
              isRecord(userInfo) &&
              isRecord(userInfo.data) &&
              (typeof userInfo.data.userId === 'string' || typeof userInfo.data.userId === 'number')
            ) {
              exchangeUserId = String(userInfo.data.userId)
            }
          }
        } catch (e: unknown) {
          logger.warn('Failed to fetch user info', { error: e, exchange })
        }
      }

      // Publish credentials and consume the exact state lease in the same
      // active-account transaction. A concurrent ban/delete therefore wins
      // either before publication or immediately quiesces the committed row.
      const { data: completionData, error: completionError } = await supabase.rpc(
        'complete_exchange_oauth_callback_atomic',
        {
          p_user_id: userId,
          p_exchange: exchange,
          p_state: state,
          p_state_id: stateClaim.id,
          p_claim_token: stateClaim.claimToken,
          p_exchange_user_id: exchangeUserId,
          p_access_token_encrypted: encryptedAccessToken,
          p_refresh_token_encrypted: encryptedRefreshToken,
          p_expires_at: expiresAt,
        }
      )
      if (completionError) {
        logger.error('Failed to complete OAuth credential transaction', {
          error: completionError,
          userId,
          exchange,
        })
        return NextResponse.json({ error: 'Failed to finalize authorization' }, { status: 500 })
      }
      const completion = parseCompletion(completionData, {
        userId,
        exchange,
        stateId: stateClaim.id,
      })
      if (!completion) {
        const failure = completionFailureStatus(completionData)
        if (failure) {
          return NextResponse.json({ error: failure.error }, { status: failure.status })
        }
        logger.error('OAuth completion acknowledgement mismatch', {
          acknowledgement: completionData,
          userId,
          exchange,
        })
        return NextResponse.json({ error: 'Failed to finalize authorization' }, { status: 500 })
      }
      claimConsumed = true

      return NextResponse.json({
        success: true,
        // Preserve the legacy field while new clients require the strict ACK.
        exchangeUserId,
        data: {
          viewerId: userId,
          exchange,
          connectionId: completion.connectionId,
          exchangeUserId,
        },
      })
    } finally {
      if (!claimConsumed) {
        try {
          const { data: releaseData, error: releaseError } = await supabase.rpc(
            'finish_exchange_oauth_state_claim_atomic',
            {
              p_user_id: userId,
              p_exchange: exchange,
              p_state: state,
              p_claim_token: stateClaim.claimToken,
              p_succeeded: false,
            }
          )
          const releaseStatus =
            releaseData && typeof releaseData === 'object'
              ? (releaseData as { status?: unknown }).status
              : null
          if (releaseError || (releaseStatus !== 'released' && releaseStatus !== 'stale_claim')) {
            logger.error('Failed to release OAuth state claim', {
              error: releaseError,
              status: releaseStatus,
              userId,
              exchange,
            })
          }
        } catch (releaseError) {
          logger.error('Failed to release OAuth state claim', {
            error: releaseError,
            userId,
            exchange,
          })
        }
      }
    }
  } catch (error: unknown) {
    logger.error('Error handling OAuth callback', { error })
    const _errorMessage = error instanceof Error ? error.message : 'Failed to handle callback'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
