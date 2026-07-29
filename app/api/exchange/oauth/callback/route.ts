import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createLogger } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { fetchWithTimeout } from '@/lib/utils/error-messages'
import { env } from '@/lib/env'

const logger = createLogger('exchange-oauth-callback')

type OAuthStateClaim = {
  status?: unknown
  id?: unknown
  code_verifier?: unknown
  claim_token?: unknown
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
 * AES-256-CBC 加密
 */
function encrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

/**
 * AES-256-CBC 解密
 */
function _decrypt(encryptedText: string, key: string): string {
  const [ivHex, encrypted] = encryptedText.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
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

    if (!exchange || !code || !state) {
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
      const tokenResponse = await fetchWithTimeout(
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
        const errorText = await tokenResponse.text()
        logger.error('Token exchange failed', { errorText, exchange })
        try {
          const errorJson = JSON.parse(errorText)
          return NextResponse.json(
            {
              error: errorJson.error_description || errorJson.error || 'Failed to exchange token',
            },
            { status: 400 }
          )
        } catch {
          return NextResponse.json({ error: 'Failed to exchange token' }, { status: 400 })
        }
      }

      const tokenData = await tokenResponse.json()
      const { access_token, refresh_token, expires_in } = tokenData

      if (!access_token) {
        return NextResponse.json({ error: 'No access token received' }, { status: 400 })
      }

      // 加密存储 tokens
      const encryptedAccessToken = encrypt(access_token, encryptionKey)
      const encryptedRefreshToken = refresh_token ? encrypt(refresh_token, encryptionKey) : null

      // 计算过期时间
      const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null

      // 尝试获取用户信息
      let exchangeUserId: string | null = null
      if (config.userInfoUrl) {
        try {
          const userInfoResponse = await fetchWithTimeout(
            config.userInfoUrl,
            {
              headers: {
                Authorization: `Bearer ${access_token}`,
              },
            },
            10_000
          )
          if (userInfoResponse.ok) {
            const userInfo = await userInfoResponse.json()
            // Binance 返回格式: { code: "000000", data: { userId: "...", email: "..." } }
            if (userInfo.data?.userId) {
              exchangeUserId = userInfo.data.userId
            }
          }
        } catch (e: unknown) {
          logger.warn('Failed to fetch user info', { error: e, exchange })
        }
      }

      // 存储到数据库
      const { error: dbError } = await supabase.from('user_exchange_connections').upsert(
        {
          user_id: userId,
          exchange,
          exchange_user_id: exchangeUserId,
          access_token_encrypted: encryptedAccessToken,
          refresh_token_encrypted: encryptedRefreshToken,
          expires_at: expiresAt,
          is_active: true,
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'success',
          // 对于 OAuth 连接，不需要 API key/secret
          api_key_encrypted: 'oauth',
          api_secret_encrypted: 'oauth',
        },
        {
          onConflict: 'user_id,exchange',
        }
      )

      if (dbError) {
        logger.error('Error saving connection', { error: dbError, userId, exchange })
        return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
      }

      const { data: finishData, error: finishError } = await supabase.rpc(
        'finish_exchange_oauth_state_claim_atomic',
        {
          p_user_id: userId,
          p_exchange: exchange,
          p_state: state,
          p_claim_token: stateClaim.claimToken,
          p_succeeded: true,
        }
      )
      if (
        finishError ||
        !finishData ||
        typeof finishData !== 'object' ||
        (finishData as { status?: unknown }).status !== 'consumed'
      ) {
        logger.error('Failed to consume OAuth state claim', {
          error: finishError,
          status: (finishData as { status?: unknown } | null)?.status,
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
